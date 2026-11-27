import { write, bareSkillText } from "./support/source-tree.ts";
import { managedLinksOf } from "../src/domain/links/link-record-schema.ts";
import { allSkillChoices } from "../src/domain/state/state-intent.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { readState } from "../src/services/state-store.ts";
import { StatusPayloadSchema } from "../src/domain/status/status-schema.ts";
import { decodeEnvelope } from "./support/tack-process.ts";
import {
  partialEnvelope,
  hostTack,
  successfulEnvelope,
  withTackWorld,
} from "./support/tack-world.ts";

const adapterDestination = (adapter: "codex" | "cursor", projectRoot: string, path: Path.Path) =>
  path.join(projectRoot, adapter === "codex" ? ".agents" : ".cursor", "skills", "valid");

const reconcileProject = (arguments_: ReadonlyArray<string> = []) => [
  "sync",
  "--project",
  "workspace",
  ...arguments_,
];

it.layer(LiveTestLayer)("maintenance commands", (maintenanceIt) => {
  maintenanceIt.effect(
    "disables only one adapter and refuses a sync override that names it",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "cursor", "codex"]));
          successfulEnvelope(yield* hostTack(fixture, reconcileProject(["--apply"])));
          const codexDestination = adapterDestination("codex", fixture.primaryRoot, path);
          const cursorDestination = adapterDestination("cursor", fixture.primaryRoot, path);
          expect(yield* fileSystem.exists(codexDestination)).toBe(true);
          expect(yield* fileSystem.exists(cursorDestination)).toBe(true);

          const statePath = path.join(fixture.stateDirectory, "state.json");
          const beforeDryRun = yield* fileSystem.readFileString(statePath);
          const dryRun = successfulEnvelope(
            yield* hostTack(fixture, ["adapter", "disable", "cursor"]),
          );
          expect(yield* fileSystem.readFileString(statePath)).toBe(beforeDryRun);
          expect(yield* fileSystem.exists(cursorDestination)).toBe(true);
          const applied = successfulEnvelope(
            yield* hostTack(fixture, ["adapter", "disable", "cursor", "--apply"]),
          );
          expect(applied.plan).toEqual(dryRun.plan);
          expect(dryRun.next).toEqual(["tack adapter disable cursor --apply"]);
          expect(applied.next).toEqual(["tack status --all"]);
          expect(yield* fileSystem.exists(cursorDestination)).toBe(false);
          expect(yield* fileSystem.exists(codexDestination)).toBe(true);
          expect(yield* fileSystem.exists(path.dirname(cursorDestination))).toBe(true);
          expect(yield* fileSystem.exists(path.dirname(codexDestination))).toBe(true);
          expect(successfulEnvelope(yield* hostTack(fixture, ["adapter", "list"])).result).toEqual({
            kind: "adapters",
            enabledAdapters: ["codex"],
          });

          // A sync override only narrows the enabled adapters, so it cannot revive a disabled one.
          const revived = yield* hostTack(
            fixture,
            reconcileProject(["--adapter", "cursor", "--apply"]),
          );
          expect(revived.exitCode).not.toBe(0);
          expect(decodeEnvelope(revived.stdout)).toMatchObject({
            diagnostics: [{ code: "adapter-not-enabled" }],
          });
          expect(yield* fileSystem.exists(cursorDestination)).toBe(false);
          expect(successfulEnvelope(yield* hostTack(fixture, ["adapter", "list"])).result).toEqual({
            kind: "adapters",
            enabledAdapters: ["codex"],
          });
        }),
      ),
    { timeout: 20_000 },
  );

  maintenanceIt.effect(
    "disables an adapter from a directory outside every registered root",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const outside = fixture.homeDirectory;
          successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "cursor", "codex"]));
          successfulEnvelope(yield* hostTack(fixture, reconcileProject(["--apply"])));
          const cursorDestination = adapterDestination("cursor", fixture.primaryRoot, path);
          expect(yield* fileSystem.exists(cursorDestination)).toBe(true);

          const dryRun = successfulEnvelope(
            yield* hostTack(fixture, ["adapter", "disable", "cursor"], outside),
          );
          const applied = successfulEnvelope(
            yield* hostTack(fixture, ["adapter", "disable", "cursor", "--apply"], outside),
          );

          expect(applied.plan).toEqual(dryRun.plan);
          expect(yield* fileSystem.exists(cursorDestination)).toBe(false);
          expect(
            successfulEnvelope(yield* hostTack(fixture, ["adapter", "list"], outside)).result,
          ).toEqual({ kind: "adapters", enabledAdapters: ["codex"] });
        }),
      ),
    { timeout: 20_000 },
  );

  maintenanceIt.effect(
    "disables Cursor after it links both commands and skills into a project root",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          // The command sorts after the "valid" skill by name but before it by resource kind.
          yield* fileSystem.makeDirectory(path.join(fixture.sourceDirectory, "commands"));
          yield* fileSystem.writeFileString(
            path.join(fixture.sourceDirectory, "commands", "write.md"),
            "# Write\n",
          );
          yield* fileSystem.writeFileString(
            path.join(fixture.sourceDirectory, "tack.yaml"),
            "version: 1\nname: source\nskills:\n  - path: skills\ncommands:\n  - path: commands\n",
          );
          successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "cursor"]));
          successfulEnvelope(yield* hostTack(fixture, reconcileProject(["--apply"])));
          const commandDestination = path.join(
            fixture.primaryRoot,
            ".cursor",
            "commands",
            "write.md",
          );
          const skillDestination = adapterDestination("cursor", fixture.primaryRoot, path);
          expect(yield* fileSystem.exists(commandDestination)).toBe(true);
          expect(yield* fileSystem.exists(skillDestination)).toBe(true);

          const dryRun = successfulEnvelope(
            yield* hostTack(fixture, ["adapter", "disable", "cursor"]),
          );
          const applied = successfulEnvelope(
            yield* hostTack(fixture, ["adapter", "disable", "cursor", "--apply"]),
          );

          expect(applied.plan).toEqual(dryRun.plan);
          expect(yield* fileSystem.exists(commandDestination)).toBe(false);
          expect(yield* fileSystem.exists(skillDestination)).toBe(false);
          expect(successfulEnvelope(yield* hostTack(fixture, ["adapter", "list"])).result).toEqual({
            kind: "adapters",
            enabledAdapters: [],
          });
        }),
      ),
    { timeout: 20_000 },
  );

  maintenanceIt.effect(
    "cleans verified links while preserving configuration and lets reconcile restore them",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "cursor", "codex"]));
          successfulEnvelope(yield* hostTack(fixture, reconcileProject(["--apply"])));
          const codexDestination = adapterDestination("codex", fixture.primaryRoot, path);
          const cursorDestination = adapterDestination("cursor", fixture.primaryRoot, path);
          const codexSentinel = path.join(path.dirname(codexDestination), "operator.txt");
          const cursorSentinel = path.join(path.dirname(cursorDestination), "operator.txt");
          const dotenvPath = path.join(fixture.stateDirectory, ".env");
          const sourceSkillPath = path.join(fixture.sourceDirectory, "skills", "valid", "SKILL.md");
          yield* fileSystem.writeFileString(codexSentinel, "codex operator content\n");
          yield* fileSystem.writeFileString(cursorSentinel, "cursor operator content\n");
          yield* fileSystem.writeFileString(dotenvPath, "TACK_TOKEN=operator-value\n");
          const before = yield* readState(fixture.options);
          const sourceBefore = yield* fileSystem.readFileString(sourceSkillPath);
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const beforeDryRun = yield* fileSystem.readFileString(statePath);

          const dryRun = successfulEnvelope(
            yield* hostTack(fixture, ["state", "clean", "--project", "workspace"]),
          );
          expect(yield* fileSystem.readFileString(statePath)).toBe(beforeDryRun);
          expect(yield* fileSystem.exists(codexDestination)).toBe(true);
          expect(yield* fileSystem.exists(cursorDestination)).toBe(true);
          const applied = successfulEnvelope(
            yield* hostTack(fixture, ["state", "clean", "--project", "workspace", "--apply"]),
          );
          expect(applied.plan).toEqual(dryRun.plan);
          expect(yield* fileSystem.exists(codexDestination)).toBe(false);
          expect(yield* fileSystem.exists(cursorDestination)).toBe(false);
          expect(yield* fileSystem.readFileString(codexSentinel)).toBe("codex operator content\n");
          expect(yield* fileSystem.readFileString(cursorSentinel)).toBe(
            "cursor operator content\n",
          );
          expect(yield* fileSystem.readFileString(dotenvPath)).toBe("TACK_TOKEN=operator-value\n");
          expect(yield* fileSystem.readFileString(sourceSkillPath)).toBe(sourceBefore);

          const after = yield* readState(fixture.options);
          expect(after.data.projects).toEqual(before.data.projects);
          expect(allSkillChoices(after)).toEqual(allSkillChoices(before));
          expect(after.data.enabledAdapters).toEqual(before.data.enabledAdapters);
          expect(after.data.sources).toEqual(before.data.sources);
          expect(managedLinksOf(after.data.links)).toEqual([]);

          successfulEnvelope(yield* hostTack(fixture, reconcileProject(["--apply"])));
          expect(yield* fileSystem.exists(codexDestination)).toBe(true);
          expect(yield* fileSystem.exists(cursorDestination)).toBe(true);
        }),
      ),
    { timeout: 20_000 },
  );

  maintenanceIt.effect(
    "reports destination and catalog health without repairing state",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const writeSkill = (source: string, name: string) =>
            write(path.join(source, "skills", name, "SKILL.md"), bareSkillText(name));
          yield* writeSkill(fixture.sourceDirectory, "matching");
          yield* writeSkill(fixture.sourceDirectory, "retired");
          for (const name of ["matching", "retired"]) {
            successfulEnvelope(
              yield* hostTack(fixture, ["pick", "include", name, "--project", "workspace"]),
            );
          }
          successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "cursor", "codex"]));
          successfulEnvelope(yield* hostTack(fixture, reconcileProject(["--apply"])));

          yield* writeSkill(fixture.sourceDirectory, "foreign");
          yield* writeSkill(fixture.sourceDirectory, "collision");
          yield* fileSystem.makeDirectory(
            path.join(fixture.sourceDirectory, "skills", "quarantined"),
            {
              recursive: true,
            },
          );
          yield* fileSystem.writeFileString(
            path.join(fixture.sourceDirectory, "skills", "quarantined", "SKILL.md"),
            "missing frontmatter\n",
          );
          const alternateSource = path.join(
            path.dirname(fixture.sourceDirectory),
            "alternate-source",
          );
          yield* fileSystem.makeDirectory(alternateSource, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(alternateSource, "tack.yaml"),
            "version: 1\nname: alternate-source\nskills:\n  - path: skills\n",
          );
          yield* writeSkill(alternateSource, "collision");
          successfulEnvelope(
            yield* hostTack(fixture, ["source", "add", alternateSource, "--apply"]),
          );
          const unhealthySource = path.join(
            path.dirname(fixture.sourceDirectory),
            "unhealthy-source",
          );
          yield* fileSystem.makeDirectory(unhealthySource, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(unhealthySource, "tack.yaml"),
            "version: 1\nname: unhealthy-source\nskills:\n  - path: skills\n",
          );
          yield* writeSkill(unhealthySource, "gone");
          successfulEnvelope(
            yield* hostTack(fixture, ["source", "add", unhealthySource, "--apply"]),
          );
          yield* fileSystem.remove(unhealthySource, { recursive: true });

          for (const name of ["foreign"]) {
            successfulEnvelope(
              yield* hostTack(fixture, ["pick", "include", name, "--project", "workspace"]),
            );
          }
          successfulEnvelope(
            yield* hostTack(fixture, ["pick", "exclude", "retired", "--project", "workspace"]),
          );

          const codexDirectory = path.join(fixture.primaryRoot, ".agents", "skills");
          const cursorDirectory = path.join(fixture.primaryRoot, ".cursor", "skills");
          const codexValid = path.join(codexDirectory, "valid");
          const cursorValid = path.join(cursorDirectory, "valid");
          const codexForeign = path.join(codexDirectory, "foreign");
          const foreignTarget = path.join(path.dirname(fixture.sourceDirectory), "foreign-target");
          yield* fileSystem.makeDirectory(foreignTarget, { recursive: true });
          yield* fileSystem.remove(codexValid);
          yield* fileSystem.symlink(path.relative(codexDirectory, foreignTarget), codexValid);
          yield* fileSystem.remove(cursorValid);
          yield* fileSystem.writeFileString(codexForeign, "foreign entry\n");
          yield* Effect.forEach(
            [path.join(codexDirectory, "retired"), path.join(cursorDirectory, "retired")],
            (destination) => fileSystem.remove(destination),
          );

          const statePath = path.join(fixture.stateDirectory, "state.json");
          const before = yield* fileSystem.readFileString(statePath);
          const status = partialEnvelope(
            yield* hostTack(fixture, ["status", "--project", "workspace"]),
          );
          expect(yield* fileSystem.readFileString(statePath)).toBe(before);
          // `next` is the list the text view prints under Next: commands, with no registration IDs.
          expect(status.next).toEqual(
            expect.arrayContaining(["tack sync --project workspace", "tack catalog"]),
          );
          expect(JSON.stringify(status.next)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
          const result = Schema.decodeUnknownSync(StatusPayloadSchema)(status.result);
          expect(result.destinations.map((destination) => destination["_tag"])).toEqual(
            expect.arrayContaining([
              "drift",
              "evidence-absent",
              "expected-absent",
              "hand-made",
              "matching",
              "selection-conflict",
            ]),
          );
          // Status counts the catalog; `catalog` lists its resources and issues.
          expect(result.catalog).toEqual({
            quarantined: 1,
            resources: expect.any(Number),
            unavailable: 1,
          });
          expect(result["sources"]).toEqual(
            expect.arrayContaining([expect.objectContaining({ status: "unhealthy" })]),
          );
        }),
      ),
    { timeout: 20_000 },
  );
});
