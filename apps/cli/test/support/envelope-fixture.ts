import { expect } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { decodeEnvelope, type TackIsolation, type TackRun } from "./tack-process.ts";

/** One machine without state: a home, an empty repository folder and a source with one skill. */
export type CliFixture = {
  readonly destinationSentinelPath: string;
  readonly homeDirectory: string;
  readonly repositoryDirectory: string;
  readonly sourceDirectory: string;
  readonly stateDirectory: string;
  readonly worktreeDirectory: string;
};

/** The public envelope a run printed. */
export const envelope = (result: TackRun) => decodeEnvelope(result.stdout);

/** Asserts a run exited 0 with a successful format 1 envelope and nothing on stderr. */
export const expectSuccess = (result: TackRun) => {
  expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(0));
  expect(result.stderr).toBe("");
  expect(envelope(result)).toMatchObject({
    classification: "success",
    status: "success",
    version: 1,
  });
};

/** Creates a {@link CliFixture} under a scoped temporary root. */
export const withFixture = <A, E, R>(use: (fixture: CliFixture) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-test-" });
    const root = yield* fileSystem.realPath(temporaryRoot);
    const homeDirectory = path.join(root, "home");
    const repositoryDirectory = path.join(root, "repository");
    const sourceDirectory = path.join(root, "source");
    const stateDirectory = path.join(root, "state");
    const worktreeDirectory = path.join(root, "worktree");
    const destinationSentinelPath = path.join(homeDirectory, "destination-sentinel.txt");
    yield* fileSystem.makeDirectory(homeDirectory, { recursive: true });
    yield* fileSystem.makeDirectory(repositoryDirectory, { recursive: true });
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
      "---\nname: valid\ndescription: Valid skill\nmetadata:\n  tack: |\n    version: 1\n    user-activation: default\n---\n",
    );
    yield* fileSystem.writeFileString(destinationSentinelPath, "operator-owned\n");

    return yield* use({
      destinationSentinelPath,
      homeDirectory,
      repositoryDirectory,
      sourceDirectory,
      stateDirectory,
      worktreeDirectory,
    });
  });

/** The fixture's own home and state, so no run reaches the operator's. */
export const isolationOf = (fixture: CliFixture): TackIsolation => ({
  home: fixture.homeDirectory,
  state: fixture.stateDirectory,
});
