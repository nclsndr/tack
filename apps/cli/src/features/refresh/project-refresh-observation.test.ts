import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { fakeGit } from "../../../test/support/fake-git.ts";
import { faultyFileSystem, platformTestError } from "../../../test/support/faults.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { Git, GitCommandError, GitOutputParseError, type GitService } from "../../services/git.ts";
import { observeProjectRefresh, projectRootIsReachable } from "./project-refresh.ts";
import type { ProjectRecord } from "../../domain/projects/project-schema.ts";
import { ProjectStorageError, ProjectValidationError } from "../projects/project.ts";

const project = (anchor: string, root: string): ProjectRecord => ({
  gitCommonDirectory: anchor,
  name: "project",
  roots: [root],
});

const observe = (record: ProjectRecord, git: GitService) =>
  observeProjectRefresh(record).pipe(Effect.provideService(Git, git));

it.layer(LiveTestLayer)("project refresh observation", (observationIt) => {
  observationIt.effect(
    "validates the anchor, filters Git metadata, and returns sorted canonical roots",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-refresh-observation-test-",
        });
        const anchorPath = path.join(fixture, "anchor");
        const firstPath = path.join(fixture, "a-root");
        const secondPath = path.join(fixture, "z-root");
        const secondAlias = path.join(fixture, "z-alias");
        yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
        yield* fileSystem.makeDirectory(firstPath, { recursive: true });
        yield* fileSystem.makeDirectory(secondPath, { recursive: true });
        yield* fileSystem.symlink(secondPath, secondAlias);
        const anchor = yield* fileSystem.realPath(anchorPath);
        const first = yield* fileSystem.realPath(firstPath);
        const second = yield* fileSystem.realPath(secondPath);
        const calls: Array<readonly ["list" | "resolve", string]> = [];

        const result = yield* observe(
          project(anchor, first),
          fakeGit(
            anchor,
            [
              { path: secondAlias },
              { path: first },
              { path: second },
              { bare: true, path: path.join(fixture, "ignored-bare") },
              { path: path.join(fixture, "ignored-prunable"), prunable: "gone" },
            ],
            (operation, cwd) => calls.push([operation, cwd]),
          ),
        );

        expect(result).toEqual({ gitCommonDirectory: anchor, roots: [first, second] });
        expect(calls).toEqual([
          ["resolve", anchor],
          ["list", anchor],
        ]);
      }),
  );

  observationIt.effect("rejects missing, non-canonical, and non-directory anchors", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tack-refresh-anchor-test-",
      });
      const missing = path.join(fixture, "missing");
      const anchor = path.join(fixture, "anchor");
      const alias = path.join(fixture, "anchor-alias");
      const file = path.join(fixture, "anchor-file");
      yield* fileSystem.makeDirectory(anchor, { recursive: true });
      yield* fileSystem.symlink(anchor, alias);
      yield* fileSystem.writeFileString(file, "not a directory");
      const canonicalAnchor = yield* fileSystem.realPath(anchor);
      const canonicalFile = yield* fileSystem.realPath(file);
      const git = fakeGit(canonicalAnchor, []);

      const missingError = yield* Effect.flip(observe(project(missing, missing), git));
      const aliasError = yield* Effect.flip(observe(project(alias, alias), git));
      const fileError = yield* Effect.flip(observe(project(canonicalFile, canonicalFile), git));

      expect(missingError).toBeInstanceOf(ProjectValidationError);
      expect(missingError).toMatchObject({ code: "git-anchor-missing", path: missing });
      expect(aliasError).toMatchObject({ code: "git-anchor-location-changed", path: alias });
      expect(fileError).toMatchObject({
        code: "git-anchor-not-directory",
        path: canonicalFile,
      });
    }),
  );

  observationIt.effect("requires Git to resolve the exact retained common directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tack-refresh-git-anchor-test-",
      });
      const anchorPath = path.join(fixture, "anchor");
      const otherPath = path.join(fixture, "other-anchor");
      yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
      yield* fileSystem.makeDirectory(otherPath, { recursive: true });
      const anchor = yield* fileSystem.realPath(anchorPath);
      const other = yield* fileSystem.realPath(otherPath);

      const error = yield* Effect.flip(observe(project(anchor, anchor), fakeGit(other, [])));

      expect(error).toBeInstanceOf(ProjectValidationError);
      expect(error).toMatchObject({ code: "git-anchor-location-changed", path: anchor });
    }),
  );

  observationIt.effect("accepts a symlink spelling of the retained common directory from Git", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-refresh-git-alias-test-" }),
      );
      const anchor = path.join(fixture, "anchor");
      const alias = path.join(fixture, "anchor-alias");
      const root = path.join(fixture, "root");
      yield* fileSystem.makeDirectory(anchor, { recursive: true });
      yield* fileSystem.makeDirectory(root, { recursive: true });
      yield* fileSystem.symlink(anchor, alias);

      const result = yield* observe(project(anchor, root), fakeGit(alias, [{ path: root }]));

      expect(result).toEqual({ gitCommonDirectory: anchor, roots: [root] });
    }),
  );

  observationIt.effect("requires every retained Git worktree to exist as a directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tack-refresh-worktree-test-",
      });
      const anchorPath = path.join(fixture, "anchor");
      const missing = path.join(fixture, "missing");
      const file = path.join(fixture, "worktree-file");
      yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
      yield* fileSystem.writeFileString(file, "not a directory");
      const anchor = yield* fileSystem.realPath(anchorPath);
      const canonicalFile = yield* fileSystem.realPath(file);

      const missingError = yield* Effect.flip(
        observe(project(anchor, anchor), fakeGit(anchor, [{ path: missing }])),
      );
      const fileError = yield* Effect.flip(
        observe(project(anchor, anchor), fakeGit(anchor, [{ path: file }])),
      );

      expect(missingError).toMatchObject({ code: "root-missing", path: missing });
      expect(fileError).toMatchObject({ code: "root-not-directory", path: canonicalFile });
    }),
  );

  observationIt.effect("treats only absent stale roots as unreachable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-refresh-reachable-test-" }),
      );
      const directory = path.join(fixture, "directory");
      const file = path.join(fixture, "file");
      const dangling = path.join(fixture, "dangling");
      const failing = path.join(fixture, "failing");
      yield* fileSystem.makeDirectory(directory);
      yield* fileSystem.makeDirectory(failing);
      yield* fileSystem.writeFileString(file, "not a directory");
      yield* fileSystem.symlink(path.join(fixture, "missing"), dangling);
      const failingFileSystem = yield* faultyFileSystem({
        stat: (candidate) =>
          candidate === failing ? platformTestError("stat", candidate) : undefined,
      });

      const reachable = yield* Effect.forEach(
        [directory, file, dangling, path.join(fixture, "missing")],
        projectRootIsReachable,
      );
      const failure = yield* Effect.flip(
        provideTestFileSystem(projectRootIsReachable(failing), failingFileSystem),
      );

      expect(reachable).toEqual([true, true, false, false]);
      expect(failure).toBeInstanceOf(ProjectStorageError);
      expect(failure).toMatchObject({ operation: "inspect stale project root", path: failing });
    }),
  );

  observationIt.effect("maps platform failures and preserves typed Git failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tack-refresh-failure-test-",
      });
      const anchorPath = path.join(fixture, "anchor");
      const rootPath = path.join(fixture, "root");
      yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
      yield* fileSystem.makeDirectory(rootPath, { recursive: true });
      const anchor = yield* fileSystem.realPath(anchorPath);
      const root = yield* fileSystem.realPath(rootPath);
      const failingFileSystem = yield* faultyFileSystem({
        realPath: (candidate) =>
          candidate === root ? platformTestError("realPath", candidate) : undefined,
      });
      const storageFailure = yield* Effect.flip(
        provideTestFileSystem(
          observe(project(anchor, root), fakeGit(anchor, [{ path: root }])),
          failingFileSystem,
        ),
      );
      const commandFailure = new GitCommandError({
        args: ["rev-parse"],
        code: "git-process-failed",
        command: "git",
        cwd: anchor,
        exitCode: 1,
        message: "Git failed.",
        phase: "exit",
        stderr: "failure",
      });
      const commandError = yield* Effect.flip(
        observe(project(anchor, root), {
          listWorktrees: () => Effect.succeed([]),
          resolveCommonDirectory: () => Effect.fail(commandFailure),
        }),
      );
      const parseFailure = new GitOutputParseError({
        command: "git worktree list --porcelain -z",
        message: "Malformed output.",
      });
      const parseError = yield* Effect.flip(
        observe(project(anchor, root), {
          listWorktrees: () => Effect.fail(parseFailure),
          resolveCommonDirectory: () => Effect.succeed(anchor),
        }),
      );

      expect(storageFailure).toBeInstanceOf(ProjectStorageError);
      expect(storageFailure).toMatchObject({
        code: "project-access-failed",
        operation: "resolve Git worktree",
        path: root,
      });
      expect(commandError).toBe(commandFailure);
      expect(parseError).toBe(parseFailure);
    }),
  );
});
