import { mutateStateFixture } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { initializeState } from "../../services/state-store.ts";
import { enableAdapters } from "./agent.ts";
import { syncResources } from "../../../test/support/reconciliation.ts";

it.layer(LiveTestLayer)("reconcile targets", (test) => {
  test.effect("plans links only for the selected home, not for a removal owed elsewhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-rec-" }));
      const home = path.join(root, "home");
      const formerHome = path.join(root, "former-home");
      yield* fs.makeDirectory(home);
      const options = {
        environment: { TACK_STATE_DIR: path.join(root, "state") },
        homeDirectory: home,
      };
      yield* initializeState(options);
      yield* enableAdapters(options, ["codex"]);
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          pendingRemovals: [
            {
              cause: "clean" as const,
              evidence: {
                adapter: "codex" as const,
                address: {
                  kind: "skill" as const,
                  name: "old",
                  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
                },
                sourceDirectoryPath: path.join(root, "source", "old"),
                sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
                target: { _tag: "user" as const, canonicalPath: formerHome },
              },
            },
          ],
        },
      }));
      const execution = yield* syncResources(options, {
        apply: false,
        cwd: home,
        includeOptional: false,
        selector: { _tag: "user" },
      });
      // The owed removal is selected, but reconciliation plans only real targets.
      expect(execution.plan.selection.targets.map((target) => target._tag)).toContain(
        "pending-removal",
      );
      expect(execution.plan.units.map((unit) => unit.target)).toEqual([
        { _tag: "user", canonicalPath: home },
      ]);
    }),
  );
});
