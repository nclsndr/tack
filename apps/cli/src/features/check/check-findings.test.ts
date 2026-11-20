import { writeUnder } from "../../../test/support/source-tree.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { checkPaths } from "./check-paths.ts";
import { locateFinding } from "./finding-location.ts";
import { documentationFiles } from "./path-discovery.ts";

const sourceFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-check-" }));
  const write = writeUnder(root);
  return { fs, path, root, write };
});

it.layer(LiveTestLayer)("check findings", (test) => {
  test.effect("reports a source that claims the reserved tack label at its declaration", () =>
    Effect.gen(function* () {
      const { path, root, write } = yield* sourceFolder;
      yield* write("tools/tack.yaml", "version: 1\nname: tack\nskills: [{path: skills}]\n");
      yield* write("tools/skills/review/SKILL.md", "---\nname: review\ndescription: Review\n---\n");
      const report = yield* checkPaths([path.join(root, "tools")]);
      expect(report.findings).toContainEqual(
        expect.objectContaining({
          code: "source-label-reserved",
          file: path.join(root, "tools", "tack.yaml"),
        }),
      );
    }),
  );

  test.effect("collects only Markdown documents and skips devices and hidden entries", () =>
    Effect.gen(function* () {
      const { fs, path, root, write } = yield* sourceFolder;
      yield* write("docs/guide.md", "# Guide\n");
      yield* write("docs/page.mdx", "# Page\n");
      yield* write("docs/notes.txt", "notes\n");
      yield* write("docs/.hidden.md", "# Hidden\n");
      yield* fs.symlink("/dev/null", path.join(root, "docs", "device.md"));
      expect(yield* documentationFiles(path.join(root, "docs"))).toEqual([
        path.join(root, "docs", "guide.md"),
        path.join(root, "docs", "page.mdx"),
      ]);
    }),
  );

  test.effect(
    "passes over underscore, node_modules and nested source folders like the reader",
    () =>
      Effect.gen(function* () {
        const { path, root, write } = yield* sourceFolder;
        yield* write("docs/index.md", "# Welcome\n");
        yield* write("docs/_drafts/wip.md", "# Draft\n");
        yield* write("docs/node_modules/pkg/README.md", "# Package\n");
        yield* write("docs/example/tack.yaml", "version: 1\n");
        yield* write("docs/example/docs/page.md", "# Example\n");
        yield* write("docs/skill/SKILL.md", "---\nname: skill\n---\n");
        yield* write("docs/skill/tack.yaml", "version: 1\n");
        expect(yield* documentationFiles(path.join(root, "docs"))).toEqual([
          path.join(root, "docs", "index.md"),
          path.join(root, "docs", "skill", "SKILL.md"),
        ]);
      }),
  );

  test.effect("keeps a detector line at one or more and places fieldless findings at line 1", () =>
    Effect.gen(function* () {
      const { path, root, write } = yield* sourceFolder;
      const finding = {
        code: "x",
        severity: "error" as const,
        file: path.join(root, "missing.yaml"),
        message: "m",
      };
      expect((yield* locateFinding({ ...finding, line: 0 })).line).toBe(1);
      expect((yield* locateFinding({ ...finding, line: 7 })).line).toBe(7);
      // A file that cannot be read has no field to anchor to.
      expect((yield* locateFinding({ ...finding, field: "name" })).line).toBe(1);
      yield* write("profile.yaml", "version: 1\nname: ci\n");
      expect(
        (yield* locateFinding({ ...finding, file: path.join(root, "profile.yaml"), field: "name" }))
          .line,
      ).toBe(2);
    }),
  );

  test.effect("anchors an entry of a list key at its own item, past nested lists", () =>
    Effect.gen(function* () {
      const { path, root, write } = yield* sourceFolder;
      yield* write(
        "tack.yaml",
        [
          "version: 1",
          "skills:",
          "  - path: skills",
          "    exclude:",
          '      - "vendor/**"',
          "  - path: skills/vendor",
          "docs: [{name: kb, path: kb}]",
          "scripts:",
          "- name: run",
          "  path: run.ts",
          "- name: go",
          "  path: run.ts",
          "",
        ].join("\n"),
      );
      const finding = {
        code: "x",
        severity: "error" as const,
        file: path.join(root, "tack.yaml"),
        message: "m",
      };
      const lineOf = (field: string) =>
        locateFinding({ ...finding, field }).pipe(Effect.map(({ line }) => line));
      expect(yield* lineOf("skills[1]")).toBe(6);
      expect(yield* lineOf("scripts[1]")).toBe(11);
      // A flow list and an entry past the end anchor at the key.
      expect(yield* lineOf("docs[0]")).toBe(7);
      expect(yield* lineOf("skills[2]")).toBe(2);
    }),
  );

  test.effect("reports two scripts on one file once each, at their own entries", () =>
    Effect.gen(function* () {
      const { root, write } = yield* sourceFolder;
      yield* write(
        "tack.yaml",
        [
          "version: 1",
          "scripts:",
          "  - name: run",
          "    path: run.ts",
          "    description: Run",
          "  - name: go",
          "    path: run.ts",
          "    description: Go",
          "",
        ].join("\n"),
      );
      yield* write("run.ts", "export {}");
      const report = yield* checkPaths([root]);
      expect(
        report.findings.map(({ code, line, message }) => ({
          code,
          line,
          subject: message.split(" overlaps")[0],
        })),
      ).toEqual([
        { code: "declaration-path-overlap", line: 3, subject: 'The scripts entry "run"' },
        { code: "declaration-path-overlap", line: 6, subject: 'The scripts entry "go"' },
      ]);
    }),
  );

  test.effect("checks a bundle named twice once and reports one that does not open", () =>
    Effect.gen(function* () {
      const { path, root, write } = yield* sourceFolder;
      yield* write("broken.tar.gz", "not a gzip archive\n");
      const file = path.join(root, "broken.tar.gz");
      const report = yield* checkPaths([file, file]);
      expect(report.checks).toEqual([{ kind: "bundle", path: file, details: [] }]);
      expect(report.findings).toEqual([
        expect.objectContaining({ file, severity: "error", code: expect.any(String) }),
      ]);
    }),
  );
});
