import { projectSourcesSkillName } from "../src/domain/generated/sources-skill.ts";
import { skillText } from "./support/source-tree.ts";
import { encodeBundle, makeBundleManifest } from "../src/domain/bundles/bundle-codec.ts";
import { registerSource } from "../src/features/sources/source.ts";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { profileFixture } from "./support/profile-fixture.ts";
import { initializeState, readState } from "../src/services/state-store.ts";
import { mutateStateFixture, stateOptionsAt } from "./support/state-fixture.ts";
import { runBundleExport, inspectBundle } from "../src/features/profiles/bundle-export.ts";
import { runBundleApply } from "../src/features/profiles/bundle-apply.ts";
import { runSyncCommand } from "../src/features/reconciliation/sync-command.ts";
import { readInvocationSnapshot } from "../src/features/snapshot/command-snapshot.ts";
import { collectProfileInput } from "../src/features/profiles/profile-copy.ts";
import { nodeGzip } from "../src/platform/compression/compression.ts";

it.layer(LiveTestLayer)("content-only profile bundles", (test) => {
  test.effect(
    "preserves nested context identities while excluding support files from resource discovery",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, options, write } = yield* profileFixture;
        yield* write(
          "source/tack.yaml",
          "version: 1\nname: tools\ncontext: [{path: context}]\nprofiles: [{name: ci, path: ci.yaml}]\nbundle-support: [{kind: context, name: nested/guide.md, complete: true, files: [context/nested/support.md], prerequisites: []}]\n",
        );
        yield* write(
          "source/ci.yaml",
          "version: 1\nname: ci\nmembers: [nested/guide.md, nested/other.md]\n",
        );
        yield* write("source/context/nested/guide.md", "Guide");
        yield* write("source/context/nested/other.md", "Other");
        yield* write("source/context/nested/support.md", "Supporting content");
        const file = path.join(root, "context.tar.gz");
        const exported = yield* runBundleExport(options, {
          reference: "tools:ci",
          output: file,
          apply: true,
        });
        expect(exported.exported, JSON.stringify(exported.plan.findings)).toBe(true);
        const archive = yield* inspectBundle(file);
        expect(
          archive.manifest.sources[0]?.resources.map((resource) => resource.name).sort(),
        ).toEqual(["nested/guide.md", "nested/other.md"]);
        expect(archive.manifest.files.some((entry) => entry.path.endsWith("support.md"))).toBe(
          true,
        );
        expect(yield* fs.exists(file)).toBe(true);
      }),
  );
  test.effect(
    "checks projection meaning offline and refuses a digest-consistent misleading inventory before mutation",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, options, request, run } = yield* profileFixture;
        const file = path.join(root, "honest.tar.gz");
        yield* runBundleExport(options, { reference: "tools:ci", output: file, apply: true });
        const archive = yield* inspectBundle(file);
        const { identity: _identity, ...content } = archive.manifest;
        const changed = makeBundleManifest({
          ...content,
          sources: content.sources.map((source) => ({
            ...source,
            resources: source.resources.map((resource) => ({ ...resource, direct: false })),
          })),
        });
        const misleading = path.join(root, "misleading.tar.gz");
        yield* fs.writeFile(misleading, encodeBundle(nodeGzip, changed, archive.entries));
        expect((yield* Effect.result(inspectBundle(misleading)))["_tag"]).toBe("Failure");
        const before = yield* readState(options);
        expect(
          (yield* run(runBundleApply(options, { ...request, file: misleading }))).plan.refused,
        ).toBe(true);
        expect(yield* readState(options)).toEqual(before);
        expect(yield* fs.exists(path.join(options.stateDirectory, "bundles"))).toBe(false);
      }),
  );
  test.effect(
    "refuses shared boundaries and exclusions before retaining or registering incoming projections",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, options, request, run, sourceId } = yield* profileFixture;
        const file = path.join(root, "guard.tar.gz");
        expect(
          (yield* runBundleExport(options, { reference: "tools:ci", output: file, apply: true }))
            .exported,
        ).toBe(true);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: state.data.projects.map((project) => ({
              ...project,
              choices: [
                {
                  address: { kind: "skill", name: "review", sourceRegistrationId: sourceId },
                  decision: "exclude",
                },
              ],
            })),
          },
        }));
        const before = yield* readState(options);
        expect(
          (yield* run(runBundleApply(options, { ...request, file }))).plan.findings[0]?.code,
        ).toBe("profile-existing-selection");
        expect(yield* readState(options)).toEqual(before);
        expect(yield* fs.exists(path.join(options.stateDirectory, "bundles"))).toBe(false);
        yield* fs.makeDirectory(path.join(root, "second"));
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: state.data.projects.map((project) => ({
              ...project,
              roots: [...project.roots, path.join(root, "second")].sort(),
            })),
          },
        }));
        expect(
          (yield* run(runBundleApply(options, { ...request, file, force: true }))).plan.findings[0]
            ?.code,
        ).toBe("profile-target-boundary");
        expect(yield* fs.exists(path.join(options.stateDirectory, "bundles"))).toBe(false);
        yield* fs.makeDirectory(path.join(root, "other-home"));
        const escaped = stateOptionsAt(options.stateDirectory, root);
        const shared = yield* run(
          runBundleApply(escaped, {
            ...request,
            file,
            namespace: { _tag: "user" },
            targetRoots: [],
            targetHome: path.join(root, "other-home"),
            force: true,
          }),
        );
        expect(shared.plan.refused).toBe(true);
        expect((yield* readState(options)).data.sources).toEqual(before.data.sources);
      }),
  );
  test.effect("protects foreign payload paths and changed retained mappings even with force", () =>
    Effect.gen(function* () {
      const { fs, path, root, options, request, run } = yield* profileFixture;
      const file = path.join(root, "identity.tar.gz");
      yield* runBundleExport(options, { reference: "tools:ci", output: file, apply: true });
      const { manifest } = yield* inspectBundle(file);
      const payload = path.join(options.stateDirectory, "bundles", manifest.identity);
      yield* fs.makeDirectory(payload, { recursive: true });
      yield* fs.writeFileString(path.join(payload, "sentinel"), "foreign");
      const before = yield* readState(options);
      expect(
        (yield* run(runBundleApply(options, { ...request, file, force: true }))).plan.findings[0]
          ?.code,
      ).toBe("profile-bundle-identity");
      expect(yield* readState(options)).toEqual(before);
      expect(yield* fs.readFileString(path.join(payload, "sentinel"))).toBe("foreign");
      // Move the foreign directory away; the worker never deletes a computed path.
      yield* fs.rename(payload, payload + "-foreign");
      expect((yield* run(runBundleApply(options, { ...request, file }))).plan.refused).toBe(false);
      const applied = yield* readState(options);
      const registration = applied.data.sources.find((source) => source.bundle !== undefined);
      if (registration === undefined) throw new Error("Missing bundle projection");
      yield* fs.writeFileString(
        path.join(registration.canonicalPath, "skills/review/SKILL.md"),
        "changed",
      );
      const changed = yield* run(runBundleApply(options, { ...request, file, force: true }));
      expect(changed.plan.findings[0]?.code).toBe("profile-bundle-identity");
      expect(yield* readState(options)).toEqual(applied);
      const sync = yield* run(
        runSyncCommand(options, {
          apply: true,
          cwd: request.cwd,
          includeOptional: false,
          noDocs: false,
          selector: request.namespace,
        }),
      );
      expect(sync.plan.resources?.causes.map((cause) => cause.code)).toContain(
        "profile-inventory-unresolved",
      );
    }),
  );
  test.effect(
    "keeps newer originals distinct and maps cross-source required dependencies entirely to bundled bytes",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, options, request, run, write, sourceId } = yield* profileFixture;
        yield* write("team/tack.yaml", "version: 1\nname: team\nskills: [{path: skills}]\n");
        yield* write(
          "team/skills/lint/SKILL.md",
          skillText("lint", { description: "Exported lint", body: "Frozen lint" }),
        );
        yield* registerSource(options, { sourcePath: path.join(root, "team") });
        yield* write(
          "source/tack.yaml",
          "version: 1\nname: tools\ndepends-on: [team]\nskills: [{path: skills}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
        );
        yield* write(
          "source/skills/review/SKILL.md",
          skillText("review", {
            description: "Review",
            tack: ["dependencies:", "  - kind: skill", "    name: lint", "    source: team"],
            body: "Frozen review",
          }),
        );
        yield* write(
          "source/ci.yaml",
          "version: 1\nname: ci\ndepends-on: [team]\nmembers: [review, {kind: skill, name: lint, source: team}]\n",
        );
        const file = path.join(root, "cross.tar.gz");
        const exported = yield* runBundleExport(options, {
          reference: "tools:ci",
          output: file,
          apply: true,
        });
        expect(exported.exported, JSON.stringify(exported.plan.findings)).toBe(true);
        const originals = (yield* readState(options)).data.sources;
        yield* write(
          "source/skills/review/SKILL.md",
          skillText("review", { description: "Newer review", body: "NEWER" }),
        );
        yield* write(
          "team/skills/lint/SKILL.md",
          skillText("lint", { description: "Newer lint", body: "NEWER" }),
        );
        const result = yield* run(runBundleApply(options, { ...request, file }));
        expect(result.plan.refused, JSON.stringify(result.plan.findings)).toBe(false);
        expect(
          (yield* readState(options)).data.sources.filter((source) => source.bundle === undefined),
        ).toEqual(originals);
        const review = yield* fs.realPath(
          path.join(request.targetRoots[0], ".agents/skills/review"),
        );
        expect(yield* fs.readFileString(path.join(review, "SKILL.md"))).toContain("Frozen review");
        const state = yield* readState(options);
        expect(
          state.data.profileApplications?.[0]?.inventory.every(
            (address) => address.sourceRegistrationId !== sourceId,
          ),
        ).toBe(true);
        yield* fs.rename(path.join(root, "team"), path.join(root, "unavailable-team"));
        yield* run(
          runSyncCommand(options, {
            apply: true,
            cwd: request.cwd,
            includeOptional: false,
            noDocs: false,
            selector: request.namespace,
          }),
        );
        expect(
          yield* fs.readFileString(
            path.join(request.targetRoots[0], ".agents/skills/lint/SKILL.md"),
          ),
        ).toContain("Frozen lint");
      }),
  );
  test.effect("requires inspectable script/docs support and never executes supplied modules", () =>
    Effect.gen(function* () {
      const { fs, path, root, options, request, run, write } = yield* profileFixture;
      yield* write(
        "source/tack.yaml",
        "version: 1\nname: tools\ncontext: [{path: context.md}]\nscripts: [{name: danger, path: danger.ts, description: Never run}]\ndocs: [{name: guide, path: docs, reader: {components: {module: component.tsx}}}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
      );
      yield* write(
        "source/ci.yaml",
        "version: 1\nname: ci\nmembers: [danger, guide, context.md]\n",
      );
      yield* write("source/context.md", "Context");
      yield* write("source/danger.ts", "import './helper.ts'; throw new Error('never run');");
      yield* write("source/helper.ts", "throw new Error('never run helper');");
      yield* write("source/docs/guide.md", "# Guide\n![Diagram](../diagram.svg)\n");
      yield* write("source/diagram.svg", "<svg/>");
      yield* write(
        "source/component.tsx",
        "throw new Error('never run reader component'); export default {};",
      );
      const file = path.join(root, "mixed.tar.gz");
      const requestExport = { reference: "tools:ci", output: file, apply: false };
      expect(
        (yield* runBundleExport(options, requestExport)).plan.findings.some(
          (finding) => finding.code === "profile-bundle-incomplete",
        ),
      ).toBe(true);
      const declaration = yield* fs.readFileString(path.join(root, "source/tack.yaml"));
      yield* write(
        "source/tack.yaml",
        declaration +
          "bundle-support:\n  - {kind: script, name: danger, complete: true, files: [], prerequisites: [Bun], package: none}\n  - {kind: docs, name: guide, complete: true, files: [], prerequisites: []}\n",
      );
      const missing = yield* runBundleExport(options, requestExport);
      expect(missing.plan.findings.map((finding) => finding.message).join(" ")).toContain(
        "helper.ts",
      );
      expect(missing.plan.findings.map((finding) => finding.message).join(" ")).toContain(
        "component.tsx",
      );
      expect(missing.plan.findings.map((finding) => finding.message).join(" ")).toContain(
        "diagram.svg",
      );
      yield* write(
        "source/tack.yaml",
        declaration +
          "bundle-support:\n  - {kind: script, name: danger, complete: true, files: [helper.ts], prerequisites: [Bun], package: none}\n  - {kind: docs, name: guide, complete: true, files: [component.tsx, diagram.svg], prerequisites: []}\n",
      );
      const exported = yield* runBundleExport(options, { ...requestExport, apply: true });
      expect(exported.exported, JSON.stringify(exported.plan.findings)).toBe(true);
      const applied = yield* run(runBundleApply(options, { ...request, file }));
      expect(applied.plan.refused, JSON.stringify(applied.plan.findings)).toBe(false);
      expect(applied.plan.delivery.notes.join(" ")).toContain("never executed");
      expect(yield* fs.exists(path.join(request.targetRoots[0], ".tack/docs"))).toBe(true);
    }),
  );
  test.effect(
    "exports only direct/required current bytes, then applies offline unforced with fresh retained registrations",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, options, request, run, source, write } = yield* profileFixture;
        yield* write("source/skills/review/support.txt", "current local edit");
        const file = path.join(root, "ci.tar.gz");
        const originalState = yield* readState(options);
        const preview = yield* runBundleExport(options, {
          reference: "tools:ci",
          output: file,
          apply: false,
        });
        expect(preview.plan.findings).toEqual([]);
        expect(yield* fs.exists(file)).toBe(false);
        expect(
          (yield* runBundleExport(options, { reference: "tools:ci", output: file, apply: true }))
            .exported,
        ).toBe(true);
        const checked = yield* inspectBundle(file);
        expect(checked.manifest.sources).toHaveLength(1);
        const json = JSON.stringify(checked.manifest);
        expect(json).not.toContain(source);
        expect(json).not.toContain((yield* readState(options)).data.sources[0]?.id);
        expect(json).not.toContain("notes");
        expect(checked.manifest.files.some((entry) => entry.path.endsWith("support.txt"))).toBe(
          true,
        );
        const home = path.join(root, "recipient-home");
        yield* fs.makeDirectory(home);
        const recipient = stateOptionsAt(path.join(home, "state"), home);
        yield* initializeState(recipient);
        yield* mutateStateFixture(recipient, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: originalState.data.projects,
            enabledAdapters: ["codex"],
          },
        }));
        yield* fs.rename(source, path.join(root, "offline-original"));
        const applied = yield* run(runBundleApply(recipient, { file, ...request, apply: true }));
        expect(applied.plan.findings).toEqual([]);
        expect(applied.applied).toBeDefined();
        const state = yield* readState(recipient);
        expect(state.data.sources).toHaveLength(1);
        expect(state.data.sources[0]?.bundle?.identity).toBe(checked.manifest.identity);
        expect(
          state.data.profileApplications?.[0]?.inventory.map((address) => address.name).sort(),
        ).toEqual(["review", "style"]);
        const link = path.join(request.targetRoots[0], ".agents/skills/review");
        expect(yield* fs.realPath(link)).toContain("/bundles/");
        expect(yield* fs.readFileString(path.join(link, "support.txt"))).toBe("current local edit");
        expect(
          (yield* run(runBundleApply(recipient, { file, ...request, apply: true }))).plan.refused,
        ).toBe(true);
        const forced = yield* run(
          runBundleApply(recipient, { file, ...request, force: true, apply: true }),
        );
        expect(forced.plan.refused).toBe(false);
        expect((yield* readState(recipient)).data.sources).toEqual(state.data.sources);
        const ordinary = yield* collectProfileInput(yield* readInvocationSnapshot(recipient), {
          user: true,
        });
        expect(ordinary.members).toEqual([]);
        yield* run(
          runSyncCommand(recipient, {
            apply: true,
            cwd: request.cwd,
            includeOptional: true,
            noDocs: false,
            selector: request.namespace,
          }),
        );
        expect(
          (yield* fs.readDirectory(path.join(request.targetRoots[0], ".agents/skills"))).sort(),
        ).toEqual(["review", "style", projectSourcesSkillName]);
      }),
  );
});
