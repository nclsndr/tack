import { Console, Effect, Ref } from "effect";
import { CliConfig, CliError, Command } from "effect/cli";
import { tackCommand } from "./command-tree.ts";
import {
  commandNameOf,
  commandNameOfPath,
  commandPathOf,
  InvocationError,
  type ParsedInvocation,
  unknownCommandName,
} from "./model.ts";
import { InvocationReceiver } from "./invocation-receiver.ts";
import { readVersionRequest } from "./version-request.ts";
import { tackVersion } from "../../version.ts";

export {
  commandNameOf,
  commandPathOf,
  commandTagOf,
  InvocationError,
  isCommandName,
  type Invocation,
  unknownCommandName,
} from "./model.ts";
export { commandDeclarations } from "./declarations.ts";
export { describeHelp } from "./manifest.ts";
export { HelpPayloadSchema } from "./command-payloads.ts";

const parserConsole: Console.Console = Object.create(globalThis.console);
parserConsole.log = () => undefined;

const cliConfig = CliConfig.make({ builtIns: [] });
const runTackCommand = Command.runWith(tackCommand, {
  renderErrors: false,
  version: tackVersion,
});

const unsupportedCommandMessage = "The command is not supported by this CLI.";

/** Effect CLI paths start at the root command itself; Tack paths are the words after `tack`. */
const tackPathOf = (error: CliError.ShowHelp) => error.commandPath.slice(1);

/** Asks for help on one command path. */
const helpFor = (commandPath: ReadonlyArray<string>): ParsedInvocation => ({
  invocation: { _tag: "help", commandPath },
});

const invocationErrorFromCli = (error: CliError.CliError): InvocationError => {
  // Coverage skip: this grammar raises only ShowHelp errors, and callers pass only those with causes.
  /* v8 ignore start -- @preserve */
  const command =
    error._tag === "ShowHelp" ? commandNameOfPath(tackPathOf(error)) : unknownCommandName;
  const cause = error._tag === "ShowHelp" ? error.errors[0] : error;
  if (cause === undefined) {
    return new InvocationError({
      code: "invalid-command",
      command,
      message: unsupportedCommandMessage,
    });
  }
  /* v8 ignore stop -- @preserve */
  if (cause._tag === "UnknownSubcommand") {
    return new InvocationError({ code: "invalid-command", command, message: cause.message });
  }
  if (cause._tag === "MissingArgument" || cause._tag === "MissingOption") {
    return new InvocationError({ code: "missing-argument", command, message: cause.message });
  }
  if (cause._tag === "InvalidValue" && cause.value.length === 0) {
    return new InvocationError({ code: "missing-argument", command, message: cause.message });
  }
  if (cause._tag === "InvalidValue" && cause.option === "project") {
    const listProjects = ["tack", ...commandPathOf("project-list")];
    return new InvocationError({
      code: "invalid-selector",
      command,
      // The schema's own text is a pattern; name what the flag takes and where the names are listed.
      message: `Invalid value for flag --project: ${JSON.stringify(cause.value)}. --project takes the name of a registered project, not a path. Run \`${listProjects.join(" ")}\` to list the registered names.`,
      next: [listProjects],
    });
  }
  return new InvocationError({ code: "invalid-flag", command, message: cause.message });
};

// Effect CLI tokenizes negative numeric operands as short flags. Keep timeout values
// intact so execution can record and classify an invalid duration after pending history.
const preserveTimeoutValues = (arguments_: ReadonlyArray<string>): ReadonlyArray<string> => {
  const normalized: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const current = arguments_[index];
    const next = arguments_[index + 1];
    if (current === "--timeout" && next !== undefined && /^-(?:\d|\.\d|Infinity)/.test(next)) {
      normalized.push(`--timeout=${next}`);
      index += 1;
    } else if (current !== undefined) normalized.push(current);
  }
  return normalized;
};

const helpRequestFlags: ReadonlySet<string> = new Set(["--help", "-h"]);

/**
 * Removes `--help` and `-h` before the `--` operand terminator. Returns `undefined` when the
 * arguments request no help.
 */
