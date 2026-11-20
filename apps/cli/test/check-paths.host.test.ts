import { writeUnder, seedSource, profileSourceFiles } from "./support/source-tree.ts";
import { Source } from "../src/features/sources/source.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError } from "effect";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { profileFixture } from "./support/profile-fixture.ts";
import { StateStore } from "../src/services/state-store.ts";
import { checkPaths } from "../src/features/check/check-paths.ts";
import { profileDefinitionsCheck } from "../src/features/doctor/profile-definitions.ts";
import { readInvocationSnapshot } from "../src/features/snapshot/command-snapshot.ts";
import { runBundleExport } from "../src/features/profiles/bundle-export.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-check-" }));
  yield* seedSource(
    path.join(root, "tools"),
    profileSourceFiles({
      "tack.yaml":
        "version: 2\nname: tools\nskills: [{path: skills}]\ndocs: [{name: guide, path: docs}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
      "docs/page.md": "# Guide\n",
    }),
  );
  return {
    fs,
    path,
    root,
    write: writeUnder(root),
    source: path.join(root, "tools"),
    profile: path.join(root, "tools/ci.yaml"),
  };
});

it.layer(LiveTestLayer)("unified read-only path checks", (test) => {
  test.effect(
    "checks a source's resources, published profiles and docs without reading state",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const store = yield* StateStore;
        const report = yield* checkPaths([f.source]).pipe(
          Effect.provideService(StateStore, {
            ...store,
            read: () => Effect.die("check must never read operator state"),
          }),
        );
        expect(report.summary.errors).toBe(0);
        expect(report.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "source", path: f.source }),
            expect.objectContaining({ kind: "profile", path: f.profile }),
            expect.objectContaining({ kind: "docs", path: f.path.join(f.source, "docs/page.md") }),
          ]),
        );
        expect(report.checks.find((item) => item.kind === "profile")?.details.join(" ")).toContain(
          "Direct members (1)",
        );
        expect(yield* f.fs.exists(f.path.join(f.root, "state.json"))).toBe(false);
      }),
  );
  test.effect(
    "resolves external profile linkage only from explicit companion source folders, with no registration",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write(
          "helpers/tack.yaml",
          "version: 1\nname: helpers\ncommands: [{path: audit.md}]\n",
        );
        yield* f.write("helpers/audit.md", "Audit changes\n");
        yield* f.write(
          "tools/ci.yaml",
          "version: 1\nname: ci\ndepends-on: [helpers]\nmembers: [review, {kind: command, name: audit, source: helpers}]\n",
        );
        const missing = yield* checkPaths([f.profile]);
        expect(missing.findings).toContainEqual(
          expect.objectContaining({
            code: "profile-source-unregistered",
            severity: "error",
            file: f.profile,
          }),
        );
        const complete = yield* checkPaths([f.profile, f.path.join(f.root, "helpers")]);
        expect(complete.summary.errors).toBe(0);
        expect(
          complete.checks.find((item) => item.kind === "profile")?.details.join(" "),
        ).toContain("Direct members (2)");
      }),
  );
  test.effect(
    "combines failures with exact figure lines, keeps checking independent paths and deduplicates overlapping inputs",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("tools/docs/broken.mdx", '# Broken\n\n<Chart id="broken" />\n');
        yield* f.write("tools/ci.yaml", "version: 1\nname: wrong\nmembers: [review]\n");
        const report = yield* checkPaths([
          f.source,
          f.profile,
          f.path.join(f.source, "docs"),
          f.path.join(f.root, "missing"),
        ]);
        expect(report.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "profile-publication-mismatch",
              file: f.profile,
              line: expect.any(Number),
            }),
            expect.objectContaining({
              code: "figure-issues",
              file: f.path.join(f.source, "docs/broken.mdx"),
              line: 3,
            }),
            expect.objectContaining({ code: "check-path-unavailable" }),
          ]),
        );
        expect(
          report.findings.filter((finding) => finding.code === "profile-publication-mismatch"),
        ).toHaveLength(1);
        expect(report.checks.filter((item) => item.path === f.profile)).toHaveLength(1);
        expect(report.summary.errors).toBe(
          report.findings.filter((finding) => finding.severity === "error").length,
        );
      }),
  );
  test.effect("checks reader icons and author components through the unified report", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const file = f.path.join(f.source, "docs/icons.mdx");
      yield* f.write(
        "tools/docs/icons.mdx",
        '# Guide\n\n<Icon name="home" />\n<Callout kind="danger">Careful</Callout>\n<Term>Missing definition</Term>\n',
      );
      const report = yield* checkPaths([file]);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "icon-unknown",
            severity: "error",
            file,
            line: 3,
            message: expect.stringContaining("house"),
          }),
          expect.objectContaining({ code: "component-issue", severity: "error", file, line: 4 }),
          expect.objectContaining({ code: "component-issue", severity: "error", file, line: 5 }),
        ]),
      );
      expect(report.summary.errors).toBe(3);
      yield* f.write(
        "tools/docs/icons.mdx",
        '<Icon name="house" />\n<Callout kind="note">Careful</Callout>\n<Term title="Definition">Term</Term>\n',
      );
      expect((yield* checkPaths([file])).summary.errors).toBe(0);
    }),
  );
  test.effect(
    "supports another static docs detector without changing source/profile/bundle dispatch",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const file = f.path.join(f.source, "docs/page.md");
        const report = yield* checkPaths([file], {
          additionalDocumentationDetectors: [
            {
              name: "icons",
              inspect: (path: string) =>
                Effect.succeed({
                  details: ["Icons checked"],
                  findings: [
                    {
                      code: "icon-invalid",
                      severity: "error" as const,
                      file: path,
                      line: 1,
                      message: "Unknown icon fixture",
                    },
                  ],
                }),
            },
          ],
        });
        expect(report.findings).toContainEqual(
          expect.objectContaining({ code: "icon-invalid", file, line: 1 }),
        );
        expect(report.checks[0]?.details).toContain("Icons checked");
        expect(report.summary.errors).toBe(1);
      }),
  );
  test.effect(
    "reports malformed and unsupported files instead of aborting the combined report",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("bad.tar.gz", "not gzip");
        yield* f.write("unknown.txt", "ordinary text");
        const report = yield* checkPaths([
          f.path.join(f.root, "bad.tar.gz"),
          f.path.join(f.root, "unknown.txt"),
          f.source,
        ]);
        expect(report.summary.errors).toBe(2);
        expect(report.findings.map((finding) => finding.code)).toEqual(
          expect.arrayContaining(["profile-bundle-limit", "check-path-unsupported"]),
        );
        expect(report.checks.some((item) => item.kind === "source")).toBe(true);
      }),
  );
  test.effect(
    "checks a complete bundle offline without reading or changing its author's state",
    () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        const file = f.path.join(f.root, "ci.tar.gz");
        yield* runBundleExport(f.options, { reference: "tools:ci", output: file, apply: true });
        yield* f.fs.rename(f.source, f.source + "-unavailable");
        const store = yield* StateStore;
        const report = yield* checkPaths([file]).pipe(
          Effect.provideService(StateStore, {
            ...store,
            read: () => Effect.die("bundle check must never read state"),
          }),
        );
        expect(report.summary.errors).toBe(0);
        expect(report.checks).toContainEqual(
          expect.objectContaining({ kind: "bundle", path: file }),
        );
      }),
  );
  test.effect("doctor detects broken definitions even when no profile was ever applied", () =>
    Effect.gen(function* () {
      const f = yield* profileFixture;
      const check = () =>
        Effect.gen(function* () {
          return yield* profileDefinitionsCheck(yield* readInvocationSnapshot(f.options));
        });
      expect((yield* check()).outcome).toBe("ok");
      yield* f.write("source/ci.yaml", "version: 1\nname: ci\nmembers: [missing]\n");
      const failed = yield* check();
      expect(failed.id).toBe("profile-definitions");
      expect(failed.outcome).toBe("failed");
      expect(failed.message).toContain("profile-member-missing");
      expect(failed.next?.slice(0, 2)).toEqual(["tack", "check"]);
    }),
  );
  test.effect(
    "anchors profile mismatches to their name field and reports unpublished/ownerless files honestly",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("tools/ci.yaml", "version: 1\nname: wrong\nmembers: [review]\n");
        yield* f.write(
          "tools/unpublished.yaml",
          "version: 1\nname: unpublished\nmembers: [review]\n",
        );
        yield* f.write("orphan.yaml", "version: 1\nname: orphan\nmembers: []\n");
        const report = yield* checkPaths([
          f.profile,
          f.path.join(f.source, "unpublished.yaml"),
          f.path.join(f.root, "orphan.yaml"),
        ]);
        expect(report.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "profile-publication-mismatch", line: 2 }),
            expect.objectContaining({ code: "profile-unpublished" }),
            expect.objectContaining({ code: "check-profile-source" }),
          ]),
        );
        expect(report.summary.errors).toBe(3);
      }),
  );
  test.effect("continues after a malformed declaration and checks tack.yaml paths only once", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("bad/tack.yaml", "version: 99\n");
      const report = yield* checkPaths([
        f.path.join(f.root, "bad"),
        f.source,
        f.path.join(f.source, "tack.yaml"),
      ]);
      expect(report.checks.filter((item) => item.kind === "source")).toHaveLength(2);
      expect(report.findings).toContainEqual(
        expect.objectContaining({ code: "declaration-version-unsupported" }),
      );
      expect(report.checks.some((item) => item.kind === "profile")).toBe(true);
    }),
  );
  test.effect(
    "skips hidden/dependency docs, survives directory cycles and continues after an unreadable page syntax",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const folder of [".hidden", "_private", "node_modules"])
          yield* f.write(`tools/docs/${folder}/bad.mdx`, '<Chart id="hidden" />\n');
        yield* f.write("tools/docs/syntax.mdx", "<Figure id={\n");
        yield* f.fs.symlink(f.path.join(f.source, "docs"), f.path.join(f.source, "docs/cycle"));
        const report = yield* checkPaths([f.path.join(f.source, "docs")]);
        expect(report.checks.filter((item) => item.kind === "docs")).toHaveLength(2);
        expect(report.findings).toContainEqual(
          expect.objectContaining({
            code: "check-docs-read",
            file: f.path.join(f.source, "docs/syntax.mdx"),
          }),
        );
        expect(
          report.findings.some(
            (finding) => finding.file.includes("hidden") || finding.file.includes("node_modules"),
          ),
        ).toBe(false);
      }),
  );
  test.effect(
    "keeps invalid source-owned paths inside declaration findings instead of scanning outside content",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("outside/bad.mdx", '<Chart id="outside" />\n');
        yield* f.write(
          "tools/tack.yaml",
          "version: 2\nname: tools\ndocs: [{name: escape, path: ../outside}]\n",
        );
        const report = yield* checkPaths([f.source]);
        expect(report.summary.errors).toBeGreaterThan(0);
        expect(report.checks.some((item) => item.path.includes("outside"))).toBe(false);
        expect(report.findings.some((finding) => finding.code === "figure-issues")).toBe(false);
      }),
  );
  test.effect("counts an unreadable docs root and continues checking an independent file", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const folder = f.path.join(f.source, "docs");
      const fs = {
        ...f.fs,
        readDirectory: (file: string) =>
          file === folder
            ? Effect.fail(
                PlatformError.badArgument({ module: "check-test", method: "readDirectory" }),
              )
            : f.fs.readDirectory(file),
      } satisfies FileSystem.FileSystem;
      const report = yield* checkPaths([folder, f.path.join(folder, "page.md")]).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      expect(report.summary.checked).toBe(2);
      expect(report.findings).toContainEqual(
        expect.objectContaining({ code: "check-docs-read", file: folder }),
      );
    }),
  );
  test.effect(
    "doctor treats ambient built-in omissions as warnings without failing valid definitions",
    () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        yield* f.write(
          "source/ci.yaml",
          "version: 1\nname: ci\ndepends-on: [tack]\nmembers: [{kind: skill, name: use-tack, source: tack}]\n",
        );
        const source = yield* Source;
        const observed = yield* Effect.gen(function* () {
          return yield* profileDefinitionsCheck(yield* readInvocationSnapshot(f.options));
        }).pipe(
          Effect.provideService(Source, {
            ...source,
            builtInSources: [
              {
                id: "22222222-2222-4222-8222-222222222222",
                canonicalPath: f.path.resolve(import.meta.dirname, "../src/builtins"),
              },
            ],
          }),
        );
        expect(observed.outcome).toBe("warning");
        expect(observed.message).toContain("profile-builtin-omitted");
      }),
  );
  test.effect(
    "reports profile member lines and empty docs folders alongside a source label clash",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write(
          "tools/ci.yaml",
          "version: 1\nname: ci\nmembers:\n  - missing\n  - review\n  - also-missing\n",
        );
        yield* f.write("duplicate/tack.yaml", "version: 1\nname: tools\n");
        yield* f.fs.makeDirectory(f.path.join(f.root, "empty-docs"));
        const report = yield* checkPaths([
          f.source,
          f.path.join(f.root, "duplicate"),
          f.path.join(f.root, "empty-docs"),
        ]);
        expect(
          report.findings
            .filter((finding) => finding.code === "profile-member-missing")
            .map((finding) => finding.line),
        ).toEqual([4, 6]);
        expect(report.findings.some((finding) => finding.code === "source-label-clash")).toBe(true);
        expect(report.checks).toContainEqual({
          kind: "docs",
          path: f.path.join(f.root, "empty-docs"),
          details: ["No Markdown documents found."],
        });
      }),
  );

  test.effect(
    "returns warning-only success for computed figure props and partially checked authored shapes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write(
          "tools/docs/warnings.mdx",
          [
            '<Figure id="partial" title="A figure with an inline drawing">',
            '  <Drawing height={100}><Box id="a" x={16} y={16} label="a" /><g /></Drawing>',
            "</Figure>",
            "",
            '<Figure id="computed" title="A figure whose box is computed">',
            '  <Drawing height={100}><Box id="a" x={1 + 1} y={0} label="a" /></Drawing>',
            "</Figure>",
          ].join("\n"),
        );
        const report = yield* checkPaths([f.path.join(f.source, "docs")]);
        expect(report.summary).toMatchObject({ errors: 0, warnings: 2 });
        expect(report.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "figure-partly-checked",
              severity: "warning",
              line: 1,
            }),
            expect.objectContaining({ code: "figure-not-checked", severity: "warning", line: 5 }),
          ]),
        );
      }),
  );
  test.effect("rejects a non-regular path without attempting to read it as authored content", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const file = f.path.join(f.root, "device");
      yield* f.write("device", "");
      const fs = {
        ...f.fs,
        stat: (input: string) =>
          f.fs
            .stat(input)
            .pipe(
              Effect.map((info) => (input === file ? { ...info, type: "Socket" as const } : info)),
            ),
      } satisfies FileSystem.FileSystem;
      const report = yield* checkPaths([file]).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      expect(report.summary.errors).toBe(1);
      expect(report.findings).toContainEqual(
        expect.objectContaining({ code: "check-path-unsupported", file, line: 1 }),
      );
    }),
  );
});
