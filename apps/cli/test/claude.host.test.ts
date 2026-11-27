import { managedLinksOf } from "../src/domain/links/link-record-schema.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { readState } from "../src/services/state-store.ts";
import { ReconciliationPlanSchema } from "../src/domain/reconciliation/reconciliation-schema.ts";
import { SyncPlanSchema } from "../src/domain/reconciliation/sync-schema.ts";
import { StatusPayloadSchema } from "../src/domain/status/status-schema.ts";
import {
  partialEnvelope,
  hostTack,
  successfulEnvelope,
  withTackWorld,
} from "./support/tack-world.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";

const reconciliationPlan = (payload: unknown) => {
  const combined = Schema.decodeUnknownSync(SyncPlanSchema)(payload);
  if (combined.resources === null) throw new Error("Expected resource plan.");
  return Schema.decodeUnknownSync(ReconciliationPlanSchema)(combined.resources);
};

it.layer(LiveTestLayer)("Claude Code adapter", (claudeIt) => {
  claudeIt.effect.each(["project", "user"] as const)(
    "reconciles, reports, cleans, and disables Claude Code for the %s target alongside other agents",
    (target) =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const selector = target === "project" ? ["--project", "workspace"] : ["--user"];
          const root = target === "project" ? fixture.primaryRoot : fixture.homeDirectory;
          const claudeDirectory = path.join(root, ".claude", "skills");
          const claudeDestination = path.join(claudeDirectory, "valid");
          const source = yield* fileSystem.realPath(
            path.join(fixture.sourceDirectory, "skills", "valid"),
          );
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const allAdapters = ["claude", "codex", "cursor"];
          const destinations = [".claude", ".agents", ".cursor"].map((directory) =>
            path.join(root, directory, "skills", "valid"),
          );

          successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "codex", "cursor"]));
          successfulEnvelope(
            yield* hostTack(fixture, ["adapter", "enable", "cursor", "claude", "codex"]),
          );
          expect(successfulEnvelope(yield* hostTack(fixture, ["adapter", "list"])).result).toEqual({
            kind: "adapters",
            enabledAdapters: allAdapters,
          });
          if (target === "user") {
            for (const args of [["pick", "include", "valid", "--user"]]) {
              successfulEnvelope(yield* hostTack(fixture, args));
            }
          }
          const beforeDryRun = yield* fileSystem.readFileString(statePath);
          const reconcile = [
            "sync",
            ...selector,
            "--adapter",
            "claude",
            "--require-capability",
            "skill-links",
          ];
          const dryRun = successfulEnvelope(yield* hostTack(fixture, reconcile));
          const plan = reconciliationPlan(dryRun.plan);
          expect(plan.units).toMatchObject([
            {
              adapter: "claude",
              actions: expect.arrayContaining([
                { _tag: "directory-create", directoryPath: claudeDirectory },
              ]),
              capability: { _tag: "supported", capability: "skill-links" },
              delivery: { command: "unsupported", skill: "delivered" },
            },
          ]);
          expect(yield* fileSystem.readFileString(statePath)).toBe(beforeDryRun);
          for (const destination of destinations) {
            expect(yield* fileSystem.exists(path.dirname(destination))).toBe(false);
          }

          const applied = successfulEnvelope(yield* hostTack(fixture, [...reconcile, "--apply"]));
          expect(applied.plan).toEqual(dryRun.plan);
          expect(yield* fileSystem.readLink(claudeDestination)).toBe(
            path.relative(claudeDirectory, source),
          );
          expect(yield* fileSystem.realPath(claudeDestination)).toBe(source);
          const data = (yield* readState(fixture.options)).data;
          expect(data.enabledAdapters).toEqual(allAdapters);
          // A user sync also delivers the built-in skills; this test follows its own skill.
          expect(data.links.filter((link) => link.sourceDirectoryPath === source)).toMatchObject([
            { delivery: { _tag: "agent", adapter: "claude" }, sourceDirectoryPath: source },
          ]);
          for (const destination of destinations.slice(1)) {
            expect(yield* fileSystem.exists(path.dirname(destination))).toBe(false);
          }

          successfulEnvelope(yield* hostTack(fixture, ["sync", ...selector, "--apply"]));
          for (const destination of destinations) {
            expect(yield* fileSystem.realPath(destination)).toBe(source);
          }
          const idempotent = successfulEnvelope(
            yield* hostTack(fixture, ["sync", ...selector, "--apply"]),
          );
          expect(reconciliationPlan(idempotent.plan).units).toMatchObject(
            allAdapters.map((adapter) => ({ actions: [], adapter, conflicts: [] })),
          );
          const beforeStatus = yield* fileSystem.readFileString(statePath);
          const status = successfulEnvelope(yield* hostTack(fixture, ["status", ...selector]));
          expect(
            Schema.decodeUnknownSync(StatusPayloadSchema)(status.result).destinations,
          ).toContainEqual(
            expect.objectContaining({
              _tag: "matching",
              adapter: "claude",
              destinationPath: claudeDestination,
            }),
          );
          expect(yield* fileSystem.readFileString(statePath)).toBe(beforeStatus);

          const sentinel = path.join(claudeDirectory, "operator.txt");
          yield* fileSystem.writeFileString(sentinel, "operator-owned\n");
          successfulEnvelope(yield* hostTack(fixture, ["state", "clean", ...selector, "--apply"]));
          for (const destination of destinations) {
            expect(yield* fileSystem.exists(destination)).toBe(false);
          }
          expect(yield* fileSystem.readFileString(sentinel)).toBe("operator-owned\n");
          successfulEnvelope(yield* hostTack(fixture, ["sync", ...selector, "--apply"]));

          const beforeDisable = yield* fileSystem.readFileString(statePath);
          const disablePlan = successfulEnvelope(
            yield* hostTack(fixture, ["adapter", "disable", "claude"]),
          );
          expect(yield* fileSystem.readFileString(statePath)).toBe(beforeDisable);
          expect(yield* fileSystem.realPath(claudeDestination)).toBe(source);
          const disabled = successfulEnvelope(
            yield* hostTack(fixture, ["adapter", "disable", "claude", "--apply"]),
          );
          expect(disabled.plan).toEqual(disablePlan.plan);
          expect(yield* fileSystem.exists(claudeDestination)).toBe(false);
          for (const destination of destinations.slice(1)) {
            expect(yield* fileSystem.realPath(destination)).toBe(source);
          }
          expect(successfulEnvelope(yield* hostTack(fixture, ["adapter", "list"])).result).toEqual({
            kind: "adapters",
            enabledAdapters: ["codex", "cursor"],
          });
          expect(yield* fileSystem.readFileString(sentinel)).toBe("operator-owned\n");
          expect(yield* fileSystem.exists(path.join(source, "SKILL.md"))).toBe(true);
        }),
      ),
  );

  claudeIt.effect("preserves foreign content at a Claude Code destination", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const destination = path.join(fixture.homeDirectory, ".claude", "skills", "valid");
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.writeFileString(destination, "operator-owned\n");
        successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "claude"]));
        for (const args of [["pick", "include", "valid", "--user"]]) {
          successfulEnvelope(yield* hostTack(fixture, args));
        }

        const result = partialEnvelope(yield* hostTack(fixture, ["sync", "--user", "--apply"]));
        const plan = reconciliationPlan(result.plan);
        expect(plan.units).toMatchObject([{ adapter: "claude", conflicts: [expect.any(Object)] }]);
        expect(yield* fileSystem.readFileString(destination)).toBe("operator-owned\n");
        expect(
          managedLinksOf((yield* readState(fixture.options)).data.links).filter(
            (link) => link.address.name === "valid",
          ),
        ).toEqual([]);
      }),
    ),
  );

  claudeIt.effect("reports a link that cannot be written as partial with exit status 1", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const skills = path.join(fixture.primaryRoot, ".claude", "skills");
        successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "claude"]));
        yield* fileSystem.makeDirectory(skills, { recursive: true });
        yield* Effect.acquireRelease(fileSystem.chmod(skills, 0o555), () =>
          Effect.orDie(fileSystem.chmod(skills, 0o755)),
        );

        const result = partialEnvelope(
          yield* hostTack(fixture, [
            "sync",
            "--project",
            "workspace",
            "--adapter",
            "claude",
            "--apply",
          ]),
        );
        // Both the selected skill and the project's sources skill fail to link.
        expect(result.diagnostics).toMatchObject([
          { code: "link-action-failed" },
          { code: "link-action-failed" },
        ]);
        expect(yield* fileSystem.readDirectory(skills)).toEqual([]);
      }),
    ),
  );
});
