import { Console, Context, Effect, Option, Schema } from "effect";
import { CliConfig, CliOutput, Command, GlobalFlag, type HelpDoc } from "effect/cli";
import { tackVersion } from "../../version.ts";
import { tackCommand } from "./command-tree.ts";
import { isListAlias } from "./list-alias.ts";
import { commandNameOf, InvocationError } from "./model.ts";
import { versionFlagHelp } from "./version-request.ts";
import { InvocationReceiver } from "./invocation-receiver.ts";
import { HelpNotesAnnotation } from "./help-notes.ts";
import { MutationModeSchema } from "./operation-contract.ts";
import {
  commandDeclarations,
  payloadSlots,
  stablePayloadKinds,
  type CommandDeclaration,
  type PayloadSlot,
} from "./declarations.ts";
import {
  CommandArgumentSchema,
  CommandFlagSchema,
  CommandGrammarFields,
  type HelpPayload,
} from "./command-payloads.ts";

/**
 * The payload kind filling a response slot. Only `status`, `sync`, `doctor` and `upgrade` (with
 * `upgrade status`) carry a typed, schema-backed payload. Every other command's payload is `json`:
 * it prints JSON under `--json`, with no schema and no stability promise.
 */
const PayloadKindSchema = Schema.Literals([...stablePayloadKinds, "json"] as const);

/** The slots one run mode fills on success or partial success, each with its payload kind. */
const ResponseVariantSchema = Schema.Struct({
  /** `default` is a run without `--apply`; `apply` is a run with it. */
  mode: Schema.Literals(["default", "apply"]),
  slots: Schema.Struct({
    result: Schema.optionalKey(PayloadKindSchema),
    plan: Schema.optionalKey(PayloadKindSchema),
    applied: Schema.optionalKey(PayloadKindSchema),
  }),
});

/** The contract of one executable command. */
export const CommandContractSchema = Schema.Struct({
  /** The envelope `command` value: the space-joined command path. */
  command: Schema.String,
  ...CommandGrammarFields,
  mutation: MutationModeSchema,
  responses: Schema.Array(ResponseVariantSchema),
});

/** The contract of one executable command. */
export type CommandContract = typeof CommandContractSchema.Type;

type CommandNode = {
  readonly grammar: Omit<HelpPayload, "kind" | "subcommands">;
  readonly subcommands: HelpPayload["subcommands"];
  readonly responses: CommandContract["responses"];
};

const silentConsole: Console.Console = Object.create(globalThis.console);
silentConsole.log = () => undefined;
// Coverage skip: the help flag answers before any handler runs, so nothing is ever received.
/* v8 ignore next -- @preserve */
const ignoredInvocations = InvocationReceiver.of({ receive: () => Effect.void });
const textFormatter = CliOutput.defaultFormatter({ colors: false });
const helpConfig = CliConfig.make({ builtIns: [GlobalFlag.Help] });
const runForHelp = Command.runWith(tackCommand, { renderErrors: false, version: tackVersion });

/** Reads the help document Effect CLI derives for a path from the same tree the parser runs. */
const helpDocOf = Effect.fnUntraced(function* (commandPath: ReadonlyArray<string>) {
  let captured: HelpDoc.HelpDoc | undefined;
  const formatter: CliOutput.Formatter = {
    formatHelpDoc: (doc) => {
      captured = doc;
      return "";
    },
    formatCliError: textFormatter.formatCliError,
    formatError: textFormatter.formatError,
    formatErrors: textFormatter.formatErrors,
    formatVersion: textFormatter.formatVersion,
  };
  yield* runForHelp([...commandPath, "--help"]).pipe(
    Effect.provideService(InvocationReceiver, ignoredInvocations),
    Effect.provideService(CliConfig.CliConfig, helpConfig),
    Effect.provideService(CliOutput.Formatter, formatter),
    Effect.provideService(Console.Console, silentConsole),
    Effect.orDie,
  );
  return captured ?? (yield* Effect.die(`No help document for "${commandPath.join(" ")}".`));
});

/** Effect CLI appends choice flag values to the description; publish them as structured data. */
const choiceSuffix = /\s*\(choices: ([^)]*)\)$/;
const flagOf = (flag: HelpDoc.FlagDoc): typeof CommandFlagSchema.Type => {
  const text = Option.getOrUndefined(flag.description);
  const choices = text?.match(choiceSuffix)?.[1]?.split(", ");
  const description = text?.replace(choiceSuffix, "");
  return {
    name: flag.name,
    ...(description === undefined || description === "" ? {} : { description }),
    type: flag.type,
    ...(choices === undefined ? {} : { choices }),
    required: flag.required,
  };
};

const argumentOf = (argument: HelpDoc.ArgDoc): typeof CommandArgumentSchema.Type => ({
  name: argument.name,
  ...Option.match(argument.description, {
    onNone: () => ({}),
    onSome: (description) => ({ description }),
  }),
  type: argument.type,
  required: argument.required,
  variadic: argument.variadic,
});

