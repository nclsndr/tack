import { Console, Context, Effect, Option, Schema } from "effect";
import { CliConfig, CliOutput, Command, GlobalFlag, type HelpDoc } from "effect/cli";
import { tackVersion } from "../../version.ts";
import { tackCommand } from "./command-tree.ts";
import { isListAlias } from "./list-alias.ts";
import { commandNameOf, InvocationError, isCommandName } from "./model.ts";
import { versionFlagHelp } from "./version-request.ts";
import { InvocationReceiver } from "./invocation-receiver.ts";
import { HelpNotesAnnotation } from "./help-notes.ts";
import { MutationModeSchema, OperationContractAnnotation } from "./operation-contract.ts";

const ResponseSlotSchema = Schema.Literals(["result", "plan", "applied"]);

/** One positional operand, in declaration order. */
const CommandArgumentSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** The value type, such as `string` or `choice`. */
  type: Schema.String,
  required: Schema.Boolean,
  variadic: Schema.Boolean,
});

/** One accepted flag, spelled `--<name>`. */
const CommandFlagSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** The value type: `boolean` flags take no value; `choice` flags list their `choices`. */
  type: Schema.String,
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
  required: Schema.Boolean,
});

const CommandExampleSchema = Schema.Struct({
  command: Schema.String,
  description: Schema.optionalKey(Schema.String),
});

/** A titled block of `term  meaning` rows, such as what each status value means. */
const HelpNoteSchema = Schema.Struct({
  title: Schema.String,
  rows: Schema.Array(Schema.Struct({ term: Schema.String, text: Schema.String })),
});

const MutationSchema = MutationModeSchema;

/** The grammar of one command path. */
const CommandGrammarFields = {
  /** The words after `tack`; empty for the root. */
  commandPath: Schema.Array(Schema.String),
  usage: Schema.String,
  description: Schema.String,
  /** Whether the path itself is an operation; a pure group only lists subcommands. */
  executable: Schema.Boolean,
  /** How the operation changes state, present when `executable`. */
  mutation: Schema.optionalKey(MutationSchema),
  arguments: Schema.Array(CommandArgumentSchema),
  flags: Schema.Array(CommandFlagSchema),
  examples: Schema.Array(CommandExampleSchema),
  /** Extra blocks the help page prints after the flags; omitted when a command has none. */
  notes: Schema.optionalKey(Schema.Array(HelpNoteSchema)),
};

/** The `help` result: the grammar of one command path and its direct subcommands. */
export const HelpPayloadSchema = Schema.Struct({
  kind: Schema.Literal("help"),
  ...CommandGrammarFields,
  subcommands: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.String, executable: Schema.Boolean }),
  ),
});

/** A help result. */
type HelpPayload = typeof HelpPayloadSchema.Type;

/**
 * The payload kind filling a response slot. Only `status`, `sync`, `doctor` and `upgrade` (with
 * `upgrade status`) carry a typed, schema-backed payload. Every other command's payload is `json`:
 * it prints JSON under `--json`, with no schema and no stability promise.
 */
const PayloadKindSchema = Schema.Literals([
  "doctor-report",
  "skill-status",
  "sync-plan",
  "sync-application",
  "init-plan",
  "init-application",
  "upgrade-guide",
  "json",
]);

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
  mutation: MutationSchema,
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

const isExecutable = (commandPath: ReadonlyArray<string>) =>
  commandPath.length > 0 && isCommandName(commandPath.join(" "));

const nodeOf = Effect.fnUntraced(function* (
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
) {
  const doc = yield* helpDocOf(commandPath);
  const executable = isExecutable(commandPath);
  const contract = Context.getOption(command.annotations, OperationContractAnnotation);
  // Coverage skip: every executable command declares a contract; this guards the tree invariant.
  /* v8 ignore next -- @preserve */
  if (executable && Option.isNone(contract))
    return yield* Effect.die(`"${commandPath.join(" ")}" has no operation contract.`);
  const slotsOf = (slots: ReadonlyArray<typeof ResponseSlotSchema.Type>) =>
    Object.fromEntries(slots.map((slot) => [slot, payloadKindOf(commandPath, slot)]));
  const responses = Option.match(contract, {
    onNone: () => [],
    onSome: ({ slots, applySlots }) => [
      { mode: "default" as const, slots: slotsOf(slots) },
      ...(applySlots === undefined ? [] : [{ mode: "apply" as const, slots: slotsOf(applySlots) }]),
    ],
  });
  return {
    grammar: {
      commandPath,
      usage: doc.usage,
      description: doc.description,
      executable,
      ...Option.match(contract, {
        onNone: () => ({}),
        onSome: ({ mutation }) => ({ mutation }),
      }),
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
                executable: isExecutable([...commandPath, subcommand.name]),
              },
            ],
      ),
    ),
    responses,
  } satisfies CommandNode;
});

/** The payload contract for one command slot; `json` promises no schema. */
const payloadKindOf = (
  commandPath: ReadonlyArray<string>,
  slot: typeof ResponseSlotSchema.Type,
): typeof PayloadKindSchema.Type => {
  const name = commandPath.join(" ");
  if (name === commandNameOf("doctor")) return "doctor-report";
  if (name === commandNameOf("status") && slot === "result") return "skill-status";
  if (name === commandNameOf("sync")) return slot === "applied" ? "sync-application" : "sync-plan";
  if (name === commandNameOf("machine-init"))
    return slot === "applied" ? "init-application" : "init-plan";
  if (name === commandNameOf("upgrade-status") || name === commandNameOf("upgrade"))
    return "upgrade-guide";
  return "json";
};

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
