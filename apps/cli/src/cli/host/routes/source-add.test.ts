import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../../test/support/live-test-layer.ts";
import { routeOutcome } from "./route.test-support.ts";
import { sourceRoutes } from "./sources.ts";

it.layer(LiveTestLayer)("source add route", (test) => {
  test.effect(
    "previews the state its apply initializes with no agent when none is named for it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "tack-source-add-" }),
        );
        const home = path.join(root, "home");
        const folder = path.join(root, "agent-setup");
        yield* fs.makeDirectory(home);
        yield* fs.makeDirectory(path.join(folder, "skills", "review"), { recursive: true });
        yield* fs.writeFileString(
          path.join(folder, "skills", "review", "SKILL.md"),
          "---\nname: review\ndescription: Review a change.\n---\nReview.\n",
        );
        // No `initialAdapters`: the new state would enable no agent, and the preview says so.
        const preview = yield* routeOutcome(
          sourceRoutes["source-add"].run(
            {
              _tag: "source-add",
              sourcePath: folder,
              apply: false,
              folders: { skills: ["skills"], commands: [], context: [], docs: [] },
            },
            { environment: {}, homeDirectory: home },
          ),
        );
        const stateDirectory = path.join(home, ".tack");
        expect(preview.diagnostics).toEqual([
          {
            code: "state-initialization-planned",
            severity: "info",
            message: `Tack state does not exist yet: --apply initializes it at ${stateDirectory}; no agent folder was found in this home, so no agent is enabled.`,
            details: { stateDirectory, enabledAdapters: [] },
          },
        ]);
        expect(yield* fs.exists(stateDirectory)).toBe(false);
      }),
  );
});
