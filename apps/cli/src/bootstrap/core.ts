/**
 * Tack's command line without a platform: the real parser, route table, host and renderers, the
 * service tags every route reads, and the layers that only need Effect's own platform services.
 * A host supplies the rest, as `application-layer.ts` does with Node and the website does with an
 * in-memory machine. This module is a workspace export; the published package never ships it.
 */
import { Cause, Effect, Exit, Layer, Option, Sink, Stdio, Stream } from "effect";
import { completePath, completeTack } from "../cli/host/completion.ts";
import { runCli } from "../cli/host/run.ts";

export type { CompletionCandidate } from "../cli/host/completion.ts";
export { HostEnvironment } from "../cli/host/host-environment.ts";
export { agentAdapterDescriptors } from "../domain/agents/agent-adapter.ts";
export { PortableLive } from "./portable-layer.ts";
export { TerminalContext } from "../cli/host/human/terminal-context.ts";
export { makeSourceService, Source } from "../features/sources/source.ts";
export { BundleScanner } from "../services/bundle-scanner.ts";
export { Compression } from "../services/compression.ts";
export { Destination } from "../services/destination.ts";
export { LockProcess } from "../services/exclusive-lock.ts";
export { executionError, ExecutionPlatform } from "../services/execution-platform.ts";
export { Git, GitCommandError, type GitService } from "../services/git.ts";
export { defaultImportLimits, ImportFetchError, ImportRemote } from "../services/import-remote.ts";
export { Installation } from "../services/installation.ts";
export { Reader, ReaderStartupError } from "../services/reader.ts";
export { FigureCheckError, ReaderCorpus, ReaderSearchError } from "../services/reader-corpus.ts";

type Cli = ReturnType<typeof runCli>;

/** Every service one invocation reads, except standard input and output, which `runCliWith` makes. */
export type HostServices = Exclude<Effect.Services<Cli>, Stdio.Stdio>;

const decoder = new TextDecoder();

/**
 * Runs one invocation of the real command host over `services`, sends everything it prints to
 * `write`, standard error included, and resolves to its exit code.
 */
export const runCliWith = (options: {
  readonly args: ReadonlyArray<string>;
  readonly services: Layer.Layer<HostServices>;
  readonly write: (text: string) => void;
}): Promise<number> => {
  const transcript = () =>
    Sink.forEach((chunk: string | Uint8Array) =>
      Effect.sync(() => {
        // Coverage skip: the host writes strings; bytes are decoded for completeness only.
        /* v8 ignore next -- @preserve */
        options.write(typeof chunk === "string" ? chunk : decoder.decode(chunk));
      }),
    );
  const stdio = Stdio.make({
    args: Effect.succeed(options.args),
    stdin: Stream.empty,
    stdout: transcript,
    stderr: transcript,
  });
  const program = runCli().pipe(
    // Coverage skip: writing to the transcript cannot fail, so this platform failure is a defect.
    /* v8 ignore next -- @preserve */
    Effect.catchTag("PlatformError", (error) => Effect.die(error)),
    Effect.provideService(Stdio.Stdio, stdio),
    Effect.provide(options.services),
    Effect.exit,
  );
  return Effect.runPromise(program).then((exit) => {
    if (Exit.isSuccess(exit)) return 0;
    // `PublicExit` is the host's only failure; it carries the exit code of a failed command.
    return Option.match(Cause.findErrorOption(exit.cause), {
      onSome: (failure) => failure.exitCode,
      // Coverage skip: the host turns every failure into an envelope and a `PublicExit`, so only
      // a defect in the host itself, which no test can provoke, ends without one.
      /* v8 ignore next -- @preserve */
      onNone: () => {
        options.write(`${Cause.pretty(exit.cause)}\n`);
        return 1;
      },
    });
  });
};

/**
 * What Tab offers for the word being typed (`partial`) after `words`, all after `tack`, read from
 * the CLI's own command tree and from the state and files `services` provide. It never fails: what
 * it cannot read offers nothing.
 */
export const completeWith = (options: {
  readonly words: ReadonlyArray<string>;
  readonly partial: string;
  readonly services: Layer.Layer<HostServices>;
}) =>
  Effect.runPromise(
    completeTack(options.words, options.partial).pipe(
      // Completion reads the command tree the parser describes, which prints nothing.
      Effect.provideService(
        Stdio.Stdio,
        Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.empty,
          // Coverage skip: the help pass writes through its own formatter, never to these sinks.
          /* v8 ignore next 2 -- @preserve */
          stdout: () => Sink.drain,
          stderr: () => Sink.drain,
        }),
      ),
      Effect.provide(options.services),
    ),
  );

/**
 * The folders, and with `files` the files, a path being typed (`partial`) can continue with, by the
 * rule Tack's own completion uses for path operands; a folder that cannot be read offers nothing.
 */
export const completePathWith = (options: {
  readonly partial: string;
  readonly files: boolean;
  readonly services: Layer.Layer<HostServices>;
}) =>
  Effect.runPromise(
    completePath(options.partial, options.files).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.provide(options.services),
    ),
  );
