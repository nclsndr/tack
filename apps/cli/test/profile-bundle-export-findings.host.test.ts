import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { profileFixture } from "./support/profile-fixture.ts";
import { inspectBundle, runBundleExport } from "../src/features/profiles/bundle-export.ts";
import { registerSource } from "../src/features/sources/source.ts";

/** Exports tools:ci to a fresh file and reports whether it was written and the findings. */
const exportCi = (f: Effect.Success<typeof profileFixture>, name: string) =>
  Effect.gen(function* () {
    const output = f.path.join(f.root, `${name}.tar.gz`);
    const result = yield* runBundleExport(f.options, {
      reference: "tools:ci",
      output,
      apply: true,
    });
    return {
      output,
      exported: result.exported,
      written: yield* f.fs.exists(output),
      findings: result.plan.findings,
    };
  });

it.layer(LiveTestLayer)("bundle export findings", (test) => {
  test.effect(
    "an unreadable bundle-support declaration refuses the export, naming the source",
    () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        yield* f.write(
          "source/tack.yaml",
          "version: 1\nname: tools\nskills: [{path: skills}]\nprofiles: [{name: ci, path: ci.yaml}]\nbundle-support: [{kind: skill, name: review}]\n",
        );
        expect(yield* exportCi(f, "support")).toMatchObject({
          exported: false,
          written: false,
          findings: [
            {
              code: "profile-bundle-incomplete",
              message:
                "tools: repair bundle-support entries (kind/name, complete: true, files, prerequisites, optional package: none).",
            },
          ],
        });
      }),
  );

  test.effect(
    "a script with a secret-looking prerequisite and no package facts is refused for both",
    () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        yield* f.write(
          "source/tack.yaml",
          "version: 1\nname: tools\nscripts: [{name: pack, path: pack.ts, description: Pack}]\nprofiles: [{name: ci, path: ci.yaml}]\nbundle-support: [{kind: script, name: pack, complete: true, files: [], prerequisites: ['token: abc']}]\n",
        );
        yield* f.write("source/ci.yaml", "version: 1\nname: ci\nmembers: [pack]\n");
        yield* f.write("source/pack.ts", "console.log('never run');\n");
        expect(yield* exportCi(f, "script")).toMatchObject({
          exported: false,
          written: false,
          findings: [
            {
              code: "profile-bundle-sensitive",
              message: "pack: prerequisites must describe setup without secret values.",
            },
            {
              code: "profile-bundle-incomplete",
              message:
                "pack: include package.json and lock information, or explicitly declare package: none for a self-contained script.",
            },
          ],
        });
      }),
  );

  test.effect("a dependency named by a machine-local registration ID is not portable", () =>
    Effect.gen(function* () {
      const f = yield* profileFixture;
      yield* f.write(
        "source/skills/review/SKILL.md",
        `---\nname: review\ndescription: Review\nmetadata:\n  tack: |\n    version: 1\n    dependencies:\n      - kind: skill\n        name: style\n        source: ${f.sourceId}\n---\n`,
      );
      expect(yield* exportCi(f, "uuid")).toMatchObject({
        exported: false,
        written: false,
        findings: [
          {
            code: "profile-bundle-incomplete",
            message:
              "review: replace machine-local dependency UUIDs with portable source names before export.",
          },
        ],
      });
    }),
  );

  test.effect(
    "a command and docs with a reader file export together, once the reader settings parse",
    () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        yield* f.write(
          "source/tack.yaml",
          "version: 1\nname: tools\ncommands: [{path: commands}]\ndocs: [{name: guide, path: docs, reader: guide.reader.yaml}]\nprofiles: [{name: ci, path: ci.yaml}]\nbundle-support: [{kind: docs, name: guide, complete: true, files: [], prerequisites: []}]\n",
        );
        yield* f.write("source/ci.yaml", "version: 1\nname: ci\nmembers: [lint, guide]\n");
        yield* f.write("source/commands/lint.md", "---\ndescription: Lint\n---\nLint it.\n");
        yield* f.write("source/docs/guide.md", "# Guide\n");
        yield* f.write("source/guide.reader.yaml", "title: [broken\n");
        expect(yield* exportCi(f, "broken-reader")).toMatchObject({
          exported: false,
          written: false,
          findings: [
            {
              code: "profile-bundle-incomplete",
              message: "Repair data-only reader settings at guide.reader.yaml.",
            },
          ],
        });
        yield* f.write("source/guide.reader.yaml", "title: Guide\n");
        const repaired = yield* exportCi(f, "reader");
        expect(repaired).toMatchObject({ exported: true, written: true, findings: [] });
        const archive = yield* inspectBundle(repaired.output);
        expect(archive.manifest.files.map((file) => file.path)).toEqual([
          "sources/source-0/ci.yaml",
          "sources/source-0/commands",
          "sources/source-0/commands/lint.md",
          "sources/source-0/docs",
          "sources/source-0/docs/guide.md",
          "sources/source-0/guide.reader.yaml",
          "sources/source-0/tack.yaml",
        ]);
        expect(
          archive.manifest.sources[0]?.resources.map((resource) => [resource.kind, resource.name]),
        ).toEqual([
          ["command", "lint"],
          ["docs", "guide"],
        ]);
      }),
  );

  test.effect(
    "a docs entry at . exports with its folder, without tool state or nested sources",
    () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        yield* f.write(
          "notes/tack.yaml",
          "version: 1\nname: notes\ndocs: [{name: notes, path: ., reader: notes.reader.yaml}]\n",
        );
        yield* f.write("notes/notes.reader.yaml", "navigation: {preset: folders}\n");
        yield* f.write("notes/index.md", "# Notes\n");
        yield* f.write("notes/_partials/intro.md", "Intro\n");
        yield* f.write("notes/.obsidian/app.json", "{}");
        yield* f.write("notes/node_modules/pkg/index.js", "x");
        yield* f.write("notes/vendor/tack.yaml", "version: 1\nname: vendor\nskills: [{path: .}]\n");
        yield* f.write("notes/vendor/x.md", "# Vendored\n");
        yield* registerSource(f.options, { sourcePath: f.path.join(f.root, "notes") });
        yield* f.write(
          "source/tack.yaml",
          "version: 1\nname: tools\ndepends-on: [notes]\nskills: [{path: skills}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
        );
        yield* f.write(
          "source/ci.yaml",
          "version: 1\nname: ci\ndepends-on: [notes]\nmembers: [style, {kind: docs, name: notes, source: notes}]\n",
        );
        yield* f.write(
          "notes/tack.yaml",
          "version: 1\nname: notes\ndocs: [{name: notes, path: .}]\n",
        );
        expect(yield* exportCi(f, "plain-collection")).toMatchObject({ exported: true });
        yield* f.write(
          "notes/tack.yaml",
          "version: 1\nname: notes\ndocs: [{name: notes, path: ., reader: notes.reader.yaml}]\n",
        );
        const exported = yield* exportCi(f, "collection");
        expect(exported).toMatchObject({ exported: true, findings: [] });
        const archive = yield* inspectBundle(exported.output);
        const key = archive.manifest.sources.find((source) => source.name === "notes")?.key;
        const prefix = `sources/${key}/`;
        expect(
          archive.manifest.files
            .map((file) => file.path)
            .filter((file) => file.startsWith(prefix))
            .map((file) => file.slice(prefix.length)),
        ).toEqual([
          "_partials",
          "_partials/intro.md",
          "index.md",
          "notes.reader.yaml",
          "tack.yaml",
        ]);
        const declaration = archive.entries.find((entry) => entry.path === `${prefix}tack.yaml`);
        expect(new TextDecoder().decode(declaration?.bytes)).toBe(
          [
            "version: 1",
            "name: notes",
            "depends-on: []",
            "docs:",
            "  - name: notes",
            "    path: .",
            "    reader: notes.reader.yaml",
            "",
          ].join("\n"),
        );
      }),
  );

  test.effect("a source's declared name carries into its projection", () =>
    Effect.gen(function* () {
      const f = yield* profileFixture;
      yield* f.write(
        "source/tack.yaml",
        "version: 1\nname: source\nskills: [{path: skills}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
      );
      const output = f.path.join(f.root, "named.tar.gz");
      const result = yield* runBundleExport(f.options, {
        reference: "source:ci",
        output,
        apply: true,
      });
      expect(result.exported, JSON.stringify(result.plan.findings)).toBe(true);
      const archive = yield* inspectBundle(output);
      const declaration = archive.entries.find(
        (entry) => entry.path === "sources/source-0/tack.yaml",
      );
      expect(Bun.YAML.parse(new TextDecoder().decode(declaration?.bytes))).toHaveProperty(
        "name",
        "source",
      );
    }),
  );
});