/** The declaration of the command a path selects; `clean` and `retry` share theirs. */
const declarationOf = (commandPath: ReadonlyArray<string>) =>
  Object.values(commandDeclarations).find(({ path }) => samePath(path, commandPath));

/**
 * Each declared slot with the payload kind it publishes: a stable command's schema names its kind,
 * and every other command's payload is `json`.
 */
const payloadKindsOf = (
  declaration: CommandDeclaration,
): ReadonlyArray<readonly [PayloadSlot, typeof PayloadKindSchema.Type]> =>
  declaration.stable === true
    ? payloadSlots.flatMap((slot) => {
        const schema = declaration[slot];
        return schema === undefined ? [] : [[slot, schema.fields.kind.literal] as const];
      })
    : payloadSlots.flatMap((slot) =>
        declaration[slot] === undefined ? [] : [[slot, "json"] as const],
      );

/** The slots each run mode fills: a preview leaves `applied` to its `--apply` run. */
const responsesOf = (declaration: CommandDeclaration): CommandNode["responses"] => {
  const kinds = payloadKindsOf(declaration);
  return declaration.mode === "preview-apply"
    ? [
        {
          mode: "default",
          slots: Object.fromEntries(kinds.filter(([slot]) => slot !== "applied")),
        },
        { mode: "apply", slots: Object.fromEntries(kinds) },
      ]
    : [{ mode: "default", slots: Object.fromEntries(kinds) }];
};

const nodeOf = Effect.fnUntraced(function* (
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
) {
  const doc = yield* helpDocOf(commandPath);
  const declaration = declarationOf(commandPath);
  return {
    grammar: {
      commandPath,
      usage: doc.usage,
      description: doc.description,
      executable: declaration !== undefined,
      ...(declaration === undefined ? {} : { mutation: declaration.mode }),
      arguments: (doc.args ?? []).map(argumentOf),
      // A command accepts its ancestors' flags too; Effect CLI lists them apart from its own.
      flags: [
        ...[...(doc.inheritedFlags ?? []), ...doc.flags].map(flagOf),
        ...(commandPath.length === 0 ? [versionFlagHelp] : []),
      ],
      examples: (doc.examples ?? []).map((example) => ({
        command: example.command,
        ...(example.description === undefined ? {} : { description: example.description }),
      })),
      ...Option.match(Context.getOption(command.annotations, HelpNotesAnnotation), {
        onNone: () => ({}),
        onSome: (notes) => ({ notes }),
      }),
    },
    subcommands: command.subcommands.flatMap((group) =>
      group.commands.flatMap((subcommand) =>
        isListAlias(subcommand)
          ? []
          : [
              {
                name: subcommand.name,
                description: subcommand.description ?? "",
                executable: declarationOf([...commandPath, subcommand.name]) !== undefined,
              },
            ],
      ),
    ),
    responses: declaration === undefined ? [] : responsesOf(declaration),
  } satisfies CommandNode;
});

/** Every command path in the tree, parents before their subcommands, in declaration order. */
const commandPaths = (
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): ReadonlyArray<readonly [Command.Command.Any, ReadonlyArray<string>]> => [
  [command, commandPath],
  ...command.subcommands.flatMap((group) =>
    group.commands.flatMap((subcommand) =>
      isListAlias(subcommand) ? [] : commandPaths(subcommand, [...commandPath, subcommand.name]),
    ),
  ),
];

/** Describes every command path of the installed grammar, without reading state. */
export const describeTree = Effect.fnUntraced(function* () {
  return yield* Effect.forEach(commandPaths(tackCommand, []), ([command, commandPath]) =>
    nodeOf(command, commandPath),
  );
});

/** Whether a command path begins with every word of a prefix. */
export const startsWith = (path: ReadonlyArray<string>, prefix: ReadonlyArray<string>) =>
  prefix.every((word, index) => path[index] === word);

/** Whether two command paths name the same command. */
export const samePath = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && startsWith(left, right);

/** The `help` refusal for a command path the grammar does not have. */
export const unknownPath = (commandPath: ReadonlyArray<string>) =>
  new InvocationError({
    code: "invalid-command",
    command: commandNameOf("help"),
    message: `Unknown command path: ${commandPath.join(" ")}.`,
  });

/** Describes one command path: its grammar and its direct subcommands. */
export const describeHelp = Effect.fnUntraced(function* (commandPath: ReadonlyArray<string>) {
  const node = (yield* describeTree()).find(({ grammar }) =>
    samePath(grammar.commandPath, commandPath),
  );
  if (node === undefined) return yield* unknownPath(commandPath);
  return { kind: "help", ...node.grammar, subcommands: node.subcommands } satisfies HelpPayload;
});
