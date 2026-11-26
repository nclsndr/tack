import { skillText, tackMetadata, writeUnder } from "../../../test/support/source-tree.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { checkPaths } from "./check-paths.ts";
import { dependencyLine, locateFinding } from "./finding-location.ts";
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
      yield* write(
        "tools/skills/review/SKILL.md",
        skillText("review", { description: "Review", body: "" }),
      );
      const report = yield* checkPaths([path.join(root, "tools")]);
      expect(report.findings).toContainEqual(
        expect.objectContaining({
          code: "source-label-reserved",
          file: path.join(root, "tools", "tack.yaml"),
        }),
      );
    }),
  );

  test.effect(
    "reports each issue of a declaration that does not decode at its field and line",
    () =>
      Effect.gen(function* () {
        const { path, root, write } = yield* sourceFolder;
        yield* write(
          "tack.yaml",
          [
            "version: 1",
            "name: tools",
            "skils: []",
            "maintainers:",
            '  - ""',
            "depends-on: [Bad]",
            "",
          ].join("\n"),
        );
        const report = yield* checkPaths([root]);
        expect(report.findings).toEqual([
          expect.objectContaining({
            code: "declaration-schema-invalid",
            field: "skils",
            line: 3,
            message: expect.stringMatching(/^Unknown key "skils"\. A list-form tack\.yaml takes: /),
          }),
          expect.objectContaining({
            code: "declaration-schema-invalid",
            field: "maintainers[0]",
            line: 5,
            message: "maintainers[0]: A maintainers entry must not be empty.",
          }),
          expect.objectContaining({
            code: "declaration-schema-invalid",
            field: "depends-on[0]",
            line: 6,
            message: expect.stringContaining("depends-on[0]: "),
          }),
        ]);
        expect(report.findings.every(({ file }) => file === path.join(root, "tack.yaml"))).toBe(
          true,
        );
      }),
  );

  test.effect(
    "reports each dependency edge that names no single resource at its line in the requester",
    () =>
      Effect.gen(function* () {
        const { path, root, write } = yield* sourceFolder;
        yield* write(
          "kit/tack.yaml",
          "version: 1\nname: kit\ndepends-on: [base]\nskills: [{path: skills}]\ncommands: [{path: ship.md}]\n",
        );
        const release = yield* write(
          "kit/skills/release/SKILL.md",
          skillText("release", {
            tack: [
              "dependencies:",
              "  - kind: skill",
              "    name: git",
              "    source: kit",
              "  - kind: skill",
              "    name: git",
              "  - kind: skill",
              "    name: changelog",
              "    optional: true",
              "  - kind: command",
              "    name: audit",
              "    source: elsewhere",
            ],
          }),
        );
        const ship = yield* write(
          "kit/ship.md",
          `---\n${tackMetadata("projects: [app]", "dependencies:", "- {kind: skill, name: deploy}")}---\nShip it\n`,
        );
        yield* write("base/tack.yaml", "version: 1\nname: base\nskills: [{path: skills}]\n");
        yield* write("base/skills/git/SKILL.md", skillText("git"));
        const kit = path.join(root, "kit");

        const report = yield* checkPaths([kit, path.join(root, "base")]);

        expect(
          report.findings.map(({ code, severity, file, line, message }) => ({
            code,
            severity,
            file,
            line,
            message,
          })),
        ).toEqual([
          {
            code: "dependency-missing",
            severity: "error",
            file: ship,
            line: 7,
            message:
              "command ship needs skill deploy, which neither kit nor a source it declares provides.",
          },
          {
            code: "dependency-missing",
            severity: "error",
            file: release,
            line: 8,
            message: "skill release needs skill kit:git, which kit does not provide.",
          },
          {
            code: "dependency-missing",
            severity: "warning",
            file: release,
            line: 13,
            message:
              "skill release needs skill changelog (optional), which neither kit nor a source it declares provides.",
          },
          {
            code: "dependency-source-undeclared",
            severity: "error",
            file: release,
            line: 16,
            message:
              "skill release needs command elsewhere:audit, from elsewhere, which kit does not declare.",
          },
        ]);
        expect(report.summary).toMatchObject({ errors: 3, warnings: 1 });

        const alone = yield* checkPaths([kit]);
        expect(alone.findings).toContainEqual(
          expect.objectContaining({
            code: "dependency-source-unchecked",
            severity: "warning",
            file: release,
            line: 11,
          }),
        );
      }),
  );

  const gitEdge = (source?: string) =>
    skillText("release", {
      tack: [
        "dependencies:",
        "  - kind: skill",
        "    name: git",
        ...(source === undefined ? [] : [`    source: ${source}`]),
      ],
    });
  const skills = (name: string) => `version: 1\nname: ${name}\nskills: [{path: skills}]\n` as const;

  test.effect.each([
    {
      reason: "a quarantined resource",
      files: {
        "kit/tack.yaml": skills("kit"),
        "kit/skills/release/SKILL.md": gitEdge(),
        "kit/skills/git/SKILL.md": skillText("other"),
      },
      checked: ["kit"],
      code: "dependency-quarantined",
      severity: "error",
      message: "skill release needs skill git, which is quarantined in kit.",
      remedy: "Run tack check on the folder of kit to see why, then fix it.",
    },
    {
      reason: "a resource only an undeclared source provides",
      files: {
        "kit/tack.yaml": skills("kit"),
        "kit/skills/release/SKILL.md": gitEdge(),
        "base/tack.yaml": skills("base"),
        "base/skills/git/SKILL.md": skillText("git"),
      },
      checked: ["kit", "base"],
      code: "dependency-source-undeclared",
      severity: "error",
      message:
        "skill release needs skill git, which only a source that kit does not declare provides: base.",
      remedy: "Add base to depends-on in the tack.yaml of kit.",
    },
    {
      reason: "a resource two declared sources provide",
      files: {
        "kit/tack.yaml": `${skills("kit")}depends-on: [left, right]\n`,
        "kit/skills/release/SKILL.md": gitEdge(),
        "left/tack.yaml": skills("left"),
        "left/skills/git/SKILL.md": skillText("git"),
        "right/tack.yaml": skills("right"),
        "right/skills/git/SKILL.md": skillText("git"),
      },
      checked: ["kit", "left", "right"],
      code: "dependency-ambiguous",
      severity: "error",
      message: "skill release needs skill git, which several sources provide: left and right.",
      remedy: "Name one in the dependency, as source: left or source: right.",
    },
    {
      reason: "a resource two sources sharing the declared label provide",
      files: {
        "kit/tack.yaml": `${skills("kit")}depends-on: [base]\n`,
        "kit/skills/release/SKILL.md": gitEdge("base"),
        "base1/tack.yaml": skills("base"),
        "base1/skills/git/SKILL.md": skillText("git"),
        "base2/tack.yaml": skills("base"),
        "base2/skills/git/SKILL.md": skillText("git"),
      },
      checked: ["kit", "base1", "base2"],
      code: "dependency-ambiguous",
      severity: "error",
      message: "skill release needs skill base:git, which several sources named base provide.",
      remedy: "Give each source named base its own name in its tack.yaml.",
    },
    {
      reason: "a declared source that is not checked",
      files: {
        "kit/tack.yaml": `${skills("kit")}depends-on: [base]\n`,
        "kit/skills/release/SKILL.md": gitEdge("base"),
      },
      checked: ["kit"],
      code: "dependency-source-unchecked",
      severity: "warning",
      message:
        "skill release needs skill base:git, from base, which is not among the checked paths.",
      remedy: "Pass the folder of base to the same tack check to verify the dependency.",
    },
    {
      reason: "a resource no checked source provides, while declared sources are not checked",
      files: {
        "kit/tack.yaml": `${skills("kit")}depends-on: [base, extra]\n`,
        "kit/skills/release/SKILL.md": gitEdge(),
      },
      checked: ["kit"],
      code: "dependency-source-unchecked",
      severity: "warning",
      message:
        "skill release needs skill git, which neither kit nor a checked source it declares provides, while kit also declares base and extra, not among the checked paths.",
      remedy: "Pass the folder of base and extra to the same tack check to verify the dependency.",
    },
    {
      reason:
        "a resource only an undeclared checked source provides, while a declared one is not checked",
      files: {
        "kit/tack.yaml": `${skills("kit")}depends-on: [base]\n`,
        "kit/skills/release/SKILL.md": gitEdge(),
        "elsewhere/tack.yaml": skills("elsewhere"),
        "elsewhere/skills/git/SKILL.md": skillText("git"),
      },
      checked: ["kit", "elsewhere"],
      code: "dependency-source-unchecked",
      severity: "warning",
      message:
        "skill release needs skill git, which neither kit nor a checked source it declares provides, while kit also declares base, not among the checked paths.",
      remedy: "Pass the folder of base to the same tack check to verify the dependency.",
    },
    {
      reason: "a declared source Tack cannot read",
      files: {
        "kit/tack.yaml": `${skills("kit")}depends-on: [base]\n`,
        "kit/skills/release/SKILL.md": gitEdge("base"),
        "base/tack.yaml": "version: 9\n",
      },
      checked: ["kit", "base"],
      code: "dependency-source-unhealthy",
      severity: "warning",
      message:
        "skill release needs skill base:git, from base, which may be a source Tack cannot read.",
      remedy: "Fix the findings of BASE, or pass the folder of base to the same tack check.",
    },
    {
      reason: "a resource no checked source provides, while a declared source may be unreadable",
      files: {
        "kit/tack.yaml": `${skills("kit")}depends-on: [base]\n`,
        "kit/skills/release/SKILL.md": gitEdge(),
        "base/tack.yaml": "version: 9\n",
      },
      checked: ["kit", "base"],
      code: "dependency-source-unhealthy",
      severity: "warning",
      message:
        "skill release needs skill git, which neither kit nor a checked source it declares provides, while base may be a source Tack cannot read.",
      remedy: "Fix the findings of BASE, or pass the folder of base to the same tack check.",
    },
    {
      reason: "a missing resource, from a source whose reserved name gives it no label",
      files: {
        "Kit Tools/tack.yaml": "version: 1\nname: tack\nskills: [{path: skills}]\n",
        "Kit Tools/skills/release/SKILL.md": gitEdge(),
      },
      checked: ["Kit Tools"],
      code: "dependency-missing",
      severity: "error",
      message:
        "skill release needs skill git, which neither KIT nor a source it declares provides.",
      remedy:
        "Correct the name, declare the source that provides it in depends-on, or remove the dependency.",
    },
  ] as const)(
    "reports a dependency edge to $reason",
    ({ files, checked, code, severity, message, remedy }) =>
      Effect.gen(function* () {
        const { path, root, write } = yield* sourceFolder;
        for (const [relative, content] of Object.entries(files)) yield* write(relative, content);
        const requester = path.join(root, checked[0]);

        const report = yield* checkPaths(checked.map((folder) => path.join(root, folder)));

        expect(report.findings.filter((finding) => finding.code.startsWith("dependency-"))).toEqual(
          [
            {
              code,
              severity,
              file: path.join(requester, "skills/release/SKILL.md"),
              line: 8,
              message: message.replace("KIT", requester),
              remedy: remedy.replace("BASE", path.join(root, "base")),
            },
          ],
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
        yield* write("docs/example/tack.yaml", "version: 1\nname: example\n");
        yield* write("docs/example/docs/page.md", "# Example\n");
        yield* write("docs/skill/SKILL.md", "---\nname: skill\n---\n");
        yield* write("docs/skill/tack.yaml", "version: 1\nname: skill\n");
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
          "name: tools",
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
      expect(yield* lineOf("skills[1]")).toBe(7);
      expect(yield* lineOf("scripts[1]")).toBe(12);
      // A flow list and an entry past the end anchor at the key.
      expect(yield* lineOf("docs[0]")).toBe(8);
      expect(yield* lineOf("skills[2]")).toBe(3);
    }),
  );

  test.effect("reports two scripts on one file once each, at their own entries", () =>
    Effect.gen(function* () {
      const { root, write } = yield* sourceFolder;
      yield* write(
        "tack.yaml",
        [
          "version: 1",
          "name: tools",
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
        { code: "declaration-path-overlap", line: 4, subject: 'The scripts entry "run"' },
        { code: "declaration-path-overlap", line: 7, subject: 'The scripts entry "go"' },
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

it.each([
  [
    "a block list, past a nested list and a comment",
    "---\nmetadata:\n  tack: |\n    dependencies:\n      - kind: skill\n        tags:\n          - nested\n      # note\n      - kind: command\n    projects: [app]\n---\n",
    1,
    9,
  ],
  [
    "an inline list, at its key",
    "---\nmetadata:\n  tack: |\n    dependencies: [{kind: skill, name: git}]\n---\n",
    0,
    4,
  ],
  [
    "a quoted key",
    '---\nmetadata:\n  tack: |\n    "dependencies":\n      - kind: skill\n---\n',
    0,
    5,
  ],
  [
    "metadata.tack only, past an agent's own dependencies keys",
    "---\ndependencies: [agent-specific]\nmetadata:\n  other:\n    dependencies: [x]\n  tack: |\n    dependencies:\n      - kind: skill\n  dependencies: [y]\n---\n",
    0,
    8,
  ],
  [
    "a quoted metadata.tack string, at its tack key, never in the body",
    '---\nmetadata:\n  tack: "version: 1\\ndependencies: [{kind: skill, name: git}]"\n---\ndependencies:\n  - kind: skill\n',
    0,
    3,
  ],
  [
    "inline metadata, at its metadata key",
    '---\nname: x\nmetadata: {tack: "version: 1"}\n---\ndependencies:\n  - kind: skill\n',
    0,
    3,
  ],
  ["a file with no frontmatter, at line 1", "dependencies:\n  - kind: skill\n", 0, 1],
  [
    "metadata.tack, past a tack line inside another metadata value",
    "---\nmetadata:\n  notes: |\n    tack: see below\n    dependencies: none\n  tack: |\n    version: 1\n    dependencies:\n      - kind: skill\n---\n",
    0,
    9,
  ],
] as const)("anchors a dependency in %s", (_case, text, position, line) => {
  expect(dependencyLine(text, position)).toBe(line);
});
