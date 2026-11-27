import { generatedSkillRegistrationId } from "../src/domain/generated/sources-skill.ts";
import type { ReconciliationAction } from "../src/domain/reconciliation/reconciliation-schema.ts";
import { skillText } from "./support/source-tree.ts";
import { managedLinksOf } from "../src/domain/links/link-record-schema.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { readState } from "../src/services/state-store.ts";
import { ReconciliationPlanSchema } from "../src/domain/reconciliation/reconciliation-schema.ts";
import { ReconciliationApplyResultSchema } from "../src/domain/reconciliation/reconciliation-application-schema.ts";
import { SyncApplicationSchema, SyncPlanSchema } from "../src/domain/reconciliation/sync-schema.ts";
import { StatusPayloadSchema } from "../src/domain/status/status-schema.ts";
import {
  hostTack,
  successfulEnvelope,
  withTackWorld,
  type TackWorld,
} from "./support/tack-world.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { runTackInProcess } from "./support/host-runner.ts";

const resourcePlan = (payload: unknown) => {
  const combined = Schema.decodeUnknownSync(SyncPlanSchema)(payload);
  if (combined.resources === null) throw new Error("Expected a resource plan.");
  return Schema.decodeUnknownSync(ReconciliationPlanSchema)(combined.resources);
};

const resourceApplication = (payload: unknown) => {
  const combined = Schema.decodeUnknownSync(SyncApplicationSchema)(payload);
  if (combined.resources === null) throw new Error("Expected a resource application.");
  return Schema.decodeUnknownSync(ReconciliationApplyResultSchema)(combined.resources);
};

/** Whether a planned action concerns the project's sources skill rather than a source's resource. */
const isSourcesSkill = (action: ReconciliationAction) =>
  action._tag !== "directory-create" &&
  action.evidence.sourceRegistrationId === generatedSkillRegistrationId;

/** Runs Tack's text view, as an operator reads it, against the fixture's isolated state. */
const runTackText = (fixture: TackWorld, arguments_: ReadonlyArray<string>) =>
  runTackInProcess(arguments_, {
    cwd: fixture.primaryRoot,
    env: { NO_COLOR: "1" },
    home: fixture.homeDirectory,
    state: fixture.stateDirectory,
  });

it.layer(LiveTestLayer)("releasing links changed outside Tack", (releaseIt) => {
  releaseIt.effect(
    "forgets the records of a skill moved into the repository and keeps its three links",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = ["--project", "workspace"];
          const links = [".claude", ".agents", ".cursor"].map((directory) =>
            path.join(fixture.primaryRoot, directory, "skills", "valid"),
          );
          const moved = path.join(fixture.primaryRoot, ".ai", "skills", "valid");
          const validRecords = Effect.map(readState(fixture.options), (state) =>
            managedLinksOf(state.data.links).filter(
              (evidence) =>
                evidence.address.name === "valid" && evidence.target._tag === "project-root",
            ),
          );

          successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "claude", "codex"]));
          successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "cursor"]));
          successfulEnvelope(yield* hostTack(fixture, ["sync", ...project, "--apply"]));
          expect(yield* validRecords).toHaveLength(3);

          // The operator moves the skill into the repository and points every agent link at it.
          yield* fileSystem.makeDirectory(moved, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(moved, "SKILL.md"),
            skillText("valid", { description: "Valid skill", body: "" }),
          );
          for (const link of links) {
            yield* fileSystem.remove(link);
            yield* fileSystem.symlink("../../.ai/skills/valid", link);
          }
          successfulEnvelope(yield* hostTack(fixture, ["pick", "exclude", "valid", ...project]));

          const preview = successfulEnvelope(yield* hostTack(fixture, ["sync", ...project]));
          const planned = resourcePlan(preview.plan).units.filter(
            (unit) => unit.actions.length > 0 || unit.conflicts.length > 0,
          );
          // With its only resource excluded, the project links no source, so its sources skill goes.
          expect(
            planned.map((unit) => [
              unit.adapter,
              unit.actions.filter((action) => isSourcesSkill(action)),
              unit.actions.filter((action) => isSourcesSkill(action) === false),
              unit.conflicts,
              unit.summary,
            ]),
          ).toEqual(
            ["claude", "codex", "cursor"].map((adapter, index) => [
              adapter,
              [expect.objectContaining({ _tag: "link-remove", reason: "deselected" })],
              [
                expect.objectContaining({
                  _tag: "evidence-retire",
                  destinationPath: links[index],
                  reason: "released",
                }),
              ],
              [],
              expect.objectContaining({ conflict: 0, release: 1, remove: 1, retire: 0 }),
            ]),
          );
          expect(yield* validRecords).toHaveLength(3);

          const text = yield* runTackText(fixture, ["sync", ...project]);
          expect(text.exitCode).toBe(ChildProcessSpawner.ExitCode(0));
          const flat = text.stdout.replaceAll(/\s+/g, " ");
          expect(flat.match(/changed outside Tack, no longer managed/g)).toHaveLength(3);
          for (const directory of [".claude", ".agents", ".cursor"])
            expect(flat).toContain(
              `release ${directory}/skills/valid skill valid · changed outside Tack, no longer managed`,
            );

          const applied = successfulEnvelope(
            yield* hostTack(fixture, ["sync", ...project, "--apply"]),
          );
          expect(
            resourceApplication(applied.applied)
              .units.flatMap((unit) => unit.actions)
              .filter((outcome) => isSourcesSkill(outcome.action) === false)
              .map((outcome) => [outcome._tag, outcome.action._tag]),
          ).toEqual(links.map(() => ["applied", "evidence-retire"]));
          expect(yield* validRecords).toEqual([]);
          for (const link of links) {
            expect(yield* fileSystem.readLink(link)).toBe("../../.ai/skills/valid");
            expect(yield* fileSystem.realPath(link)).toBe(moved);
          }

          const second = successfulEnvelope(yield* hostTack(fixture, ["sync", ...project]));
          expect(
            resourcePlan(second.plan).units.flatMap((unit) => [...unit.actions, ...unit.conflicts]),
          ).toEqual([]);
          const status = successfulEnvelope(yield* hostTack(fixture, ["status", ...project]));
          expect(
            Schema.decodeUnknownSync(StatusPayloadSchema)(status.result).destinations.filter(
              (destination) => links.includes(destination.destinationPath),
            ),
          ).toEqual([]);
        }),
      ),
  );
});
