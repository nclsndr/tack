import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { LiveTestLayer } from "../../../../test/support/live-test-layer.ts";
import { profileFixture } from "../../../../test/support/profile-fixture.ts";
import { syncRoutes } from "./sync.ts";
import { outcomeOf } from "./route.test-support.ts";

it.layer(LiveTestLayer)("sync routes", (test) => {
  test.effect("classifies a sync whose link action fails as partial", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      const skills = world.path.join(world.project, ".agents", "skills");
      yield* world.fs.makeDirectory(skills, { recursive: true });
      yield* Effect.acquireRelease(world.fs.chmod(skills, 0o555), () =>
        Effect.orDie(world.fs.chmod(skills, 0o755)),
      );
      const outcome = yield* world.run(
        outcomeOf(
          syncRoutes.sync.run(
            {
              _tag: "sync",
              apply: true,
              cwd: world.project,
              includeOptional: false,
              noDocs: false,
              selector: { _tag: "project", projectName: "ci" },
            },
            world.options,
          ),
        ),
      );
      expect(outcome).toMatchObject({
        classification: "partial",
        diagnostics: ["notes", "style"].map((name) => ({
          code: "link-action-failed",
          details: { subject: { path: world.path.join(skills, name) } },
        })),
        applied: { resources: { units: [{ status: "failed" }] } },
      });
    }),
  );
});
