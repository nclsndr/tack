import { checkPaths } from "../src/features/check/check-paths.ts";
import { readBoundedBundleFile } from "../src/features/sources/bundle-file-read.ts";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { profileFixture } from "./support/profile-fixture.ts";
import { runBundleExport, inspectBundle } from "../src/features/profiles/bundle-export.ts";
import {
  bundleDigest,
  decodeBundle,
  encodeBundle,
  makeBundleManifest,
} from "../src/domain/bundles/bundle-codec.ts";
import { bundleLimits } from "../src/domain/bundles/tar.ts";
import { filesDigest } from "../src/domain/imports/import-record.ts";
import { makeBundleFileCollector } from "../src/features/profiles/bundle-files.ts";
import type { ProfilePlanFinding } from "../src/domain/profiles/profile-schema.ts";
import { nodeGzip } from "../src/platform/compression/compression.ts";
import { registerSource } from "../src/features/sources/source.ts";
import { mutateState } from "./support/state-fixture.ts";

const lowId = "00000000-0000-4000-8000-000000000001";
const highId = "00000000-0000-4000-8000-000000000002";

it.layer(LiveTestLayer)("bundle export completeness", (test) => {
  // State keeps sources ordered by registration ID, so fixed IDs pin the order the export reads.
  test.effect.each([
    { order: "tools before team", ids: { source: lowId, team: highId } },
    { order: "team before tools", ids: { source: highId, team: lowId } },
  ])("numbers source keys by source name when state lists $order", ({ ids }) =>
    Effect.gen(function* () {
      const f = yield* profileFixture;
      yield* f.write("team/tack.yaml", "version: 2\nname: team\nskills: [{path: skills}]\n");
      yield* f.write("team/skills/lint/SKILL.md", "---\nname: lint\ndescription: Lint\n---\n");
      yield* registerSource(f.options, { sourcePath: f.path.join(f.root, "team") });
      yield* f.write(
        "source/tack.yaml",
        "version: 2\nname: tools\ndepends-on: [team]\nskills: [{path: skills}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
      );
      yield* f.write(
        "source/ci.yaml",
        "version: 1\nname: ci\ndepends-on: [team]\nmembers: [style, {kind: skill, name: lint, source: team}]\n",
      );
      yield* mutateState(f.options, (state) => ({
        ...state,
        data: {
          ...state.data,
          sources: state.data.sources.map((source) => ({
            ...source,
            id: source.canonicalPath === f.source ? ids.source : ids.team,
          })),
        },
      }));
      const output = f.path.join(f.root, "ordered.tar.gz");
      const result = yield* runBundleExport(f.options, {
        reference: "tools:ci",
        output,
        apply: true,
      });
      expect(result.exported, JSON.stringify(result.plan.findings)).toBe(true);
      const { manifest } = yield* inspectBundle(output);
      expect(
        Object.fromEntries(manifest.sources.map((source) => [source.name, source.key])),
      ).toEqual({ team: "source-0", tools: "source-1" });
      expect(manifest.profile.sourceKey).toBe("source-1");
    }),
  );
  test.effect(
    "refuses sensitive and linked support instead of reading/copying it into an artifact",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, options, write } = yield* profileFixture;
        const file = path.join(root, "unsafe.tar.gz");
        const request = { reference: "tools:ci", output: file, apply: true };
        yield* write("source/skills/review/.env", "SECRET=never export");
        const sensitive = yield* runBundleExport(options, request);
        expect(sensitive.plan.findings.map((finding) => finding.code)).toContain(
          "profile-bundle-sensitive",
        );
        expect(sensitive.exported).toBe(false);
        expect(JSON.stringify(sensitive.plan.manifest)).not.toContain("SECRET");
        expect(yield* fs.exists(file)).toBe(false);
        yield* fs.rename(
          path.join(root, "source/skills/review/.env"),
          path.join(root, "outside-env"),
        );
        yield* fs.symlink(
          path.join(root, "outside-env"),
          path.join(root, "source/skills/review/linked"),
        );
        const linked = yield* runBundleExport(options, request);
        expect(linked.exported).toBe(false);
        expect(linked.plan.findings.map((finding) => finding.message).join(" ")).toContain(
          "materialize",
        );
      }),
  );
  test.effect("bounds source reads and accumulated export inventory before allocation grows", () =>
    Effect.gen(function* () {
      const { fs, path, root, options, write } = yield* profileFixture;
      yield* write("bounded", "abcdef");
      expect(
        (yield* Effect.result(readBoundedBundleFile(path.join(root, "bounded"), 4)))["_tag"],
      ).toBe("Failure");
      const findings: ProfilePlanFinding[] = [];
      const collector = yield* makeBundleFileCollector(root, "sources/source-0/", findings, {
        bytes: bundleLimits.expandedBytes - 1,
        entries: 0,
        exhausted: false,
      });
      yield* collector.include("bounded");
      expect(findings[0]?.code).toBe("profile-bundle-limit");
      expect(collector.entries.size).toBe(0);
      yield* fs.writeFile(
        path.join(root, "source/skills/review/large"),
        new Uint8Array(bundleLimits.fileBytes + 1),
      );
      const large = yield* runBundleExport(options, {
        reference: "tools:ci",
        output: path.join(root, "large.tar.gz"),
        apply: true,
      });
      expect(large.exported).toBe(false);
      expect(large.plan.findings.map((finding) => finding.code)).toContain("profile-bundle-limit");
    }),
  );
  test.effect(
    "records included package/lock/setup facts without importing code or running hooks",
    () =>
      Effect.gen(function* () {
        const { path, root, options, write } = yield* profileFixture;
        yield* write(
          "source/tack.yaml",
          "version: 2\nname: tools\nscripts: [{name: pack, path: pack.ts, description: Pack}]\nprofiles: [{name: ci, path: ci.yaml}]\nbundle-support: [{kind: script, name: pack, complete: true, files: [package.json, bun.lock], prerequisites: [Install fixture-tool 1.0.0 explicitly]}]\n",
        );
        yield* write("source/ci.yaml", "version: 1\nname: ci\nmembers: [pack]\n");
        yield* write("source/pack.ts", "import 'fixture-tool'; throw new Error('never import');");
        yield* write(
          "source/package.json",
          JSON.stringify({
            dependencies: { "fixture-tool": "1.0.0" },
            scripts: { postinstall: "throw-never-run" },
          }),
        );
        yield* write("source/bun.lock", "actual current lock bytes");
        const file = path.join(root, "package.tar.gz");
        const result = yield* runBundleExport(options, {
          reference: "tools:ci",
          output: file,
          apply: true,
        });
        expect(result.exported, JSON.stringify(result.plan.findings)).toBe(true);
        const artifact = yield* inspectBundle(file);
        expect(artifact.manifest.files.map((entry) => entry.path)).toEqual(
          expect.arrayContaining(["sources/source-0/package.json", "sources/source-0/bun.lock"]),
        );
        expect(artifact.manifest.sources[0]?.prerequisites.join(" ")).toContain(
          "fixture-tool 1.0.0",
        );
        const occupied = yield* runBundleExport(options, {
          reference: "tools:ci",
          output: file,
          apply: true,
        });
        expect(occupied.plan.findings[0]?.code).toBe("profile-bundle-identity");
        expect(
          (yield* runBundleExport(options, {
            reference: "missing:ci",
            output: path.join(root, "missing.tar.gz"),
            apply: false,
          })).plan.refused,
        ).toBe(true);
      }),
  );
  test.effect(
    "freezes imported current bytes and preserves recorded upstream provenance as provenance",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, options, write } = yield* profileFixture;
        const files = [{ path: "SKILL.md", sha256: "0".repeat(64), executable: false }];
        const record = {
          path: "skills/review",
          location: "github:nclsndr/example",
          transport: "https",
          "ref-kind": "commit",
          revision: "a".repeat(40),
          "upstream-path": "skills/review",
          "upstream-tree": "b".repeat(40),
          "imported-at": "2026-11-14T00:00:00Z",
          digest: filesDigest(files),
          files,
        };
        yield* write(
          "source/tack.yaml",
          Bun.YAML.stringify({
            version: 2,
            name: "tools",
            skills: [{ path: "skills" }],
            profiles: [{ name: "ci", path: "ci.yaml" }],
            imports: [record],
          }),
        );
        yield* write("source/skills/review/local-edit.txt", "current local edits");
        const file = path.join(root, "imported.tar.gz");
        expect(
          (yield* runBundleExport(options, { reference: "tools:ci", output: file, apply: true }))
            .exported,
        ).toBe(true);
        const archive = yield* inspectBundle(file);
        const resource = archive.manifest.sources[0]?.resources.find(
          (entry) => entry.name === "review",
        );
        expect(resource?.provenance).toMatchObject({
          revision: "a".repeat(40),
          importedDigest: record.digest,
        });
        expect(
          archive.manifest.files.find((entry) => entry.path.endsWith("local-edit.txt"))?.sha256,
        ).toBe(bundleDigest("current local edits"));
        expect(resource?.provenance?.currentDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(yield* fs.readFileString(path.join(root, "source/tack.yaml"))).toContain(
          record.digest,
        );
      }),
  );
  test.effect(
    "refuses a Git credential store in selected resource content without creating an artifact",
    () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        yield* f.write(
          "source/skills/review/.git-credentials",
          "https://fixture-user:fixture-secret@example.invalid",
        );
        const output = f.path.join(f.root, "credentials.tar.gz");
        const result = yield* runBundleExport(f.options, {
          reference: "tools:ci",
          output,
          apply: true,
        });
        expect(result.exported).toBe(false);
        expect(result.plan.findings).toContainEqual(
          expect.objectContaining({ code: "profile-bundle-sensitive" }),
        );
        expect(yield* f.fs.exists(output)).toBe(false);
      }),
  );

  test.effect(
    "validates executable imports and document references through export and offline check",
    () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        yield* f.write(
          "source/tack.yaml",
          "version: 2\nname: tools\nskills: []\nscripts: [{name: report, path: report.ts, description: Report}]\ndocs: [{name: guide, path: docs}]\nprofiles: [{name: ci, path: ci.yaml}]\nbundle-support: [{kind: script, name: report, complete: true, files: [], prerequisites: [], package: none}, {kind: docs, name: guide, complete: true, files: [], prerequisites: []}]\n",
        );
        const cases = [
          {
            file: "source/report.ts",
            content: "const name = 'helper'; await import('./' + name);",
            member: "report",
            valid: false,
          },
          {
            file: "source/report.ts",
            content: "const name = 'helper'; require('./' + name);",
            member: "report",
            valid: false,
          },
          {
            file: "source/docs/guide.mdx",
            content: 'import "./missing.ts";\n\n# Guide\n',
            member: "guide",
            valid: false,
          },
          {
            file: "source/docs/guide.mdx",
            content: "![Diagram][diagram]\n\n[diagram]: ./missing.svg\n",
            member: "guide",
            valid: false,
          },
          {
            file: "source/docs/guide.mdx",
            content: "Use `import(moduleName)` as an API.\n\n~~~~ts\nimport(name)\n~~~~\n",
            member: "guide",
            valid: true,
          },
        ];
        for (const [index, example] of cases.entries()) {
          yield* f.write("source/ci.yaml", `version: 1\nname: ci\nmembers: [${example.member}]\n`);
          yield* f.write(example.file, example.content);
          const output = f.path.join(f.root, `syntax-${index}.tar.gz`);
          const exported = yield* runBundleExport(f.options, {
            reference: "tools:ci",
            output,
            apply: true,
          });
          expect(exported.exported, JSON.stringify(exported.plan.findings)).toBe(example.valid);
          expect(yield* f.fs.exists(output)).toBe(example.valid);
          if (example.valid === true) expect((yield* checkPaths([output])).summary.errors).toBe(0);
          else
            expect(exported.plan.findings).toContainEqual(
              expect.objectContaining({ code: "profile-bundle-incomplete" }),
            );
        }
        yield* f.write("source/docs/helper.ts", "throw new Error('must stay inert');");
        yield* f.write("source/docs/image.svg", "<svg/>");
        yield* f.write(
          "source/docs/guide.mdx",
          'import "./helper.ts";\n\n![Diagram][diagram]\n\n[diagram]: ./image.svg\n',
        );
        const output = f.path.join(f.root, "complete-syntax.tar.gz");
        expect(
          (yield* runBundleExport(f.options, { reference: "tools:ci", output, apply: true }))
            .exported,
        ).toBe(true);
        expect((yield* checkPaths([output])).summary.errors).toBe(0);
      }),
  );
  test.effect(
    "full checking rejects received bundles whose valid digests conceal missing document support",
    () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        yield* f.write(
          "source/tack.yaml",
          "version: 2\nname: tools\nskills: []\ndocs: [{name: guide, path: docs}]\nprofiles: [{name: ci, path: ci.yaml}]\nbundle-support: [{kind: docs, name: guide, complete: true, files: [], prerequisites: []}]\n",
        );
        yield* f.write("source/ci.yaml", "version: 1\nname: ci\nmembers: [guide]\n");
        yield* f.write("source/docs/guide.mdx", "# Guide\n");
        const original = f.path.join(f.root, "original.tar.gz");
        expect(
          (yield* runBundleExport(f.options, {
            reference: "tools:ci",
            output: original,
            apply: true,
          })).exported,
        ).toBe(true);
        const archive = decodeBundle(nodeGzip, yield* f.fs.readFile(original));
        const { identity: _identity, ...content } = archive.manifest;
        for (const [index, text] of [
          'import "./missing.ts";\n\n# Guide\n',
          "![Diagram][diagram]\n\n[diagram]: ./missing.svg\n",
        ].entries()) {
          const bytes = new TextEncoder().encode(text);
          const entries = archive.entries.map((entry) =>
            entry.path.endsWith("/guide.mdx") === true ? { ...entry, bytes } : entry,
          );
          const manifest = makeBundleManifest({
            ...content,
            files: content.files.map((file) =>
              file.path.endsWith("/guide.mdx") === true
                ? { ...file, size: bytes.length, sha256: bundleDigest(bytes) }
                : file,
            ),
          });
          const received = f.path.join(f.root, `received-${index}.tar.gz`);
          yield* f.fs.writeFile(received, encodeBundle(nodeGzip, manifest, entries));
          expect((yield* checkPaths([received])).findings).toContainEqual(
            expect.objectContaining({
              code: "profile-bundle-incomplete",
              message: expect.stringContaining("missing"),
            }),
          );
        }
      }),
  );
});
