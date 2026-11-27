import { Context, Layer } from "effect";

export type OutputFormat = "human" | "json";
export type TerminalContextShape = {
  readonly columns: number;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly stdinIsTerminal: boolean;
  readonly stdoutIsTerminal: boolean;
};

/** An absent live layer safely describes a non-terminal process. */
export const TerminalContext = Context.Reference<TerminalContextShape>(
  "tack/cli/cli/human/terminal-context/TerminalContext",
  {
    defaultValue: () => ({
      columns: 80,
      environment: {},
      stdinIsTerminal: false,
      stdoutIsTerminal: false,
    }),
  },
);

/** Captures process terminal facts for the CLI host. */
export const TerminalContextLive = Layer.sync(TerminalContext, () => ({
  columns: process.stdout.columns ?? 80,
  environment: process.env,
  stdinIsTerminal: process.stdin.isTTY === true,
  stdoutIsTerminal: process.stdout.isTTY === true,
}));

/** Agent markers that disallow interactive browser and explorer behavior. */
export const agentMarkers = [
  "AI_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CODEX_CI",
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
  "GEMINI_CLI",
  "OPENCODE",
  "OPENCODE_CLIENT",
] as const;

const isSet = (value: string | undefined) => value !== undefined && value.trim() !== "";

/** Returns the first nonblank agent marker, if one is present. */
const agentMarkerOf = (environment: TerminalContextShape["environment"]): string | undefined =>
  agentMarkers.find((name) => isSet(environment[name]));

/** The explorer requires every terminal fact, regardless of the requested output format. */
export const interactiveAllowed = (context: TerminalContextShape): boolean =>
  context.stdinIsTerminal &&
  context.stdoutIsTerminal &&
  isSet(context.environment["TERM"]) &&
  context.environment["TERM"]?.toLowerCase() !== "dumb" &&
  !isSet(context.environment["CI"]) &&
  agentMarkerOf(context.environment) === undefined;

export type OutputFormatDecision = {
  readonly format: OutputFormat;
  readonly reason: "flag" | "default";
};

/** Human output is the default; only the explicit flag selects JSON. */
export const resolveOutputFormat = (jsonRequested: boolean): OutputFormatDecision =>
  jsonRequested ? { format: "json", reason: "flag" } : { format: "human", reason: "default" };

/** Enables color only on a terminal or by request, unless NO_COLOR wins. */
export const colorEnabled = (context: TerminalContextShape): boolean => {
  if (isSet(context.environment["NO_COLOR"])) return false;
  const force = context.environment["FORCE_COLOR"];
  if (isSet(force)) return force !== "0";
  return context.stdoutIsTerminal && context.environment["TERM"] !== "dumb";
};

/** Detects the raw JSON flag before `--`, including on invalid invocations. */
export const jsonRequestInArguments = (arguments_: ReadonlyArray<string>): boolean => {
  const terminator = arguments_.indexOf("--");
  const end = terminator === -1 ? arguments_.length : terminator;
  return arguments_.slice(0, end).includes("--json");
};
