import { Context, Data, type Effect, type Redacted } from "effect";

export type ShellCommand = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
};

export type ShellResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
};

const ShellFailureId = Symbol.for("@tackup/ShellFailure/1");

/** Operational Shell failures; a completed non-zero exit is ShellResult data. */
export class ShellFailure extends Data.TaggedError("ShellFailure")<{
  readonly operation: "spawn" | "io" | "termination";
  readonly message: string;
}> {
  readonly [ShellFailureId] = true;
}

export type ShellService = {
  readonly execute: (command: ShellCommand) => Effect.Effect<ShellResult, ShellFailure>;
};

export class Shell extends Context.Service<Shell, ShellService>()("@tackup/Shell") {}

export type SecretRequirement<Name extends string> = {
  readonly _tag: "TackSecret";
  readonly name: Name;
};

/** Requests one declared secret; each name has a distinct Effect requirement. */
export function Secret<const Name extends string>(name: Name) {
  return Context.Service<SecretRequirement<Name>, Redacted.Redacted>(`@tackup/Secret/${name}`);
}

/** Recognizes the capability-failure portion of a program's typed error channel. */
export function isCapabilityFailure(value: unknown): value is ShellFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    ShellFailureId in value &&
    value[ShellFailureId] === true &&
    "operation" in value &&
    (value.operation === "spawn" ||
      value.operation === "io" ||
      value.operation === "termination") &&
    "message" in value &&
    typeof value.message === "string"
  );
}
