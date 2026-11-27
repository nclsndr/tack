import { writeUnder, seedSource, profileSourceFiles, bareSkillText } from "./source-tree.ts";
import { Effect, FileSystem, Path } from "effect";
import { mutateStateFixture, stateOptionsAt } from "./state-fixture.ts";
import { initializeState } from "../../src/services/state-store.ts";
import { registerSource } from "../../src/features/sources/source.ts";
import { Git } from "../../src/services/git.ts";

export const profileFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "profile-apply-" }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const source = path.join(root, "source");
  const options = stateOptionsAt(path.join(home, "state"), home);
  yield* fs.makeDirectory(project);
  yield* seedSource(
    source,
    profileSourceFiles({
      "skills/review/SKILL.md": bareSkillText("review", {
        description: "Review",
        tack: [
          "activation: opt-in",
          "projects: [other]",
          "dependencies:",
          "  - kind: skill",
          "    name: style",
        ],
      }),
      "skills/style/SKILL.md": bareSkillText("style"),
      "skills/notes/SKILL.md": bareSkillText("notes"),
    }),
  );
  yield* initializeState(options);
  const registered = yield* registerSource(options, { sourcePath: source });
  yield* mutateStateFixture(options, (state) => ({
    ...state,
    data: {
      ...state.data,
      enabledAdapters: ["codex"],
      projects: [{ name: "ci", gitCommonDirectory: path.join(root, "git"), roots: [project] }],
    },
  }));
  const request = {
    reference: "tools:ci",
    namespace: { _tag: "project", projectName: "ci" },
    targetRoots: [project],
    force: false,
    apply: true,
    cwd: project,
  } as const;
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        Git,
        Git.of({
          listWorktrees: () => Effect.succeed([{ path: project, bare: false, detached: false }]),
          resolveCommonDirectory: () => Effect.succeed(path.join(root, "git")),
        }),
      ),
    );
  return {
    fs,
    path,
    root,
    home,
    project,
    source,
    options,
    request,
    write: writeUnder(root),
    run,
    sourceId: registered.registration.id,
  };
});
