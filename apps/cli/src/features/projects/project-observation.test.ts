import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { faultyFileSystem, platformTestError } from "../../../test/support/faults.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { Git } from "../../services/git.ts";
import {
  observeDirectory,
  observeRegisteredDirectory,
  observeRepository,
  ProjectStorageError,
  ProjectValidationError,
  requireDirectory,
} from "./project-observation.ts";

const requirement = {
  missing: { code: "root-missing", message: "Missing." },
  notDirectory: { code: "root-not-directory", message: "Not a directory." },
  operations: { inspect: "inspect root", resolve: "resolve root" },
} as const;

it.layer(LiveTestLayer)("project observation", (observationIt) => {
  observationIt.effect("canonicalizes candidates and reports what each one resolves to", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-project-observation-test-" }),
      );
      const directory = path.join(root, "directory");
      const alias = path.join(root, "alias");
      const file = path.join(root, "file");
      yield* fileSystem.makeDirectory(directory);
      yield* fileSystem.symlink(directory, alias);
      yield* fileSystem.writeFileString(file, "not a directory");
      const failResolve = path.join(root, "fail-resolve");
      const failInspect = path.join(root, "fail-inspect");
      yield* fileSystem.makeDirectory(failResolve);
      yield* fileSystem.makeDirectory(failInspect);
      const failingFileSystem = yield* faultyFileSystem({
        realPath: (candidate) =>
          candidate === failResolve ? platformTestError("realPath", candidate) : undefined,
        stat: (candidate) =>
          candidate === failInspect ? platformTestError("stat", candidate) : undefined,
      });

      const observed = yield* Effect.forEach(
        [
          observeDirectory(alias),
          observeDirectory("directory", root),
          observeDirectory(file),
          observeDirectory("missing", root),
          observeRegisteredDirectory(alias),
          observeRegisteredDirectory(directory),
        ],
        (effect) => effect,
      );
      const failures = yield* provideTestFileSystem(
        Effect.all([observeDirectory(failResolve), observeDirectory(failInspect)]),
        failingFileSystem,
      );

      expect(observed).toEqual([
        { _tag: "directory", path: directory },
        { _tag: "directory", path: directory },
        { _tag: "not-directory", path: file },
        { _tag: "missing", path: path.join(root, "missing") },
        { _tag: "location-changed", path: alias },
        { _tag: "directory", path: directory },
      ]);
      expect(failures).toMatchObject([
        { _tag: "access-failed", operation: "resolve", path: failResolve },
        { _tag: "access-failed", operation: "inspect", path: failInspect },
      ]);
    }),
  );

  observationIt.effect("requires an existing directory with the workflow's own errors", () =>
    Effect.gen(function* () {
      const check = requireDirectory(requirement);
      const error = platformTestError("stat", "/root");

      const accepted = yield* check({ _tag: "directory", path: "/root" });
      const missing = yield* Effect.flip(check({ _tag: "missing", path: "/root" }));
      const notDirectory = yield* Effect.flip(check({ _tag: "not-directory", path: "/root" }));
      const failed = yield* Effect.flip(
        check({ _tag: "access-failed", error, operation: "inspect", path: "/root" }),
      );

      expect(accepted).toBe("/root");
      expect(missing).toBeInstanceOf(ProjectValidationError);
      expect(missing).toMatchObject({ code: "root-missing", message: "Missing.", path: "/root" });
      expect(notDirectory).toMatchObject({
        code: "root-not-directory",
        message: "Not a directory.",
        path: "/root",
      });
      expect(failed).toBeInstanceOf(ProjectStorageError);
      expect(failed).toMatchObject({
        code: "project-access-failed",
        message: error.message,
        operation: "inspect root",
        path: "/root",
      });
    }),
  );

  observationIt.effect("observes Git's common directory and reachable worktrees from one cwd", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-repository-observation-test-" }),
      );
      const cwd = path.join(root, "cwd");
      const anchor = path.join(cwd, ".git");
      const first = path.join(root, "a-root");
      const second = path.join(root, "z-root");
      const secondAlias = path.join(root, "z-alias");
      yield* fileSystem.makeDirectory(anchor, { recursive: true });
      yield* fileSystem.makeDirectory(first);
      yield* fileSystem.makeDirectory(second);
      yield* fileSystem.symlink(second, secondAlias);
      const calls: Array<readonly [string, string]> = [];
      const check = requireDirectory(requirement);

      const observed = yield* observeRepository(cwd, {
        commonDirectory: check,
        worktree: check,
      }).pipe(
        Effect.provideService(Git, {
          listWorktrees: (candidate) => {
            calls.push(["list", candidate]);
            return Effect.succeed([
              { bare: false, detached: false, path: "../z-alias" },
              { bare: false, detached: false, path: second },
              { bare: false, detached: false, path: first },
              { bare: true, detached: false, path: path.join(root, "bare") },
              { bare: false, detached: false, path: path.join(root, "gone"), prunable: "gone" },
            ]);
          },
          resolveCommonDirectory: (candidate) => {
            calls.push(["resolve", candidate]);
            return Effect.succeed(".git");
          },
        }),
      );

      expect(observed).toEqual({ gitCommonDirectory: anchor, roots: [first, second] });
      expect(calls).toEqual([
        ["resolve", cwd],
        ["list", cwd],
      ]);
    }),
  );
});
