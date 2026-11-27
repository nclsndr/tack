import { mutateStateFixture, stateOptionsAt } from "../../../test/support/state-fixture.ts";
import { fakeGit } from "../../../test/support/fake-git.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { Git, GitCommandError, type GitService } from "../../services/git.ts";
import { initializeState } from "../../services/state-store.ts";
import { runProjectRefreshCommand } from "./project-refresh.ts";

/**
 * A state with the active project `demo` (root `main`, anchor `git`) and the project `gone`, whose
 * roots `old` and `old/nested` are still being removed.
 */
const bareWorld = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "tack-refresh-bare-" }),
  );
  const at = (relative: string) => path.join(root, relative);
  for (const directory of ["main/sub", "git", "old/nested/deeper", "outside", "gone-git"])
    yield* fs.makeDirectory(at(directory), { recursive: true });
  yield* fs.writeFileString(at("not-a-directory"), "file\n");
  const options = stateOptionsAt(at("state"), at("home"));
  yield* initializeState(options);
  yield* mutateStateFixture(options, (state) => ({
    ...state,
    data: {
      ...state.data,
      projects: [
        { gitCommonDirectory: at("git"), name: "demo", roots: [at("main")] },
        {
          gitCommonDirectory: at("gone-git"),
          name: "gone",
          removingRoots: [at("old"), at("old/nested")],
          roots: [],
        },
      ],
    },
  }));
  // Observing the registered project always finds its anchor; only the directory being selected
  // gets the given answer, where an undefined answer means git cannot tell.
  const git = (selected: string | undefined, commonDirectory: string | undefined): GitService => {
    const registered = fakeGit(at("git"), [{ path: at("main") }]);
    return {
      ...registered,
      resolveCommonDirectory: (cwd) =>
        cwd !== selected
          ? registered.resolveCommonDirectory(cwd)
          : commonDirectory === undefined
            ? Effect.fail(
                new GitCommandError({
                  args: ["rev-parse"],
                  code: "git-process-failed",
                  command: "git",
                  cwd,
                  message: "not a git repository",
                  phase: "exit",
                  stderr: "fatal: not a git repository",
                }),
              )
            : Effect.succeed(commonDirectory),
    };
  };
  const refresh = (cwd: string | undefined, commonDirectory: string | undefined) =>
    runProjectRefreshCommand(options, {
      apply: false,
      selector: { _tag: "bare" },
      ...(cwd === undefined ? {} : { cwd }),
    }).pipe(
      Effect.map((execution) => execution.plan.selection),
      Effect.provideService(Git, git(cwd, commonDirectory)),
    );
  return { at, refresh };
});

it.layer(LiveTestLayer)("bare project refresh target", (test) => {
  test.effect("selects the project whose git directory the current directory belongs to", () =>
    Effect.gen(function* () {
      const { at, refresh } = yield* bareWorld;
      expect(yield* refresh(at("outside"), at("git"))).toEqual({
        cwd: at("outside"),
        selector: { _tag: "bare" },
        projectName: "demo",
        matchedBy: { _tag: "git-directory", gitCommonDirectory: at("git") },
      });
      // Without an explicit directory, the process directory is used and not echoed back.
      expect(yield* refresh(undefined, at("git"))).toEqual({
        selector: { _tag: "bare" },
        projectName: "demo",
        matchedBy: { _tag: "git-directory", gitCommonDirectory: at("git") },
      });
    }),
  );

  test.effect("falls back to the registered root that contains the directory", () =>
    Effect.gen(function* () {
      const { at, refresh } = yield* bareWorld;
      const containing = {
        cwd: at("main/sub"),
        selector: { _tag: "bare" },
        projectName: "demo",
        matchedBy: { _tag: "containing-root", root: at("main") },
      };
      // Git cannot answer, or answers with something that is not a directory.
      expect(yield* refresh(at("main/sub"), undefined)).toEqual(containing);
      expect(yield* refresh(at("main/sub"), at("not-a-directory"))).toEqual(containing);
    }),
  );

  test.effect("refuses a directory outside every project and names a root being removed", () =>
    Effect.gen(function* () {
      const { at, refresh } = yield* bareWorld;
      expect(yield* Effect.flip(refresh(at("outside"), undefined))).toMatchObject({
        _tag: "TargetSelectionError",
        code: "bare-target-requires-registered-root",
        path: at("outside"),
      });
      const removing = yield* Effect.flip(refresh(at("old/nested/deeper"), undefined));
      expect(removing).toMatchObject({
        _tag: "TargetSelectionError",
        code: "bare-target-requires-registered-root",
        path: at("old/nested/deeper"),
        // The deepest removing root that contains the directory is the one named.
        projectName: "gone",
        root: at("old/nested"),
      });
    }),
  );
});
