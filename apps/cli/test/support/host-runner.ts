import { Effect, Exit, Ref, Sink, Stdio, Stream } from "effect";
import { runCli } from "../../src/cli/host/run.ts";
import {
  TerminalContext,
  type TerminalContextShape,
} from "../../src/cli/host/human/terminal-context.ts";
import { Git, type GitService } from "../../src/services/git.ts";

const text = (chunk: string | Uint8Array) =>
  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

/**
 * A `Stdio` that serves `args` and an empty stdin and collects what the CLI writes. `onStdout`
 * runs after each stdout chunk, so a test can wait for a long-running command's first output.
 */
export const captureStdio = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  onStdout: Effect.Effect<void> = Effect.void,
) {
  const stdout = yield* Ref.make("");
  const stderr = yield* Ref.make("");
  const collect = (target: Ref.Ref<string>, after: Effect.Effect<void>) =>
    Sink.forEach((chunk: string | Uint8Array) =>
      Ref.update(target, (output) => output + text(chunk)).pipe(Effect.andThen(after)),
    );
  return {
    stdio: Stdio.make({
      args: Effect.succeed(args),
      stdin: Stream.empty,
      stderr: () => collect(stderr, Effect.void),
      stdout: () => collect(stdout, onStdout),
    }),
    stdout: Ref.get(stdout),
    stderr: Ref.get(stderr),
  };
});

/** One in-process CLI invocation. */
export type HostInput = {
  readonly args: ReadonlyArray<string>;
  /** Replaces Git discovery; the surrounding layer's Git when left out. */
  readonly git?: GitService;
  /** Replaces the terminal facts; the surrounding layer's when left out. */
  readonly terminal?: TerminalContextShape;
  /**
   * Process variables set for the run and restored after it; `undefined` removes one. `HOME` and
   * `TACK_STATE_DIR` are removed unless named here, so a run never reads or writes the operator's
   * real home or state: a command that reaches the user scope or the default state without a
   * throwaway `HOME` fails with `home-directory-unavailable`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/** What every run removes from the process environment unless its `env` sets it. */
const isolatedEnvironment = { HOME: undefined, TACK_STATE_DIR: undefined };

type Cli = ReturnType<typeof runCli>;

/** The services an invocation needs besides the stdio it is given. */
type CliServices = Exclude<Effect.Services<Cli>, Stdio.Stdio>;

/** How one in-process invocation exited and what it printed. */
export type HostRun = {
  readonly exit: Exit.Exit<Effect.Success<Cli>, Effect.Error<Cli>>;
  readonly stdout: string;
  readonly stderr: string;
};

const assign = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

/** Runs `effect` with `env` written into `process.env`, restoring the previous values after it. */
const withProcessEnv = <A, E, R>(
  env: Readonly<Record<string, string | undefined>>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.keys(env).map((name) => [name, process.env[name]] as const);
      for (const [name, value] of Object.entries(env)) assign(name, value);
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [name, value] of previous) assign(name, value);
      }),
  );

/**
 * Runs the real CLI host in-process with captured stdio and returns how it exited and what it
 * printed. Other services come from the caller, which can also wrap the returned effect.
 */
export function runHost(
  input: HostInput & { readonly git: GitService },
): Effect.Effect<HostRun, never, Exclude<CliServices, Git>>;
export function runHost(input: HostInput): Effect.Effect<HostRun, never, CliServices>;
export function runHost(input: HostInput): Effect.Effect<HostRun, never, CliServices> {
  return Effect.gen(function* () {
    const capture = yield* captureStdio(input.args);
    const program = runCli().pipe(Effect.provideService(Stdio.Stdio, capture.stdio));
    const withGit =
      input.git === undefined ? program : program.pipe(Effect.provideService(Git, input.git));
    const withTerminal =
      input.terminal === undefined
        ? withGit
        : withGit.pipe(Effect.provideService(TerminalContext, input.terminal));
    const exit = yield* Effect.exit(
      withProcessEnv({ ...isolatedEnvironment, ...input.env }, withTerminal),
    );
    return { exit, stdout: yield* capture.stdout, stderr: yield* capture.stderr };
  });
}
