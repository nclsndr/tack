import { writeUnder } from "../../../test/support/source-tree.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { bareSkillText } from "../../../test/support/source-tree.ts";
import { resolveCatalogFromInspections } from "./catalog.ts";
import { checkSource, inspectDeclaration } from "./source-check.ts";
import { Source } from "./source.ts";

const folders = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-check-" }));
  const write = writeUnder(root);
  return { fs, path, root, write };
});

const findingsOf = (report: Effect.Success<ReturnType<typeof checkSource>>) =>
  report.findings.map(({ code, file }) => ({ code, file }));

it.layer(LiveTestLayer)("source check", (test) => {
  test.effect("reports a folder that is no usable source at its declaration file", () =>
    Effect.gen(function* () {
      const { fs, path, root, write } = yield* folders;
      yield* fs.makeDirectory(path.join(root, "empty"));
      yield* write("broken/tack.yaml", "version: [\n");
      yield* write("locked/tack.yaml", "version: 1\n");
      yield* write("file", "x");
      const locked = path.join(root, "locked", "tack.yaml");
      yield* fs.chmod(locked, 0o000);
      const reports = yield* Effect.forEach(
        ["missing", "empty", "broken", "locked", "file"],
        (name) => checkSource(path.join(root, name)),
      ).pipe(Effect.ensuring(fs.chmod(locked, 0o644).pipe(Effect.orDie)));
      expect(reports.map(findingsOf)).toEqual([
        [{ code: "source-missing", file: path.join(root, "missing", "tack.yaml") }],
        [{ code: "declaration-missing", file: path.join(root, "empty", "tack.yaml") }],
        [{ code: "declaration-malformed", file: path.join(root, "broken", "tack.yaml") }],
        [{ code: "declaration-access-failed", file: locked }],
        [{ code: "source-not-directory", file: path.join(root, "file", "tack.yaml") }],
      ]);
      expect(reports.every((report) => Object.values(report.counts).every((n) => n === 0))).toBe(
        true,
      );
    }),
  );

  test.effect("points each declaration problem at its entry in the declaration", () =>
    Effect.gen(function* () {
      const { path, root, write } = yield* folders;
      yield* write(
        "docs/tack.yaml",
        "version: 1\ndocs:\n  - name: guide\n    path: missing\n  - name: Bad\n    path: x\n",
      );
      const report = yield* checkSource(path.join(root, "docs"));
      const declaration = path.join(root, "docs", "tack.yaml");
      expect(report.findings).toMatchObject([
        {
          code: "declaration-path-missing",
          field: "docs[0]",
          file: declaration,
          candidatePath: path.join(root, "docs", "missing"),
        },
        { code: "declaration-invalid", field: "docs[1]", file: declaration },
      ]);
    }),
  );
  test.effect("names as many resources per entry as the catalog counts for its declaration", () =>
    Effect.gen(function* () {
      const { root, write } = yield* folders;
      yield* write(
        "tack.yaml",
        [
          "version: 1",
          "skills:",
          "  - path: skills",
          "    exclude: ['**/_*/**']",
          "  - path: more",
          "  - path: labs/solo",
          "  - path: ov",
          "  - path: ov/inner",
          "commands:",
          "  - path: commands",
          "  - path: prompts/review.md",
          "context:",
          "  - path: context",
          "    include: ['**/*.md']",
          "scripts:",
          "  - name: report",
          "    path: tools/report.ts",
          "    description: Report",
          "docs:",
          "  - name: handbook",
          "    path: knowledge",
          "  - name: manual",
          "    path: knowledge",
          "  - name: gone",
          "    path: missing",
          "",
        ].join("\n"),
      );
      for (const [file, text] of Object.entries({
        "skills/a/SKILL.md": bareSkillText("a"),
        "skills/dup/SKILL.md": bareSkillText("dup"),
        "skills/broken/SKILL.md": "no frontmatter",
        "skills/_old/c/SKILL.md": bareSkillText("c"),
        "more/dup/SKILL.md": bareSkillText("dup"),
        "more/fine/SKILL.md": bareSkillText("fine"),
        "labs/solo/SKILL.md": bareSkillText("solo"),
        "ov/inner/q/SKILL.md": bareSkillText("q"),
        "commands/ship.md": "# Ship",
        "commands/team/plan.md": "# Plan",
        "prompts/review.md": "# Review",
        "context/notes.md": "x",
        "context/skip.txt": "x",
        "tools/report.ts": "export {}",
        "knowledge/readme.md": "x",
      }))
        yield* write(file, text);
      const source = yield* (yield* Source).validate(root);
      const registration = { id: "00000000-0000-4000-8000-000000000000", canonicalPath: root };
      const catalog = yield* resolveCatalogFromInspections([
        { status: "healthy", registration, declaration: source.declaration },
      ]);
      const counted = (catalog.declarations?.[registration.id] ?? []).map((row) => row.resources);
      const named = (yield* inspectDeclaration(root, source.declaration)).map(
        (entry) => entry.resources.length,
      );
      expect(named).toEqual(counted);
      expect(counted).toEqual([1, 1, 1, 0, 0, 2, 1, 1, 1, 1, 1, 0]);
    }),
  );

  test.effect.each([
    {
      case: "a profile file inside a context folder refuses both",
      exclude: [],
      findings: [
        {
          code: "declaration-path-overlap",
          file: "ctx/ci.yaml",
          message:
            'The profiles entry "ci" overlaps the context entry "ctx". Each file may belong to one declaration, so none of them loads until the overlap is removed. Add exclude: ["ci.yaml"] to the context entry "ctx", or keep one of them.',
        },
        {
          code: "declaration-path-overlap",
          file: "tack.yaml",
          message:
            'The context entry "ctx" overlaps the profiles entry "ci". Each file may belong to one declaration, so none of them loads until the overlap is removed. Add exclude: ["ci.yaml"] to the context entry "ctx", or keep one of them.',
        },
      ],
      context: 0,
    },
    {
      case: "an exclude of the profile file ends the overlap",
      exclude: ["    exclude: [ci.yaml]"],
      findings: [],
      context: 1,
    },
  ])("$case", (row) =>
    Effect.gen(function* () {
      const { path, root, write } = yield* folders;
      yield* write(
        "tack.yaml",
        [
          "version: 2",
          "context:",
          "  - path: ctx",
          ...row.exclude,
          "profiles:",
          "  - name: ci",
          "    path: ctx/ci.yaml",
          "",
        ].join("\n"),
      );
      yield* write("ctx/notes.md", "notes");
      yield* write("ctx/ci.yaml", "version: 1\nname: ci\nmembers: []\n");
      const report = yield* checkSource(root);
      expect(report.findings.map(({ code, file, message }) => ({ code, file, message }))).toEqual(
        row.findings.map((finding) => ({ ...finding, file: path.join(root, finding.file) })),
      );
      expect(report.counts.context).toBe(row.context);
    }),
  );

  test.effect.each([
    {
      case: "each folder at the top of a skills collection that holds no SKILL.md",
      declaration: "version: 1\nkind: skills\n",
      files: [
        "alpha/SKILL.md",
        "commands/hi.md",
        "notes/readme.md",
        "team/review/SKILL.md",
        "README.md",
      ],
      links: { mirror: "notes", gone: "missing" },
      notSkills: ["commands", "mirror", "notes", "team"],
    },
    {
      case: "no hidden, draft, node_modules or other-source folder of a skills collection",
      declaration: "version: 1\nkind: skills\n",
      files: [
        "alpha/SKILL.md",
        ".git/config",
        "_drafts/x/SKILL.md",
        "node_modules/pkg/index.js",
        "split/tack.yaml",
        "split/review/SKILL.md",
      ],
      notSkills: [],
    },
    {
      case: "no folder of a commands collection, which never reads folders",
      declaration: "version: 1\nkind: commands\n",
      files: ["hi.md", "commands/hi.md", "team/review/SKILL.md"],
      notSkills: [],
    },
  ])("warns about $case", (row) =>
    Effect.gen(function* () {
      const { fs, path, root, write } = yield* folders;
      yield* write("tack.yaml", row.declaration);
      for (const file of row.files)
        yield* write(
          file,
          file.endsWith("SKILL.md") ? bareSkillText(path.basename(path.dirname(file))) : "x",
        );
      for (const [link, target] of Object.entries(row.links ?? {}))
        yield* fs.symlink(target, path.join(root, link));
      const report = yield* checkSource(root);
      expect(report.findings.filter((finding) => finding.severity === "warning")).toEqual(
        row.notSkills.map((folder) => ({
          code: "collection-folder-not-skill",
          message: expect.stringContaining(`${folder}/ holds no SKILL.md`),
          severity: "warning",
          field: "kind",
          file: path.join(root, "tack.yaml"),
          candidatePath: path.join(root, folder),
        })),
      );
      expect(report.findings.filter((finding) => finding.severity === "error")).toEqual([]);
    }),
  );

  test.effect("leaves an unlistable skills collection to the error its reader reports", () =>
    Effect.gen(function* () {
      const { fs, root, write } = yield* folders;
      yield* write("tack.yaml", "version: 1\nkind: skills\n");
      yield* write("team/review/SKILL.md", bareSkillText("review"));
      yield* fs.chmod(root, 0o300);
      const report = yield* checkSource(root).pipe(
        Effect.ensuring(fs.chmod(root, 0o755).pipe(Effect.orDie)),
      );
      expect(report.findings.map(({ severity }) => severity)).toEqual(["error"]);
    }),
  );

  test.effect("says a folder that is not a skill is ignored and how to make it one", () =>
    Effect.gen(function* () {
      const { root, write } = yield* folders;
      yield* write("tack.yaml", "version: 1\nkind: skills\n");
      yield* write("alpha/SKILL.md", bareSkillText("alpha"));
      yield* write("commands/hi.md", "# Hi");
      const [entry] = yield* inspectDeclaration(root, { version: 1, kind: "skills" });
      expect(entry?.findings.map((finding) => finding.message)).toEqual([
        "commands/ holds no SKILL.md, so it is not a skill, and a skills collection holds skills only: Tack ignores it. Add a SKILL.md to make it a skill.",
      ]);
    }),
  );
});
