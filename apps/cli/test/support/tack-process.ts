import { BunServices } from "@effect/platform-bun";
import { expect } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentMarkers } from "../../src/cli/human/terminal-context.ts";
import {
  PublicEnvelopeSchema,
  type PublicEnvelope,
} from "../../src/cli/envelope/public-outcome.ts";

/** The root of the Tack repository. */
export const repositoryRoot = resolve(import.meta.dirname, "../../../..");

const { packageManager } = Schema.decodeUnknownSync(
  Schema.Struct({ packageManager: Schema.String }),
)(JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")));

/**
 * Why a test that builds a release cannot run on this Bun, or `undefined` on the pinned one. The
 * release build refuses any Bun but the `packageManager` pin, and CI runs the pin.
 */
export const unpinnedBunReason =
  packageManager === `bun@${Bun.version}`
    ? undefined
    : `The release build needs ${packageManager}; this is bun@${Bun.version}.`;

/** The CLI's source entrypoint, run by Bun. */
export const sourceEntrypoint = join(repositoryRoot, "apps", "cli", "src", "main.ts");

/** The bundled CLI that the global test setup builds once. */
export const builtEntrypoint = join(repositoryRoot, "apps", "cli", "dist", "main.js");

/**
 * Where one Tack process keeps its home and state. The inherited `HOME`, `TACK_STATE_DIR`, every
 * `XDG_*` variable, `CI` and every agent marker are dropped first, so a run never reads or writes
 * the operator's real home or state, nor behaves differently under CI or a coding agent.
 */
export type TackIsolation = {
  /** `HOME`; left out, the process runs without one. */
  readonly home?: string | undefined;
  /** `TACK_STATE_DIR`; left out, the CLI falls back to the default under `HOME`. */
  readonly state?: string | undefined;
  /** `TMPDIR`; left out, the inherited one is kept. */
  readonly temporary?: string | undefined;
};

/** Extra settings for one Tack process run. */
export type TackRunOptions = TackIsolation & {
  /** The working directory; the test process's own when left out. */
  readonly cwd?: string;
  /** Variables set after isolation; `undefined` removes one. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The program Bun runs; the source entrypoint when left out. */
  readonly entrypoint?: string;
  /** A compiled Tack executable to run directly, in place of Bun and an entrypoint. */
  readonly binary?: string;
  /** Text written to stdin; stdin is closed and empty when left out. */
  readonly stdin?: string;
  /** Kill the process after this long, in milliseconds. */
  readonly timeoutMillis?: number;
};

/** What one Tack process printed and how it exited. */
export type TackRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const isolated = (name: string) =>
  name === "HOME" ||
  name === "TACK_STATE_DIR" ||
  name === "CI" ||
  name.startsWith("XDG_") ||
  agentMarkers.some((marker) => marker === name);

const defined = (
  entries: ReadonlyArray<readonly [string, string | undefined]>,
): Record<string, string> =>
  Object.fromEntries(
    entries.flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const])),
  );

/**
 * What one isolated Tack run changes in the test process's environment: every variable
 * {@link TackIsolation} drops is removed (`undefined`), then the isolation's directories and the
 * extra variables are set. A process run and an in-process run apply the same changes.
 */
