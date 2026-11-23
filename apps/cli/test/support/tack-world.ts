import { afterAll, expect } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { rm } from "node:fs/promises";
import type { PublicEnvelope } from "../../src/cli/host/public-outcome.ts";
import type { StateOptions } from "../../src/services/state-store.ts";
import { runTackInProcess } from "./host-runner.ts";
import {
  decodeEnvelope,
  expectProcessSuccess,
  repositoryRoot,
  runGit,
  sourceEntrypoint,
  tackProcess,
  type ProcessResult,
} from "./tack-process.ts";

export type TackWorld = {
  readonly entrypoint: string;
  readonly homeDirectory: string;
  readonly options: StateOptions;
  readonly primaryRoot: string;
  readonly repositoryRoot: string;
  readonly sourceDirectory: string;
  readonly stateDirectory: string;
  readonly worktreeRoot: string;
};

/** Runs Tack's source entrypoint with `--json` against the isolated fixture state and home. */
export const runTack = (
  fixture: TackWorld,
  arguments_: ReadonlyArray<string>,
  cwd: string = fixture.primaryRoot,
) =>
  tackProcess(["--json", ...arguments_], {
    cwd,
    entrypoint: fixture.entrypoint,
    home: fixture.homeDirectory,
    state: fixture.stateDirectory,
  }).pipe(
    Effect.map((run): ProcessResult => ({
      ...run,
      exitCode: ChildProcessSpawner.ExitCode(run.exitCode),
    })),
  );

/**
 * {@link runTack} in the test process: the same arguments, home, state and working directory, and
 * the same result. A test that asserts only an envelope, an exit status and files uses it.
 */
export const hostTack = (
  fixture: TackWorld,
  arguments_: ReadonlyArray<string>,
  cwd: string = fixture.primaryRoot,
) =>
  runTackInProcess(["--json", ...arguments_], {
    cwd,
    home: fixture.homeDirectory,
    state: fixture.stateDirectory,
  }).pipe(
    Effect.map((run): ProcessResult => ({
      ...run,
      exitCode: ChildProcessSpawner.ExitCode(run.exitCode),
    })),
  );

/** Decodes and verifies a successful public CLI envelope. */
export const successfulEnvelope = (result: ProcessResult): PublicEnvelope => {
  expectProcessSuccess(result);
  expect(result.stderr).toBe("");
  const envelope = decodeEnvelope(result.stdout);
  expect(envelope).toMatchObject({ classification: "success", status: "success", version: 1 });
  return envelope;
};

/** Decodes and verifies a completed partial public CLI envelope. */
export const partialEnvelope = (result: ProcessResult): PublicEnvelope => {
  expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
  expect(result.stderr).toBe("");
  const envelope = decodeEnvelope(result.stdout);
  expect(envelope).toMatchObject({ classification: "partial", status: "partial", version: 1 });
  return envelope;
};

/**
 * The Git half of a world, made once per test file: a bare `remote.git` and its clone `primary`,
 * with one commit pushed. Each world copies it, so a world starts no Git process.
 */
const gitTemplate = {
  root: undefined as string | undefined,
};

afterAll(async () => {
  if (gitTemplate.root !== undefined) await rm(gitTemplate.root, { recursive: true, force: true });
});

const makeGitTemplate = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectory({ prefix: "tack-world-git-" }),
  );
  const bareRepository = path.join(root, "remote.git");
  const primaryRoot = path.join(root, "primary");
  yield* runGit(root, ["init", "--bare", bareRepository]);
  yield* runGit(root, ["clone", bareRepository, primaryRoot]);
  yield* runGit(primaryRoot, ["config", "user.name", "Tack Tests"]);
  yield* runGit(primaryRoot, ["config", "user.email", "tack-tests@example.com"]);
  yield* fileSystem.writeFileString(path.join(primaryRoot, "README.md"), "fixture\n");
  yield* runGit(primaryRoot, ["add", "README.md"]);
  yield* runGit(primaryRoot, ["commit", "-m", "Initial fixture"]);
  yield* runGit(primaryRoot, ["push", "origin", "HEAD"]);
  gitTemplate.root = root;
  return root;
});

/** Copies the Git template into `root`, pointing the clone's `origin` at the copied remote. */
const copyGitTemplate = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const template = gitTemplate.root ?? (yield* makeGitTemplate());
  for (const name of ["remote.git", "primary"])
    yield* fileSystem.copy(path.join(template, name), path.join(root, name), {
      preserveTimestamps: true,
    });
  const config = path.join(root, "primary", ".git", "config");
  const text = yield* fileSystem.readFileString(config);
  yield* fileSystem.writeFileString(
    config,
    text.replaceAll(path.join(template, "remote.git"), path.join(root, "remote.git")),
  );
});

/**
 * Creates one isolated real-Git repository and initialized Tack project fixture. The repository
 * is a copy of a template and the Tack setup runs in process, so no child process starts.
 */
export const withTackWorld = <A, E, R>(use: (fixture: TackWorld) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entrypoint = sourceEntrypoint;
    const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "tack-world-",
    });
    const root = yield* fileSystem.realPath(temporaryRoot);
    const homeDirectory = path.join(root, "home");
    const primaryRoot = path.join(root, "primary");
    const sourceDirectory = path.join(root, "source");
    const stateDirectory = path.join(root, "state");
    const worktreeRoot = path.join(root, "worktree");
    yield* fileSystem.makeDirectory(homeDirectory, { recursive: true });
    yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(sourceDirectory, "tack.yaml"),
      "version: 1\nname: source\nskills:\n  - path: skills\n",
    );
    yield* fileSystem.makeDirectory(path.join(sourceDirectory, "skills", "valid"), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(
      path.join(sourceDirectory, "skills", "valid", "SKILL.md"),
      "---\nname: valid\ndescription: Valid skill\n---\n",
    );

    yield* copyGitTemplate(root);

    const options = {
      environment: { TACK_STATE_DIR: stateDirectory },
      homeDirectory,
    } satisfies StateOptions;
    const fixture = {
      entrypoint,
      homeDirectory,
      options,
      primaryRoot: yield* fileSystem.realPath(primaryRoot),
      repositoryRoot,
      sourceDirectory,
      stateDirectory,
      worktreeRoot,
    } satisfies TackWorld;
    successfulEnvelope(yield* hostTack(fixture, ["state", "init"]));
    successfulEnvelope(yield* hostTack(fixture, ["source", "add", sourceDirectory, "--apply"]));
    successfulEnvelope(
      yield* hostTack(fixture, [
        "project",
        "add",
        "workspace",
        "--repository-cwd",
        fixture.primaryRoot,
      ]),
    );
    successfulEnvelope(
      yield* hostTack(fixture, ["pick", "include", "valid", "--project", "workspace"]),
    );
    return yield* use(fixture);
  });
