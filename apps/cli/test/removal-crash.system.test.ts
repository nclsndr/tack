import { LiveTestLayer } from "./support/live-test-layer.ts";
import { repositoryRoot, tackEnvironment } from "./support/tack-process.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/process";
import { stateManagedLinks, statePendingRemovals } from "../src/features/removal/removal-plan.ts";
import { readState } from "../src/services/state-store.ts";
import { runTack, successfulEnvelope, withTackWorld } from "./support/tack-world.ts";

/** Real SIGKILL during a removal, then journal recovery, then retry: the record rows of one destination. */
it.layer(LiveTestLayer)("a killed removal recovers and retries", (crashIt) => {
  for (const [crashPoint, retryAction, rowAfterRecovery] of [
    ["before-unlink", "remove", "managed with its removal"],
    ["after-unlink", "retire", "no longer managed, removal still owed"],
  ] as const) {
    crashIt.effect(
      `settles the record after a kill ${crashPoint} (${rowAfterRecovery})`,
      () =>
        withTackWorld((fixture) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            successfulEnvelope(yield* runTack(fixture, ["adapter", "enable", "codex"]));
            successfulEnvelope(
              yield* runTack(fixture, ["sync", "--project", "workspace", "--apply"]),
            );
            const link = path.join(fixture.primaryRoot, ".agents", "skills", "valid");
            expect(yield* fileSystem.exists(link)).toBe(true);
            const owned = stateManagedLinks(yield* readState(fixture.options));
            expect(owned).toHaveLength(1);
            expect(statePendingRemovals(yield* readState(fixture.options))).toEqual([]);

            const crashed = yield* ChildProcess.make(
              process.execPath,
              [path.join(repositoryRoot, "apps/cli/test/fixtures/crash-removal.ts")],
              {
                cwd: fixture.primaryRoot,
                env: tackEnvironment(
                  { home: fixture.homeDirectory, state: fixture.stateDirectory },
                  {
                    TACK_TEST_CRASH_POINT: crashPoint,
                    TACK_TEST_PROJECT: "workspace",
                    TACK_TEST_PROJECT_ROOT: fixture.primaryRoot,
                  },
                ),
              },
            );
            expect(yield* Effect.flip(crashed.exitCode)).toMatchObject({
              reason: {
                cause: expect.objectContaining({ message: expect.stringContaining("SIGKILL") }),
              },
            });
            expect(yield* fileSystem.exists(path.join(fixture.stateDirectory, "state.lock"))).toBe(
              true,
            );
            expect(yield* fileSystem.exists(link)).toBe(crashPoint === "before-unlink");
            const crashedState = yield* readState(fixture.options);
            expect(crashedState.data.journal?.map((entry) => entry._tag)).toEqual(["remove"]);
            expect(stateManagedLinks(crashedState)).toEqual(owned);
            expect(statePendingRemovals(crashedState)).toEqual([
              { cause: "clean", evidence: owned[0] },
            ]);

            const retried = successfulEnvelope(
              yield* runTack(fixture, [
                "state",
                "clean",
                "--pending",
                "--project",
                "workspace",
                "--apply",
              ]),
            );

            expect(retried.plan).toMatchObject({ actions: [{ _tag: retryAction }] });
            expect(retried.applied).toMatchObject({ actions: [{ _tag: "applied" }] });
            expect(yield* fileSystem.exists(link)).toBe(false);
            expect(yield* fileSystem.exists(path.join(fixture.stateDirectory, "state.lock"))).toBe(
              false,
            );
            const settled = yield* readState(fixture.options);
            expect(stateManagedLinks(settled)).toEqual([]);
            expect(statePendingRemovals(settled)).toEqual([]);
            expect(settled.data.journal).toBeUndefined();
          }),
        ),
      { timeout: 60_000 },
    );
  }
});
