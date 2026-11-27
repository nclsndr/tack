import { Cause, Effect, Stdio, Stream } from "effect";
import { argvLine } from "../envelope/command-line.ts";
import { HostEnvironment } from "./host-environment.ts";
import type { PublicEnvelope } from "../envelope/public-outcome.ts";

/** The variable that asks the host to print the cause of an internal failure to stderr. */
const debugVariable = "TACK_DEBUG";

/**
 * Names the rerun that prints the cause as the next step of an internal failure: the same `tack`
 * arguments with `TACK_DEBUG=1` before them. Any other envelope is returned unchanged, and the
 * rerun is named whether or not the variable is set, so the envelope never depends on it.
 */
export const withDebugRerun = (
  envelope: PublicEnvelope,
  args: ReadonlyArray<string>,
): PublicEnvelope =>
  envelope.classification === "internal"
    ? {
        ...envelope,
        next: [...new Set([...envelope.next, argvLine([`${debugVariable}=1`, "tack", ...args])])],
      }
    : envelope;

/**
 * Writes the full cause of an internal failure to stderr when `TACK_DEBUG=1` is set. The envelope
 * on stdout stays redacted either way; this is the text an operator puts in a bug report.
 */
export const reportInternalCause = Effect.fnUntraced(function* (cause: Cause.Cause<unknown>) {
  const environment = yield* HostEnvironment;
  if (environment[debugVariable] !== "1") return;
  const stdio = yield* Stdio.Stdio;
  yield* Stream.succeed(`${Cause.pretty(cause)}\n`).pipe(Stream.run(stdio.stderr()));
});
