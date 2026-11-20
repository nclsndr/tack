import { fakeGit, outsideRepositoryGit } from "../../../test/support/fake-git.ts";
import { runtimeFixture } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { Git, type GitService } from "../../services/git.ts";
import { bareSelectionHint, observeCheckout, withCheckoutHint } from "./checkout.ts";
import { TargetSelectionError } from "./project.ts";

it.layer(LiveTestLayer)("where the current directory sits", (checkoutIt) => {
  /** A temporary folder holding the named directories, and a state registering `projects`. */
  const fixture = Effect.fnUntraced(function* (
    directories: ReadonlyArray<string>,
    projects: ReadonlyArray<{ readonly name: string; readonly anchor: string; roots: string[] }>,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-checkout-" }),
    );
    const at = (name: string) => path.join(root, name);
    yield* Effect.forEach(directories, (name) =>
      fileSystem.makeDirectory(at(name), { recursive: true }),
    );
    const state = runtimeFixture({
      data: {
        projects: projects.map(({ name, anchor, roots }) => ({
          name,
          gitCommonDirectory: at(anchor),
          roots: roots.map(at),
        })),
      },
    });
    const observe = (cwd: string, git: GitService) =>
      observeCheckout(state, at(cwd)).pipe(Effect.provideService(Git, git));
    return { at, observe };
  });

  checkoutIt.effect("finds the registered root that holds the directory, without asking Git", () =>
    Effect.gen(function* () {
      const { at, observe } = yield* fixture(
        ["app/.git", "app/src"],
        [{ name: "app", anchor: "app/.git", roots: ["app"] }],
      );
      const observation = yield* observe("app/src", outsideRepositoryGit);
      expect(observation).toEqual({ _tag: "registered-root", projectName: "app", root: at("app") });
      expect(bareSelectionHint(observation)).toBeUndefined();
    }),
  );

  checkoutIt.effect(
    "names a new worktree of a registered project and the refresh that adds it",
    () =>
      Effect.gen(function* () {
        const { at, observe } = yield* fixture(
          ["app/.git", "app-wt/src"],
          [{ name: "app", anchor: "app/.git", roots: ["app"] }],
        );
        const observation = yield* observe(
          "app-wt/src",
          fakeGit(at("app/.git"), [{ path: at("app") }, { path: at("app-wt") }]),
        );
        expect(observation).toEqual({
          _tag: "unregistered-worktree",
          projectName: "app",
          root: at("app-wt"),
        });
        expect(bareSelectionHint(observation)?.next).toEqual([
          "tack",
          "project",
          "refresh",
          "--apply",
        ]);
      }),
  );

  checkoutIt.effect.each([
    { folder: "app", registered: [], suggested: "app" },
    { folder: "My App", registered: [], suggested: "My-App" },
    { folder: "_draft", registered: [], suggested: "draft" },
    { folder: "...", registered: [], suggested: "project" },
    { folder: "app", registered: ["app"], suggested: "app-2" },
    { folder: "app", registered: ["app", "app-2"], suggested: "app-3" },
  ])(
    "suggests $suggested for an unregistered repository in $folder, beside $registered",
    ({ folder, registered, suggested }) =>
      Effect.gen(function* () {
        const { at, observe } = yield* fixture(
          [`${folder}/.git`, `${folder}/src`, ...registered.map((name) => `other-${name}/.git`)],
          registered.map((name) => ({
            name,
            anchor: `other-${name}/.git`,
            roots: [`other-${name}`],
          })),
        );
        const observation = yield* observe(
          `${folder}/src`,
          fakeGit(at(`${folder}/.git`), [{ path: at(folder) }]),
        );
        expect(observation).toEqual({
          _tag: "unregistered-repository",
          root: at(folder),
          suggestedName: suggested,
        });
        expect(bareSelectionHint(observation)?.next).toEqual(["tack", "project", "add", suggested]);
      }),
  );

  checkoutIt.effect("takes the deepest worktree that holds the directory", () =>
    Effect.gen(function* () {
      const { at, observe } = yield* fixture(["outer/.git", "outer/inner/src"], []);
      const observation = yield* observe(
        "outer/inner/src",
        fakeGit(at("outer/.git"), [{ path: at("outer") }, { path: at("outer/inner") }]),
      );
      expect(observation).toMatchObject({ root: at("outer/inner"), suggestedName: "inner" });
    }),
  );

  checkoutIt.effect.each([
    { case: "a folder outside every repository", cwd: "loose", git: () => outsideRepositoryGit },
    { case: "a directory that does not exist", cwd: "gone", git: () => outsideRepositoryGit },
    {
      // Git reports no work tree holding the directory, as inside the `.git` folder itself.
      case: "a directory no worktree holds",
      cwd: "repo/.git",
      git: (at: (name: string) => string) => fakeGit(at("repo/.git"), [{ path: at("elsewhere") }]),
    },
  ])("reports $case as outside any repository", ({ cwd, git }) =>
    Effect.gen(function* () {
      const { at, observe } = yield* fixture(["loose", "repo/.git", "elsewhere"], []);
      const observation = yield* observe(cwd, git(at));
      expect(observation).toEqual({ _tag: "outside-repository" });
      expect(bareSelectionHint(observation)).toBeUndefined();
    }),
  );

  checkoutIt.effect("leaves every other selection failure, and one no hint fits, as it was", () =>
    Effect.gen(function* () {
      const { at } = yield* fixture(["loose"], []);
      const state = runtimeFixture({ data: {} });
      const failures = [
        new TargetSelectionError({ code: "current-directory-unavailable", message: "gone" }),
        new TargetSelectionError({ code: "bare-target-requires-registered-root", message: "none" }),
        // Outside every repository there is nothing to register.
        new TargetSelectionError({
          code: "bare-target-requires-registered-root",
          message: "none",
          path: at("loose"),
        }),
      ];
      for (const failure of failures)
        expect(
          yield* withCheckoutHint(state, failure).pipe(
            Effect.provideService(Git, outsideRepositoryGit),
          ),
        ).toBe(failure);
    }),
  );
});