export const isolationChanges = (
  isolation: TackIsolation,
  env: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> => ({
  ...Object.fromEntries(
    Object.keys(process.env).flatMap((name) => (isolated(name) ? [[name, undefined]] : [])),
  ),
  HOME: isolation.home,
  TACK_STATE_DIR: isolation.state,
  ...(isolation.temporary === undefined ? {} : { TMPDIR: isolation.temporary }),
  ...env,
});

/**
 * The environment of one isolated Tack process: the test process's own, minus what
 * {@link TackIsolation} drops, plus the isolation's directories and the extra variables.
 */
export const tackEnvironment = (
  isolation: TackIsolation,
  env: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> =>
  defined(Object.entries({ ...process.env, ...isolationChanges(isolation, env) }));

const command = (args: ReadonlyArray<string>, options: TackRunOptions) =>
  options.binary === undefined
    ? [process.execPath, options.entrypoint ?? sourceEntrypoint, ...args]
    : [options.binary, ...args];

/** Runs one isolated Tack process to completion and collects its output. */
export const runTack = async (
  args: ReadonlyArray<string>,
  options: TackRunOptions = {},
): Promise<TackRun> => {
  const child = Bun.spawn(command(args, options), {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: tackEnvironment(options, options.env),
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer =
    options.timeoutMillis === undefined
      ? undefined
      : setTimeout(() => child.kill("SIGKILL"), options.timeoutMillis);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return { exitCode, stdout, stderr };
};

/** A synchronous {@link TackRun}, with the reason the process could not run, if there is one. */
export type TackSyncRun = TackRun & {
  /** Why the process failed to start or was killed by its timeout; undefined when it ran. */
  readonly error: Error | undefined;
};

/** {@link runTack} for synchronous tests; it blocks the test process until Tack exits. */
export const runTackSync = (
  args: ReadonlyArray<string>,
  options: TackRunOptions = {},
): TackSyncRun => {
  const [executable = process.execPath, ...rest] = command(args, options);
  const result = spawnSync(executable, rest, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: tackEnvironment(options, options.env),
    encoding: "utf8",
    ...(options.stdin === undefined
      ? { stdio: ["ignore", "pipe", "pipe"] }
      : { input: options.stdin }),
    ...(options.timeoutMillis === undefined
      ? {}
      : { timeout: options.timeoutMillis, killSignal: "SIGKILL" }),
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
};

/** {@link runTack} as an Effect, for tests written with `it.effect`. */
export const tackProcess = (args: ReadonlyArray<string>, options: TackRunOptions = {}) =>
  Effect.promise(() => runTack(args, options));

/** What one external process printed and how it exited. */
export type ProcessResult = {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stderr: string;
  readonly stdout: string;
};

/** Runs one external command through Effect's child-process capability. */
export const runProcess = Effect.fnUntraced(function* (
  executable: string,
  arguments_: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
) {
  const process = yield* ChildProcess.make(executable, arguments_, {
    cwd: options.cwd,
    ...(options.environment === undefined ? {} : { env: options.environment }),
    extendEnv: true,
  });
  return yield* Effect.all(
    {
      exitCode: process.exitCode,
      stderr: process.stderr.pipe(Stream.decodeText, Stream.mkString),
      stdout: process.stdout.pipe(Stream.decodeText, Stream.mkString),
    },
    { concurrency: "unbounded" },
  );
});

/** Asserts that an external process exited 0, showing its stderr when it did not. */
export const expectProcessSuccess = (result: {
  readonly exitCode: number;
  readonly stderr?: string;
}) => {
  expect(result.exitCode, result.stderr).toBe(ChildProcessSpawner.ExitCode(0));
};

/**
 * Git without the machine's configuration and with a fixed identity: a system git-lfs filter, a
 * default branch or a signing rule of the operator must not touch a fixture repository.
 */
const gitEnvironment = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

/** Runs Git against an isolated fixture and requires a zero exit status. */
export const runGit = Effect.fnUntraced(function* (cwd: string, arguments_: ReadonlyArray<string>) {
  const result = yield* runProcess("git", arguments_, { cwd, environment: gitEnvironment });
  expectProcessSuccess(result);
  return result;
});

/** {@link runGit} for promise-based tests: it requires success and resolves to Git's stdout. */
export const git = (cwd: string, args: ReadonlyArray<string>): Promise<string> =>
  Effect.runPromise(
    runGit(cwd, args).pipe(
      Effect.map((result) => result.stdout),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    ),
  );

const decodePublicEnvelope = Schema.decodeUnknownSync(PublicEnvelopeSchema);

/** Decodes printed text as the one public JSON envelope it must be. */
export const decodeEnvelope = (text: string): PublicEnvelope =>
  decodePublicEnvelope(JSON.parse(text));