const withoutHelpRequest = (
  arguments_: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined => {
  const terminator = arguments_.indexOf("--");
  const end = terminator === -1 ? arguments_.length : terminator;
  const options = arguments_.slice(0, end);
  const kept = options.filter((argument) => !helpRequestFlags.has(argument));
  return kept.length === options.length ? undefined : [...kept, ...arguments_.slice(end)];
};

/** Runs the grammar, leaving Effect CLI failures unmapped so callers can read their path. */
const runParser = Effect.fnUntraced(function* (arguments_: ReadonlyArray<string>) {
  const parsed = yield* Ref.make<ParsedInvocation | undefined>(undefined);
  yield* runTackCommand(preserveTimeoutValues(arguments_)).pipe(
    Effect.provideService(
      InvocationReceiver,
      InvocationReceiver.of({ receive: (received) => Ref.set(parsed, received) }),
    ),
    Effect.provideService(CliConfig.CliConfig, cliConfig),
    Effect.provideService(Console.Console, parserConsole),
  );
  const received = yield* Ref.get(parsed);
  // Coverage skip: every command that parses has a handler that receives its invocation.
  /* v8 ignore next -- @preserve */
  return received === undefined
    ? yield* new InvocationError({
        code: "invalid-command",
        command: unknownCommandName,
        message: unsupportedCommandMessage,
      })
    : received;
});

/**
 * Parses arguments without a help request. A bare root or command group, which has no operation
 * of its own, asks for its help instead of failing.
 */
const parseOperation = (arguments_: ReadonlyArray<string>) =>
  runParser(arguments_).pipe(
    Effect.flatMap((parsed) => {
      // The grammar collects every extra word as a script argument; only words after `--` are.
      const words =
        parsed.invocation._tag === "script-run" ? (parsed.invocation.request.words ?? []) : [];
      const terminator = arguments_.indexOf("--");
      const stray = words.slice(
        0,
        words.length - (terminator === -1 ? 0 : arguments_.length - terminator - 1),
      );
      return stray.length === 0
        ? Effect.succeed(parsed)
        : Effect.fail(
            new InvocationError({
              code: "invalid-flag",
              command: commandNameOf("script-run"),
              message: `Unexpected argument "${stray[0]}". Put the script's own arguments after --, such as: tack script run report -- --name Ada.`,
            }),
          );
    }),
    Effect.catch((error) => {
      if (!CliError.isCliError(error)) return Effect.fail(error);
      if (error._tag === "ShowHelp" && error.errors.length === 0)
        return Effect.succeed(helpFor(tackPathOf(error)));
      return Effect.fail(invocationErrorFromCli(error));
    }),
  );

/**
 * Resolves the command path named by arguments whose help flag was removed: the operation they
 * select, or the deepest command the parser reached before a missing or invalid operand. An
 * unknown subcommand fails, so an unknown path never falls back to its parent's help.
 */
const parseHelpRequest = (arguments_: ReadonlyArray<string>) =>
  runParser(arguments_).pipe(
    Effect.map(({ invocation }) => helpFor(commandPathOf(invocation._tag))),
    Effect.catch((error) => {
      if (!CliError.isCliError(error))
        return error.command === unknownCommandName
          ? Effect.fail(
              new InvocationError({
                code: error.code,
                command: commandNameOf("help"),
                message: error.message,
              }),
            )
          : Effect.succeed(helpFor(error.command.split(" ")));
      // Coverage skip: this grammar raises only ShowHelp errors from Effect CLI.
      /* v8 ignore next -- @preserve */
      if (error._tag !== "ShowHelp") return Effect.fail(invocationErrorFromCli(error));
      const unknownSubcommand = error.errors.find((cause) => cause._tag === "UnknownSubcommand");
      return unknownSubcommand === undefined
        ? Effect.succeed(helpFor(tackPathOf(error)))
        : Effect.fail(
            new InvocationError({
              code: "invalid-command",
              command: commandNameOf("help"),
              message: unknownSubcommand.message,
            }),
          );
    }),
  );

/**
 * Parses the declared Tack command grammar into one invocation and its root transport settings.
 * `--help` anywhere before `--` turns the selected command path into a help request, and a lone
 * `--version` is the version request.
 */
export const parseInvocation = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<ParsedInvocation, InvocationError, Command.Environment> => {
  const terminator = arguments_.indexOf("--");
  const flags = arguments_.slice(0, terminator === -1 ? arguments_.length : terminator);
  if (flags.some((argument) => argument === "--format" || argument.startsWith("--format=")))
    return Effect.fail(
      new InvocationError({
        code: "invalid-flag",
        command: unknownCommandName,
        message:
          "--format has been removed. Pass --json for machine output or omit it for human output.",
      }),
    );
  const versionRequest = readVersionRequest(arguments_);
  if (versionRequest !== undefined)
    return "message" in versionRequest
      ? Effect.fail(
          new InvocationError({
            code: "invalid-flag",
            command: commandNameOf("version"),
            message: versionRequest.message,
          }),
        )
      : Effect.succeed(
          versionRequest.help ? helpFor([]) : { invocation: { _tag: "version" as const } },
        );
  const helpArguments = withoutHelpRequest(arguments_);
  return helpArguments === undefined ? parseOperation(arguments_) : parseHelpRequest(helpArguments);
};
