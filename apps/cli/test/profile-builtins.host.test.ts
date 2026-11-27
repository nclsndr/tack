import { skillText } from "./support/source-tree.ts";
import { builtinSkillLockReason } from "../src/domain/choices/builtin.ts";
import { makeExplorerDestinations } from "../src/cli/explorer/profile-editor.ts";
import { initialExplorerState } from "../src/cli/explorer/model.ts";
import { stageChange } from "../src/cli/explorer/edit.ts";
import { makeStyle } from "../src/cli/human/style.ts";
import type { RouteServices } from "../src/cli/envelope/route-services.ts";
import type { ExplorerDestination } from "../src/cli/explorer/destination.ts";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { exitCodeForEnvelope } from "../src/cli/envelope/public-outcome.ts";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { profileFixture } from "./support/profile-fixture.ts";
import { Source } from "../src/features/sources/source.ts";
import { readState } from "../src/services/state-store.ts";
import { mutateStateFixture } from "./support/state-fixture.ts";
import { runProfileSaveSelection, runProfileAdopt } from "../src/features/profiles/profile-copy.ts";
import { checkPaths } from "../src/features/check/check-paths.ts";
import { runProfileApply } from "../src/features/profiles/profile-apply.ts";
import { runSyncCommand } from "../src/features/reconciliation/sync-command.ts";
import { runBundleExport, inspectBundle } from "../src/features/profiles/bundle-export.ts";

const fixture = Effect.gen(function* () {
  const current = yield* profileFixture;
  yield* current.write("builtins/tack.yaml", "version: 1\nname: tack\nskills: [{path: skills}]\n");
  yield* current.write(
    "builtins/skills/always-help/SKILL.md",
    skillText("always-help", { description: "Release-owned helper", body: "" }),
  );
  const builtin = {
    id: "11111111-1111-4111-8111-111111111111",
    canonicalPath: current.path.join(current.root, "builtins"),
  };
  const source = yield* Source;
  const withBuiltins = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(Source, { ...source, builtInSources: [builtin] }));
  const legacy = () =>
    current.write(
      "source/ci.yaml",
      "version: 1\nname: ci\ndepends-on: [tack]\nmembers:\n  - review\n  - {kind: skill, name: always-help, source: tack}\n  - {kind: skill, name: retired-help, source: tack}\n",
    );
  return { ...current, builtin, withBuiltins, legacy };
});

