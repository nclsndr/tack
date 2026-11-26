import { writeUnder } from "../../../test/support/source-tree.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { bareSkillText } from "../../../test/support/source-tree.ts";
import { resolveCatalog } from "./catalog.ts";
import { checkSource, inspectDeclaration } from "./source-check.ts";
import { Source } from "./source.ts";

const folders = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-check-" }));
  const write = writeUnder(root);
  return { fs, path, root, write };
});

/** Deep enough that the YAML parser runs out of stack on nested flow collections. */
const depth = 20_000;

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

  test.effect("reports YAML nested too deeply to parse as malformed, not as a crash", () =>
    Effect.gen(function* () {
      const { path, root, write } = yield* folders;
      const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
      yield* write("deep/tack.yaml", `version: ${nested}\n`);
      yield* write("skills/tack.yaml", "version: 1\nname: fixture\nskills:\n  - path: skills\n");
      yield* write("skills/skills/deep/SKILL.md", `---\nname: ${nested}\n---\n`);
      const declaration = yield* checkSource(path.join(root, "deep"));
      const frontmatter = yield* checkSource(path.join(root, "skills"));
      expect(findingsOf(declaration)).toEqual([
        { code: "declaration-malformed", file: path.join(root, "deep", "tack.yaml") },
      ]);
      expect(frontmatter.findings.map(({ code }) => code)).toEqual([
        "skill-frontmatter-yaml-malformed",
      ]);
    }),
  );

  test.effect("refuses a key repeated in tack.yaml at its second line, naming both", () =>
    Effect.gen(function* () {
      const { path, root, write } = yield* folders;
      yield* write("twice/tack.yaml", "version: 1\nname: one\nskills: []\nname: two\n");
      const report = yield* checkSource(path.join(root, "twice"));
      expect(report.findings).toEqual([
        {
          code: "declaration-malformed",
          severity: "error",
          file: path.join(root, "twice", "tack.yaml"),
          line: 4,
          message: 'The key "name" appears twice, at lines 2 and 4. Keep one of them.',
        },
      ]);
    }),
  );

  test.effect("points each declaration problem at its entry in the declaration", () =>
    Effect.gen(function* () {
      const { path, root, write } = yield* folders;
      yield* write(
        "docs/tack.yaml",
        "version: 1\nname: fixture\ndocs:\n  - name: guide\n    path: missing\n  - name: Bad\n    path: x\n",
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
          "name: fixture",
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
      const catalog = yield* resolveCatalog([
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
          "name: fixture",
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

  test.effect("refuses kind at its line and shows the tack.yaml to write instead", () =>
    Effect.gen(function* () {
      const { path, root, write } = yield* folders;
      yield* write("tack.yaml", "version: 1\nname: fixture\nkind: skills\n");
      yield* write("alpha/SKILL.md", bareSkillText("alpha"));
      const report = yield* checkSource(root);
      expect(report.findings).toEqual([
        {
          code: "declaration-schema-invalid",
          severity: "error",
          file: path.join(root, "tack.yaml"),
          field: "kind",
          line: 3,
          message: [
            'A tack.yaml takes no kind key: a "." entry declares the folder that holds it. Write instead:',
            "  version: 1",
            "  name: fixture",
            "  skills:",
            "    - path: .",
          ].join("\n"),
        },
      ]);
    }),
  );

  test.effect("refuses another resource key beside a . entry at that key's line", () =>
    Effect.gen(function* () {
      const { root, write } = yield* folders;
      yield* write(
        "tack.yaml",
        "version: 1\nname: fixture\nskills:\n  - path: .\ncommands:\n  - path: prompts\n",
      );
      const report = yield* checkSource(root);
      expect(report.findings).toMatchObject([
        { code: "declaration-schema-invalid", field: "commands", line: 5 },
      ]);
    }),
  );
});
