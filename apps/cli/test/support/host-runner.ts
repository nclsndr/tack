import { Effect, Exit, Ref, Runtime, Sink, Stdio, Stream } from "effect";
import { ApplicationLive } from "../../src/bootstrap/application-layer.ts";
import { runCli } from "../../src/cli/host/run.ts";
import {
  TerminalContext,
  type TerminalContextShape,
} from "../../src/cli/host/human/terminal-context.ts";
import { Git, type GitService } from "../../src/services/git.ts";
import { isolationChanges, type TackRunOptions, type TackRun } from "./tack-process.ts";

const text = (chunk: string | Uint8Array) =>
  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

/**
 * A `Stdio` that serves `args` and `stdin`, empty when left out, and collects what the CLI writes.
 * `onStdout` runs after each stdout chunk, so a test can wait for a long-running command's first
 * output.
 */
export const captureStdio = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  onStdout: Effect.Effect<void> = Effect.void,
  stdin?: string,
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
      stdin: stdin === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(stdin)),
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
  /** What the run reads from standard input; empty when left out. */
  readonly stdin?: string;
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
    const capture = yield* captureStdio(input.args, Effect.void, input.stdin);
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

/** Runs `effect` with the process working directory set to `directory`, restoring it after. */
export const inDirectory =
  (directory: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.cwd();
        process.chdir(directory);
        return previous;
      }),
      () => effect,
      (previous) => Effect.sync(() => process.chdir(previous)),
    );

/** The exit status the process entrypoint reports for `exit`, by the runtime's own rule. */
const exitCodeOf = (exit: Exit.Exit<unknown, unknown>) => {
  const codes: Array<number> = [];
  Runtime.defaultTeardown(exit, (code) => codes.push(code));
  return codes[0] ?? 0;
};

/** A run of a `tack` process that {@link runTackInProcess} can stand in for. */
export type InProcessOptions = Pick<TackRunOptions, "cwd" | "env" | "home" | "state" | "temporary">;

/**
 * Runs `tack` in the test process as `tackProcess` runs it in a child: the production service
 * graph, the same environment changes, a working directory, an 80-column pipe for stdin and
 * stdout, and the exit status the entrypoint would report. It costs no process start, so a test
 * that asserts only an envelope, an exit status and files uses it. A held lock, a killed writer,
 * a signal or the built package needs a real process.
 */
export const runTackInProcess = (
  args: ReadonlyArray<string>,
  options: InProcessOptions = {},
): Effect.Effect<TackRun> => {
  const env = isolationChanges(options, options.env);
  const run = runHost({
    args,
    env,
    // The live environment, which the run's changes above apply to, as a child process sees its own.
    terminal: {
      columns: 80,
      environment: process.env,
      stdinIsTerminal: false,
      stdoutIsTerminal: false,
    },
  }).pipe(
    Effect.map(({ exit, stdout, stderr }) => ({ exitCode: exitCodeOf(exit), stdout, stderr })),
    // Built inside the run's environment and directory: some layers read a variable when built.
    Effect.provide(ApplicationLive),
  );
  return withProcessEnv(env, options.cwd === undefined ? run : inDirectory(options.cwd)(run));
};
