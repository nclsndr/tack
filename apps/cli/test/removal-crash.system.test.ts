import { LiveTestLayer } from "./support/live-test-layer.ts";
import { repositoryRoot, tackEnvironment } from "./support/tack-process.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/process";
import { stateManagedLinks, statePendingRemovals } from "../src/features/removal/removal-plan.ts";
import { readState } from "../src/services/state-store.ts";
import { managedLinkDestinationPath } from "../src/domain/agents/agent-layout.ts";
import { projectSourcesSkillName } from "../src/domain/generated/sources-skill.ts";
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
            // The project's skill and its sources skill: the kill lands on the first unlink.
            const owned = stateManagedLinks(yield* readState(fixture.options));
            expect(owned.map((evidence) => evidence.address.name).sort()).toEqual([
              projectSourcesSkillName,
              "valid",
            ]);
            const onDisk = Effect.forEach(owned, (evidence) =>
              fileSystem.exists(managedLinkDestinationPath(evidence)),
            );
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
            expect((yield* onDisk).filter((exists) => exists === false)).toHaveLength(
              crashPoint === "before-unlink" ? 0 : 1,
            );
            const crashedState = yield* readState(fixture.options);
            expect(crashedState.data.journal?.map((entry) => entry._tag)).toEqual([
              "remove",
              "remove",
            ]);
            expect(stateManagedLinks(crashedState)).toEqual(owned);
            expect(statePendingRemovals(crashedState)).toEqual(
              expect.arrayContaining(owned.map((evidence) => ({ cause: "clean", evidence }))),
            );

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

            // The link the kill interrupted is retried; the other is removed for the first time.
            expect(retried.plan).toMatchObject({
              actions: [expect.anything(), expect.anything()],
            });
            expect(retried.plan).toMatchObject({
              actions: expect.arrayContaining([
                expect.objectContaining({ _tag: retryAction }),
                expect.objectContaining({ _tag: "remove" }),
              ]),
            });
            expect(retried.applied).toMatchObject({
              actions: [{ _tag: "applied" }, { _tag: "applied" }],
            });
            expect(yield* onDisk).toEqual([false, false]);
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
