import { isMinimalRecoveryState } from "../src/features/removal/removal-apply.ts";
import { pendingRemovalsOf } from "../src/domain/links/link-record-schema.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { decodeState } from "../src/domain/state/state-codec.ts";
import { managedLinkDestinationPath } from "../src/domain/agents/agent-layout.ts";
import {
  partialEnvelope,
  runTack,
  successfulEnvelope,
  withTackWorld,
} from "./fixtures/tack-world.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

const reconcile = (selector: ReadonlyArray<string>) => ["sync", ...selector, "--apply"];

it.layer(LiveTestLayer)("project reset and retry", (resetIt) => {
  resetIt.effect(
    "fully resets all managed targets while preserving operator-owned content and directories",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          successfulEnvelope(yield* runTack(fixture, ["adapter", "enable", "cursor", "codex"]));
          // Picked for the user after the project sync, so the project keeps the link it made.
          successfulEnvelope(yield* runTack(fixture, reconcile(["--project", "workspace"])));
          successfulEnvelope(yield* runTack(fixture, ["pick", "include", "valid", "--user"]));
          successfulEnvelope(yield* runTack(fixture, reconcile(["--user"])));

          const managedDestinations = [
            path.join(fixture.primaryRoot, ".agents", "skills", "valid"),
            path.join(fixture.primaryRoot, ".cursor", "skills", "valid"),
            path.join(fixture.homeDirectory, ".agents", "skills", "valid"),
            path.join(fixture.homeDirectory, ".cursor", "skills", "valid"),
          ];
          const destinationDirectories = managedDestinations.map((destination) =>
            path.dirname(destination),
          );
          const sentinels = destinationDirectories.map((directory, index) =>
            path.join(directory, `operator-${index}.txt`),
          );
          yield* Effect.forEach(sentinels, (sentinel) =>
            fileSystem.writeFileString(sentinel, "operator content\n"),
          );
          const dotenvPath = path.join(fixture.stateDirectory, ".env");
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const sourceSkillPath = path.join(fixture.sourceDirectory, "skills", "valid", "SKILL.md");
          yield* fileSystem.writeFileString(dotenvPath, "TACK_TOKEN=operator-value\n");
          const sourceBefore = yield* fileSystem.readFileString(sourceSkillPath);
          const beforeDryRun = yield* fileSystem.readFileString(statePath);
          const historyPath = path.join(fixture.stateDirectory, "history", "retained.json");
          yield* fileSystem.makeDirectory(path.dirname(historyPath), { recursive: true });
          yield* fileSystem.writeFileString(historyPath, "retained run evidence");

          const dryRun = successfulEnvelope(yield* runTack(fixture, ["state", "reset"]));
          expect(yield* fileSystem.readFileString(statePath)).toBe(beforeDryRun);
          expect(yield* fileSystem.readFileString(historyPath)).toBe("retained run evidence");
          expect(
            yield* Effect.forEach(managedDestinations, (destination) =>
              fileSystem.exists(destination),
            ),
          ).toEqual([true, true, true, true]);
          const applied = successfulEnvelope(
            yield* runTack(fixture, ["state", "reset", "--apply"]),
          );
          expect(applied.plan).toEqual(dryRun.plan);
          expect(yield* fileSystem.exists(historyPath)).toBe(false);
          expect(yield* fileSystem.exists(statePath)).toBe(false);
          expect(
            yield* Effect.forEach(managedDestinations, (destination) =>
              fileSystem.exists(destination),
            ),
          ).toEqual([false, false, false, false]);
          expect(
            yield* Effect.forEach(destinationDirectories, (directory) =>
              fileSystem.exists(directory),
            ),
          ).toEqual([true, true, true, true]);
          expect(
            yield* Effect.forEach(sentinels, (sentinel) => fileSystem.readFileString(sentinel)),
          ).toEqual([
            "operator content\n",
            "operator content\n",
            "operator content\n",
            "operator content\n",
          ]);
          expect(yield* fileSystem.readFileString(dotenvPath)).toBe("TACK_TOKEN=operator-value\n");
          expect(yield* fileSystem.readFileString(sourceSkillPath)).toBe(sourceBefore);

          for (const selector of [["--project", "workspace"], ["--user"]] as const) {
            const invalid = yield* runTack(fixture, ["state", "reset", ...selector]);
            expect(invalid.exitCode).toBe(ChildProcessSpawner.ExitCode(2));
            expect(decodeEnvelope(invalid.stdout)).toMatchObject({
              classification: "invalid-invocation",
              status: "failure",
            });
          }
        }),
      ),
    { timeout: 20_000 },
  );

  resetIt.effect(
    "retains only foreign-safe recovery evidence and converges through explicit retry",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          successfulEnvelope(yield* runTack(fixture, ["adapter", "enable", "codex"]));
          // Picked for the user after the project sync, so the project keeps the link it made.
          successfulEnvelope(yield* runTack(fixture, reconcile(["--project", "workspace"])));
          successfulEnvelope(yield* runTack(fixture, ["pick", "include", "valid", "--user"]));
          successfulEnvelope(yield* runTack(fixture, reconcile(["--user"])));
          const projectDestination = path.join(fixture.primaryRoot, ".agents", "skills", "valid");
          const userDestination = path.join(fixture.homeDirectory, ".agents", "skills", "valid");
          const foreignTarget = path.join(path.dirname(fixture.stateDirectory), "foreign");
          yield* fileSystem.makeDirectory(foreignTarget, { recursive: true });
          yield* fileSystem.remove(projectDestination);
          yield* fileSystem.symlink(
            path.relative(path.dirname(projectDestination), foreignTarget),
            projectDestination,
          );
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const historyPath = path.join(fixture.stateDirectory, "history", "retained.json");
          yield* fileSystem.makeDirectory(path.dirname(historyPath), { recursive: true });
          yield* fileSystem.writeFileString(historyPath, "retained run evidence");
          const dryRun = partialEnvelope(yield* runTack(fixture, ["state", "reset"]));
          const applied = partialEnvelope(yield* runTack(fixture, ["state", "reset", "--apply"]));
          expect(applied.plan).toEqual(dryRun.plan);
          expect(yield* fileSystem.exists(userDestination)).toBe(false);
          expect(yield* fileSystem.readLink(projectDestination)).toBe(
            path.relative(path.dirname(projectDestination), foreignTarget),
          );
          const persistedRecovery = JSON.parse(yield* fileSystem.readFileString(statePath));
          const recovery = yield* decodeState(persistedRecovery);
          expect(persistedRecovery).toMatchObject({
            format: 1,
            data: {
              links: [
                {
                  delivery: { _tag: "agent", adapter: "codex" },
                  destinationPath: projectDestination,
                  target: {
                    _tag: "project-root",
                    projectName: "workspace",
                    canonicalPath: fixture.primaryRoot,
                  },
                  pendingOnly: true,
                  removal: { cause: "reset", lastResult: { _tag: "blocked" } },
                },
              ],
            },
          });
          expect(persistedRecovery.data.links).toHaveLength(1);
          expect(isMinimalRecoveryState(recovery)).toBe(true);
          expect(yield* fileSystem.readFileString(historyPath)).toBe("retained run evidence");
          expect(
            pendingRemovalsOf(recovery.data.links).map((pending) =>
              managedLinkDestinationPath(pending.evidence),
            ),
          ).toEqual([projectDestination]);

          const stillBlocked = partialEnvelope(
            yield* runTack(fixture, [
              "state",
              "clean",
              "--pending",
              "--project",
              "workspace",
              "--apply",
            ]),
          );
          expect(stillBlocked.applied).toMatchObject({
            actions: [{ _tag: "skipped" }],
          });
          expect(yield* fileSystem.readLink(projectDestination)).toBe(
            path.relative(path.dirname(projectDestination), foreignTarget),
          );
          expect(yield* fileSystem.exists(userDestination)).toBe(false);

          expect(yield* fileSystem.exists(historyPath)).toBe(true);
          yield* fileSystem.remove(projectDestination);
          const converged = successfulEnvelope(
            yield* runTack(fixture, [
              "state",
              "clean",
              "--pending",
              "--project",
              "workspace",
              "--apply",
            ]),
          );
          expect(converged.applied).toMatchObject({ actions: [{ _tag: "applied" }] });
          expect(yield* fileSystem.exists(historyPath)).toBe(false);
          expect(yield* fileSystem.exists(statePath)).toBe(false);
          expect(yield* fileSystem.exists(userDestination)).toBe(false);
          expect(yield* fileSystem.exists(path.dirname(projectDestination))).toBe(true);
        }),
      ),
    { timeout: 20_000 },
  );
});