it.layer(LiveTestLayer)("release-owned profile members", (test) => {
  test.effect(
    "omits built-ins from user plus project save and explains the omission without changing ordinary intent",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write(
          "source/skills/always-help/SKILL.md",
          skillText("always-help", { description: "Ordinary authored helper", body: "" }),
        );
        yield* mutateStateFixture(f.options, (state) => ({
          ...state,
          data: {
            ...state.data,
            userChoices: [
              {
                address: { kind: "skill", name: "review", sourceRegistrationId: f.sourceId },
                decision: "include",
              },
            ],
          },
        }));
        const before = yield* readState(f.options);
        const result = yield* f.withBuiltins(
          runProfileSaveSelection(f.options, {
            input: { user: true, projectName: "ci" },
            sourcePath: f.source,
            name: "copied",
            edit: false,
            apply: true,
          }),
        );
        expect(result.saved).toBe(true);
        expect(
          result.plan.members.every((member) => member.address.sourceRegistrationId === f.sourceId),
        ).toBe(true);
        expect(result.plan.members.map((member) => member.address.name)).toContain("always-help");
        expect(result.plan).toMatchObject({
          notes: expect.arrayContaining([expect.stringContaining("Built-in skills omitted")]),
        });
        const profile = Bun.YAML.parse(
          yield* f.fs.readFileString(f.path.join(f.source, "profiles/copied.yaml")),
        );
        expect(profile).not.toHaveProperty("depends-on");
        expect(yield* readState(f.options)).toEqual(before);
      }),
  );
  test.effect(
    "adopts an older profile without release-owned picks or refusal and preserves unrelated intent",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.legacy();
        yield* mutateStateFixture(f.options, (state) => ({
          ...state,
          data: {
            ...state.data,
            userChoices: [
              {
                address: { kind: "skill", name: "notes", sourceRegistrationId: f.sourceId },
                decision: "include",
              },
            ],
          },
        }));
        const result = yield* f.withBuiltins(
          f.run(
            runProfileAdopt(f.options, {
              reference: "tools:ci",
              namespace: { _tag: "user" },
              apply: true,
              cwd: f.project,
            }),
          ),
        );
        expect(result.adopted).toBe(true);
        expect(result.plan.findings).toEqual([]);
        expect(result.plan.includes.map((address) => address.name).sort()).toEqual([
          "review",
          "style",
        ]);
        expect(result.plan.notes.join(" ")).toContain("Built-in skill always-help omitted");
        expect(result.plan.notes.join(" ")).toContain("Built-in skill retired-help omitted");
        expect(
          (yield* readState(f.options)).data.userChoices
            ?.map((choice) => choice.address.name)
            .sort(),
        ).toEqual(["notes", "review", "style"]);
        expect(yield* f.fs.exists(f.path.join(f.project, ".agents"))).toBe(false);
      }),
  );
  test.effect(
    "warns on current and retired built-in names while preserving real linkage failures and warning output",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.legacy();
        const before = yield* readState(f.options);
        const report = yield* f.withBuiltins(checkPaths([f.path.join(f.source, "ci.yaml")]));
        expect(report.summary.errors).toBe(0);
        expect(report.checks.flatMap((item) => item.details)).toEqual(
          expect.arrayContaining(["Direct members (1)", "skill tools:review"]),
        );
        expect(report.findings).toHaveLength(2);
        expect(
          report.findings.every(
            (finding) =>
              finding.severity === "warning" && finding.code === "profile-builtin-omitted",
          ),
        ).toBe(true);
        expect(yield* readState(f.options)).toEqual(before);
        const { stdout } = yield* f.withBuiltins(
          f.run(
            runHost({
              args: [
                "--state-dir",
                f.options.stateDirectory,
                "--json",
                "check",
                f.path.join(f.source, "ci.yaml"),
              ],
            }),
          ),
        );
        const envelope = decodeEnvelope(stdout);
        expect(exitCodeForEnvelope(envelope)).toBe(0);
        expect(envelope.result).toMatchObject({
          findings: expect.arrayContaining([expect.objectContaining({ severity: "warning" })]),
        });
        const file = yield* f.fs.readFileString(f.path.join(f.source, "ci.yaml"));
        yield* f.write("source/ci.yaml", file + "  - missing-ordinary\n");
        const invalid = yield* f.withBuiltins(checkPaths([f.path.join(f.source, "ci.yaml")]));
        expect(invalid.summary.errors).toBeGreaterThan(0);
        expect(invalid.findings).toContainEqual(
          expect.objectContaining({ code: "profile-member-missing", severity: "error" }),
        );
      }),
  );
  test.effect(
    "applies only controlled inventory and keeps sync stable when a normal resource requires an ambient built-in",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.legacy();
        const declaration = yield* f.fs.readFileString(f.path.join(f.source, "tack.yaml"));
        yield* f.write("source/tack.yaml", declaration + "depends-on: [tack]\n");
        const skill = yield* f.fs.readFileString(f.path.join(f.source, "skills/review/SKILL.md"));
        yield* f.write(
          "source/skills/review/SKILL.md",
          skill.replace(
            "      - kind: skill",
            "      - {kind: skill, name: always-help, source: tack}\n      - kind: skill",
          ),
        );
        const result = yield* f.withBuiltins(f.run(runProfileApply(f.options, f.request)));
        expect(result.plan.refused).toBe(false);
        expect(result.plan.application?.inventory.map((address) => address.name).sort()).toEqual([
          "review",
          "style",
        ]);
        expect(result.plan.delivery.notes.join(" ")).toContain(
          "Built-in skill always-help omitted",
        );
        const sync = yield* f.withBuiltins(
          f.run(
            runSyncCommand(f.options, {
              apply: true,
              cwd: f.project,
              includeOptional: false,
              noDocs: false,
              selector: f.request.namespace,
            }),
          ),
        );
        expect(sync.plan.resources?.causes).toEqual([]);
        expect(
          (yield* f.fs.readDirectory(f.path.join(f.project, ".agents/skills"))).sort(),
        ).toEqual(["review", "style"]);
      }),
  );
  test.effect(
    "exports a legacy manifest without copying ambient release skills and checks it with recipient built-ins",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.legacy();
        const declaration = yield* f.fs.readFileString(f.path.join(f.source, "tack.yaml"));
        yield* f.write("source/tack.yaml", declaration + "depends-on: [tack]\n");
        const skill = yield* f.fs.readFileString(f.path.join(f.source, "skills/review/SKILL.md"));
        yield* f.write(
          "source/skills/review/SKILL.md",
          skill.replace(
            "      - kind: skill",
            "      - {kind: skill, name: always-help, source: tack}\n      - kind: skill",
          ),
        );
        const file = f.path.join(f.root, "legacy.tar.gz");
        const exported = yield* f.withBuiltins(
          runBundleExport(f.options, { reference: "tools:ci", output: file, apply: true }),
        );
        expect(exported.exported, JSON.stringify(exported.plan.findings)).toBe(true);
        expect(exported.plan.manifest?.sources.map((source) => source.name)).toEqual(["tools"]);
        const archive = yield* f.withBuiltins(inspectBundle(file));
        expect(
          archive.manifest.sources
            .flatMap((source) => source.resources)
            .map((resource) => resource.name)
            .sort(),
        ).toEqual(["review", "style"]);
        expect(archive.manifest.files.some((entry) => entry.path.includes("always-help"))).toBe(
          false,
        );
      }),
  );
  test.effect(
    "keeps save successful when required release-owned dependencies produce warnings",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const declaration = yield* f.fs.readFileString(f.path.join(f.source, "tack.yaml"));
        yield* f.write("source/tack.yaml", declaration + "depends-on: [tack]\n");
        const skill = yield* f.fs.readFileString(f.path.join(f.source, "skills/review/SKILL.md"));
        yield* f.write(
          "source/skills/review/SKILL.md",
          skill.replace(
            "      - kind: skill",
            "      - {kind: skill, name: always-help, source: tack}\n      - kind: skill",
          ),
        );
        yield* mutateStateFixture(f.options, (state) => ({
          ...state,
          data: {
            ...state.data,
            userChoices: [
              {
                address: { kind: "skill", name: "review", sourceRegistrationId: f.sourceId },
                decision: "include",
              },
            ],
          },
        }));
        const saved = yield* f.withBuiltins(
          runProfileSaveSelection(f.options, {
            input: { user: true, projectName: "ci" },
            sourcePath: f.source,
            name: "ambient",
            edit: false,
            apply: true,
          }),
        );
        expect(saved.saved).toBe(true);
        expect(saved.plan.findings).toEqual([]);
        expect(
          saved.plan.members.every(
            (member) => member.address.sourceRegistrationId !== f.builtin.id,
          ),
        ).toBe(true);
      }),
  );
  test.effect(
    "ordinary, profile and copy browse preserve built-in locks while an ordinary same-name skill remains editable",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write(
          "source/skills/always-help/SKILL.md",
          skillText("always-help", { description: "Ordinary authored helper", body: "" }),
        );
        const before = yield* readState(f.options);
        yield* f.withBuiltins(
          f.run(
            Effect.gen(function* () {
              const destinations = yield* makeExplorerDestinations({
                stateOptions: f.options,
                cwd: f.project,
                style: makeStyle({ color: false, width: 120, homeDirectory: f.home }),
                context: yield* Effect.context<RouteServices>(),
              });
              const targets: ReadonlyArray<ExplorerDestination> = [
                { _tag: "project", projectName: "ci" },
                { _tag: "profile", sourcePath: f.source, profileName: "ci", create: false },
                { _tag: "copy", input: { user: true, projectName: "ci" } },
              ];
              for (const destination of targets) {
                const opened = yield* destinations.open(
                  initialExplorerState("Tack", []),
                  destination,
                );
                const locked = opened.state.entries.find(
                  (entry) => entry.address?.sourceRegistrationId === f.builtin.id,
                );
                const ordinary = opened.state.entries.find(
                  (entry) =>
                    entry.address?.sourceRegistrationId === f.sourceId &&
                    entry.address.name === "always-help",
                );
                if (
                  opened.editor === undefined ||
                  opened.state.edit === undefined ||
                  locked === undefined ||
                  ordinary === undefined
                )
                  throw new Error("Missing editor fixture");
                expect(locked.editable).toEqual({ kind: "builtin" });
                const refused = stageChange(
                  opened.state.edit,
                  locked.id,
                  locked.editable,
                  "include",
                );
                expect(refused.pending.size).toBe(0);
                expect(refused.notice).toBe(builtinSkillLockReason);
                const adjusted = stageChange(
                  refused,
                  ordinary.id,
                  ordinary.editable,
                  ordinary.editable?.kind === "member" && ordinary.editable.included === true
                    ? "exclude"
                    : "include",
                );
                expect(adjusted.pending.size).toBe(1);
                expect(adjusted.notice).toBeUndefined();
                if (destination["_tag"] === "profile") {
                  const changes = [
                    ...adjusted.pending.values(),
                    {
                      kind: "member" as const,
                      address: {
                        kind: "skill" as const,
                        name: "always-help",
                        sourceRegistrationId: f.builtin.id,
                      },
                      included: true,
                    },
                  ];
                  expect((yield* opened.editor.preview(changes)).join("\n")).not.toContain(
                    "Cannot resolve portable member",
                  );
                  expect((yield* opened.editor.apply(changes)).lines.join("\n")).toContain(
                    "Saved profile ci",
                  );
                } else if (destination["_tag"] === "copy") {
                  expect(
                    (yield* opened.editor.apply([...adjusted.pending.values()])).nextState
                      ?.destinationMenu?.phase,
                  ).toBe("choose");
                }
              }
            }),
          ),
        );
        expect(yield* readState(f.options)).toEqual(before);
      }),
  );
});
