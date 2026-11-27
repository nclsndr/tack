import { bareSkillText, declare } from "../../../test/support/source-tree.ts";
import { resolveCatalogAt } from "../../../test/support/snapshot-helpers.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { initializeState, readState, type StateOptions } from "../../services/state-store.ts";

import { inspectSources, registerSource } from "./source.ts";
import { declaredSkillsFolders } from "./resource-declarations.ts";
import { stateOptionsAt } from "../../../test/support/state-fixture.ts";

type Fixture = { readonly root: string; readonly options: StateOptions };

const withSource = <A, E, R>(
  declaration: string,
  files: Readonly<Record<string, string>>,
  use: (fixture: Fixture) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "tack-declarations-" });
    const base = yield* fs.realPath(temporary);
    const options = stateOptionsAt(path.join(base, "state"), base);
    yield* initializeState(options);
    const root = path.join(base, "source");
    yield* fs.makeDirectory(root, { recursive: true });
    yield* fs.writeFileString(path.join(root, "tack.yaml"), declaration);
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, content);
    }
    return yield* use({ root, options });
  });

const catalogOf = (fixture: Fixture) =>
  Effect.gen(function* () {
    yield* registerSource(fixture.options, { sourcePath: fixture.root }).pipe(Effect.ignore);
    return yield* resolveCatalogAt(fixture.options);
  });

const resources = (catalog: Effect.Success<ReturnType<typeof resolveCatalogAt>>) =>
  catalog.entries
    .filter((entry) => entry.origin !== "builtin")
    .map(({ address }) => `${address.kind}/${address.name}`)
    .sort();

const quarantines = (catalog: Effect.Success<ReturnType<typeof resolveCatalogAt>>) =>
  catalog.quarantined.map(({ code, candidateKind }) => `${candidateKind ?? "-"}:${code}`).sort();

it.layer(LiveTestLayer)("source resource declarations", (test) => {
  test.effect(
    "a source whose tack.yaml declares none of its kind folders is unhealthy and names each folder",
    () =>
      withSource(
        declare("old"),
        {
          "skills/adhd/SKILL.md": bareSkillText("adhd"),
          "commands/ship.md": "# Ship",
          "scripts/group/deploy.ts": "export {}",
        },
        (fixture) =>
          Effect.gen(function* () {
            const registered = yield* registerSource(fixture.options, {
              sourcePath: fixture.root,
            }).pipe(Effect.flip);
            expect(registered).toMatchObject({ code: "declaration-resources-undeclared" });
            const message = registered.message;
            expect(message).toContain("skills/");
            expect(message).toContain("commands/");
            expect(message).toContain("scripts/");
            expect(message).toContain("skills: [{ path: skills }]");
            expect(message).toContain("commands: [{ path: commands }]");
            expect(message).toContain("path: scripts/<file>.ts");
            expect(message).toContain("skills: []");
          }),
      ),
  );

  test.effect(
    "a registered source that stops declaring its folders turns unhealthy in the catalog",
    () =>
      withSource(declare("source"), { "skills/adhd/SKILL.md": bareSkillText("adhd") }, (fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          // Registered while declared, then the declaration loses its keys.
          yield* fs.writeFileString(
            path.join(fixture.root, "tack.yaml"),
            declare("source", "skills: [{ path: skills }]"),
          );
          yield* registerSource(fixture.options, { sourcePath: fixture.root });
          yield* fs.writeFileString(path.join(fixture.root, "tack.yaml"), declare("source"));
          const catalog = yield* resolveCatalogAt(fixture.options);
          expect(resources(catalog)).toEqual([]);
          expect(catalog.unhealthySources).toMatchObject([
            { issue: { code: "declaration-resources-undeclared" } },
          ]);
        }),
      ),
  );

  test.effect(
    "any resource key, even an empty list, makes a source with kind folders healthy",
    () =>
      withSource(
        declare("source", "skills: []"),
        { "skills/adhd/SKILL.md": bareSkillText("adhd") },
        (fixture) =>
          Effect.gen(function* () {
            const catalog = yield* catalogOf(fixture);
            expect(catalog.unhealthySources).toEqual([]);
            expect(resources(catalog)).toEqual([]);
            expect(catalog.quarantined).toEqual([]);
          }),
      ),
  );

  test.effect("a docs-only source with a skills folder is unhealthy until it opts out", () =>
    withSource(
      declare("source", "docs:", "  - name: kb", "    path: notes"),
      { "skills/unrelated.txt": "x", "notes/a.md": "# A" },
      (fixture) =>
        Effect.gen(function* () {
          const error = yield* registerSource(fixture.options, {
            sourcePath: fixture.root,
          }).pipe(Effect.flip);
          expect(error).toMatchObject({ code: "declaration-resources-undeclared" });
        }),
    ),
  );

  test.effect("folder declarations find each kind through group folders and name them", () =>
    withSource(
      declare(
        "source",
        "skills:",
        "  - path: skills",
        "commands:",
        "  - path: commands",
        "context:",
        "  - path: context",
      ),
      {
        "skills/00_group/alpha/SKILL.md": bareSkillText("alpha"),
        "skills/.hidden/beta/SKILL.md": bareSkillText("beta"),
        "commands/group/review.md": "# Review",
        "commands/ship.md": "# Ship",
        "commands/notes.txt": "ignored",
        "context/team/notes.md": "# Notes",
        "context/style.txt": "style",
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual([
            "command/review",
            "command/ship",
            "context/style.txt",
            "context/team/notes.md",
            "skill/alpha",
            "skill/beta",
          ]);
          expect(catalog.quarantined).toEqual([]);
        }),
    ),
  );

  test.effect(
    "several skills folders load by their own names and a shared name quarantines both",
    () =>
      withSource(
        declare("source", "skills:", "  - path: skills", "  - path: vendor/skills"),
        {
          "skills/00_effect/pdf/SKILL.md": bareSkillText("pdf"),
          "skills/only-here/SKILL.md": bareSkillText("only-here"),
          "vendor/skills/pdf/SKILL.md": bareSkillText("pdf"),
          "vendor/skills/vendored/SKILL.md": bareSkillText("vendored"),
        },
        (fixture) =>
          Effect.gen(function* () {
            const catalog = yield* catalogOf(fixture);
            expect(resources(catalog)).toEqual(["skill/only-here", "skill/vendored"]);
            expect(quarantines(catalog)).toEqual([
              "skill:skill-address-duplicate",
              "skill:skill-address-duplicate",
            ]);
            expect(catalog.unhealthySources).toEqual([]);
          }),
      ),
  );

  test.effect("a folder declaration and a single-skill declaration with one name clash", () =>
    withSource(
      declare("source", "skills:", "  - path: skills", "  - path: labs/pdf"),
      {
        "skills/pdf/SKILL.md": bareSkillText("pdf"),
        "skills/other/SKILL.md": bareSkillText("other"),
        "labs/pdf/SKILL.md": bareSkillText("pdf"),
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["skill/other"]);
          expect(quarantines(catalog)).toEqual([
            "skill:skill-address-duplicate",
            "skill:skill-address-duplicate",
          ]);
        }),
    ),
  );

  test.effect("one skill declared alone loads, and patterns on it quarantine the entry", () =>
    withSource(
      declare(
        "source",
        "skills:",
        "  - path: labs/one-off",
        "  - path: labs/other",
        "    exclude: ['x']",
      ),
      {
        "labs/one-off/SKILL.md": bareSkillText("one-off"),
        "labs/other/SKILL.md": bareSkillText("other"),
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["skill/one-off"]);
          expect(quarantines(catalog)).toEqual(["skill:declaration-entry-invalid"]);
          expect(catalog.unhealthySources).toEqual([]);
        }),
    ),
  );

  test.effect("single command and context declarations are named by file", () =>
    withSource(
      declare(
        "source",
        "commands:",
        "  - path: prompts/review.md",
        "context:",
        "  - path: notes/team.md",
        "  - path: notes/folder",
        "    include: ['**/*.md']",
      ),
      {
        "prompts/review.md": "# Review",
        "notes/team.md": "# Team",
        "notes/folder/inner.md": "# Inner",
        "notes/folder/skip.txt": "skip",
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          // notes/team.md lies inside notes/folder's parent only, so there is no overlap.
          expect(resources(catalog)).toEqual([
            "command/review",
            "context/inner.md",
            "context/team.md",
          ]);
          expect(catalog.quarantined).toEqual([]);
        }),
    ),
  );

  test.effect("a skill folder is a leaf: a nested SKILL.md is content", () =>
    withSource(
      declare("source", "skills:", "  - path: skills"),
      {
        "skills/creator/SKILL.md": bareSkillText("creator"),
        "skills/creator/templates/example/SKILL.md": bareSkillText("example"),
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["skill/creator"]);
          expect(catalog.quarantined).toEqual([]);
        }),
    ),
  );

  test.effect(
    "underscore folders mean nothing without a pattern, and a pattern excludes them",
    () =>
      withSource(
        declare("source", "skills:", "  - path: skills"),
        {
          "skills/kept/SKILL.md": bareSkillText("kept"),
          "skills/_archive/adhd/SKILL.md": bareSkillText("adhd"),
        },
        (fixture) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            yield* registerSource(fixture.options, { sourcePath: fixture.root });
            expect(resources(yield* resolveCatalogAt(fixture.options))).toEqual([
              "skill/adhd",
              "skill/kept",
            ]);
            yield* fs.writeFileString(
              path.join(fixture.root, "tack.yaml"),
              declare(
                "source",
                "skills:",
                "  - path: skills",
                "    exclude:",
                '      - "**/_*/**"',
              ),
            );
            yield* fs.makeDirectory(path.join(fixture.root, "skills/_archive/broken"), {
              recursive: true,
            });
            yield* fs.writeFileString(
              path.join(fixture.root, "skills/_archive/broken/SKILL.md"),
              "no frontmatter",
            );
            const catalog = yield* resolveCatalogAt(fixture.options);
            expect(resources(catalog)).toEqual(["skill/kept"]);
            expect(catalog.quarantined).toEqual([]);
          }),
      ),
  );

  test.effect("include and exclude select by path relative to the declared folder", () =>
    withSource(
      declare(
        "source",
        "skills:",
        "  - path: skills",
        "    include: ['00_effect/**', 'solo']",
        "    exclude: ['**/skip']",
        "commands:",
        "  - path: commands",
        "    include: ['group/*.md']",
        "    exclude: ['**/draft.md']",
      ),
      {
        "skills/00_effect/one/SKILL.md": bareSkillText("one"),
        "skills/00_effect/skip/SKILL.md": bareSkillText("skip"),
        "skills/solo/SKILL.md": bareSkillText("solo"),
        "skills/other/SKILL.md": bareSkillText("other"),
        "commands/group/keep.md": "# Keep",
        "commands/group/draft.md": "# Draft",
        "commands/top.md": "# Top",
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["command/keep", "skill/one", "skill/solo"]);
          expect(catalog.quarantined).toEqual([]);
        }),
    ),
  );

  test.effect("an excluded folder is not entered, so its broken content is not reported", () =>
    withSource(
      declare(
        "source",
        "commands:",
        "  - path: commands",
        "    exclude: ['**/_*/**']",
        "context:",
        "  - path: context",
        "    exclude: ['**/_*/**']",
      ),
      {
        "commands/ok.md": "# Ok",
        "commands/_old/---bad.md": "---\nnot: [valid\n---\n",
        "context/ok.md": "x",
        "context/group/_old/notes.md": "x",
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["command/ok", "context/ok.md"]);
          expect(catalog.quarantined).toEqual([]);
        }),
    ),
  );

  test.effect("an undeclared kind contributes nothing and reports no issue", () =>
    withSource(
      declare("source", "skills:", "  - path: skills"),
      {
        "skills/one/SKILL.md": bareSkillText("one"),
        "commands/ship.md": "# Ship",
        "context/a.md": "a",
        "scripts/run.ts": "export {}",
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["skill/one"]);
          expect(catalog.quarantined).toEqual([]);
        }),
    ),
  );

  test.effect("each declared path violation quarantines only its entry with its own code", () =>
    withSource(
      declare(
        "source",
        "skills:",
        "  - path: ../shared/skills",
        "  - path: /abs/skills",
        "  - path: skills//double",
        "  - path: ./skills",
        "  - path: back\\slash",
        "  - path: escape",
        "  - path: vendor/skills",
        "  - path: skills/not-a-folder.txt",
        "  - path: skills",
        "commands:",
        "  - path: commands/not-markdown.txt",
        "  - path: commands/missing.md",
        "scripts:",
        "  - name: js",
        "    path: tools/report.js",
        "    description: Not typescript",
      ),
      {
        "skills/ok/SKILL.md": bareSkillText("ok"),
        "skills/not-a-folder.txt": "x",
        "commands/not-markdown.txt": "x",
        "tools/report.js": "x",
      },
      (fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const outside = path.join(path.dirname(fixture.root), "outside");
          yield* fs.makeDirectory(outside, { recursive: true });
          yield* fs.symlink(outside, path.join(fixture.root, "escape"));
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["skill/ok"]);
          expect(quarantines(catalog)).toEqual([
            "command:declaration-path-missing",
            "command:declaration-path-wrong-type",
            "script:declaration-path-wrong-type",
            "skill:declaration-path-invalid",
            "skill:declaration-path-invalid",
            "skill:declaration-path-invalid",
            "skill:declaration-path-invalid",
            "skill:declaration-path-invalid",
            "skill:declaration-path-missing",
            "skill:declaration-path-outside-source",
            "skill:declaration-path-wrong-type",
          ]);
          expect(catalog.unhealthySources).toEqual([]);
        }),
    ),
  );

  test.effect(
    "a declared path that names or lies inside the import staging folder is quarantined",
    () =>
      withSource(
        declare(
          "source",
          "skills:",
          "  - path: skills",
          "  - path: .tack-import-staging",
          "  - path: .tack-import-staging/pdf",
          "commands:",
          "  - path: .tack-import-staging/commands",
        ),
        {
          "skills/ok/SKILL.md": bareSkillText("ok"),
          ".tack-import-staging/skills/staged/SKILL.md": bareSkillText("staged"),
          ".tack-import-staging/pdf/SKILL.md": bareSkillText("pdf"),
          ".tack-import-staging/commands/ship.md": "# Ship",
        },
        (fixture) =>
          Effect.gen(function* () {
            const catalog = yield* catalogOf(fixture);
            expect(resources(catalog)).toEqual(["skill/ok"]);
            expect(quarantines(catalog)).toEqual([
              "command:declaration-path-invalid",
              "skill:declaration-path-invalid",
              "skill:declaration-path-invalid",
            ]);
            expect(catalog.quarantined.map(({ message }) => message)).toEqual(
              expect.arrayContaining([expect.stringContaining(".tack-import-staging")]),
            );
          }),
      ),
  );

  test.effect(
    "the imports key is accepted as unknown and never changes health or the catalog",
    () =>
      withSource(
        declare(
          "source",
          "skills: [{ path: skills }]",
          "imports: not-a-list-the-catalog-never-reads",
        ),
        { "skills/ok/SKILL.md": bareSkillText("ok") },
        (fixture) =>
          Effect.gen(function* () {
            const catalog = yield* catalogOf(fixture);
            expect(resources(catalog)).toEqual(["skill/ok"]);
            expect(catalog.unhealthySources).toEqual([]);
          }),
      ),
  );

  test.effect("entries that do not decode are quarantined alone", () =>
    withSource(
      declare(
        "source",
        "skills:",
        "  - path: skills",
        "  - pth: typo",
        "  - path: skills",
        "    unknown: 1",
        "  - just-a-string",
        "commands: not-a-list",
        "scripts:",
        "  - name: Bad Name",
        "    path: tools/run.ts",
        "    description: Bad name",
        "  - name: nodesc",
        "    path: tools/run.ts",
      ),
      { "skills/ok/SKILL.md": bareSkillText("ok"), "tools/run.ts": "export {}" },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["skill/ok"]);
          expect(quarantines(catalog).filter((code) => !code.endsWith("entry-invalid"))).toEqual(
            [],
          );
          expect(quarantines(catalog)).toHaveLength(6);
          expect(catalog.unhealthySources).toEqual([]);
        }),
    ),
  );

  test.effect("overlapping declarations are all quarantined, across kinds, docs included", () =>
    withSource(
      declare(
        "source",
        "skills:",
        "  - path: skills",
        "  - path: skills/vendor",
        "  - path: lone",
        "commands:",
        "  - path: skills/vendor",
        "context:",
        "  - path: ctx",
        "docs:",
        "  - name: kb",
        "    path: skills",
      ),
      {
        "skills/a/SKILL.md": bareSkillText("a"),
        "skills/vendor/b/SKILL.md": bareSkillText("b"),
        "lone/SKILL.md": bareSkillText("lone"),
        "ctx/x.md": "x",
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["context/x.md", "skill/lone"]);
          const overlaps = catalog.quarantined.filter(
            ({ code }) => code === "declaration-path-overlap",
          );
          expect(
            quarantines(catalog).filter((code) => code.endsWith(":declaration-path-overlap")),
          ).toEqual([
            "command:declaration-path-overlap",
            "docs:declaration-path-overlap",
            "skill:declaration-path-overlap",
            "skill:declaration-path-overlap",
          ]);
          expect(overlaps.every(({ message }) => message.includes("skills"))).toBe(true);
        }),
    ),
  );

  test.effect("overlap is found through a declared symlink inside the source", () =>
    withSource(
      declare("source", "skills:", "  - path: lib/skills", "  - path: shared"),
      { "lib/skills/a/SKILL.md": bareSkillText("a") },
      (fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.symlink(
            path.join(fixture.root, "lib/skills"),
            path.join(fixture.root, "shared"),
          );
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual([]);
          expect(quarantines(catalog)).toEqual([
            "skill:declaration-path-overlap",
            "skill:declaration-path-overlap",
          ]);
        }),
    ),
  );

  test.effect.each([
    {
      case: "a folder the outer entry excludes",
      lines: [
        "skills:",
        "  - path: skills",
        '    exclude: ["vendor/**"]',
        "  - path: skills/vendor",
      ],
      loads: ["skill/a", "skill/b"],
    },
    {
      case: "one skill below a folder the outer entry excludes",
      lines: [
        "skills:",
        "  - path: skills",
        '    exclude: ["**/vendor/**"]',
        "  - path: skills/vendor/b",
      ],
      loads: ["skill/a", "skill/b"],
    },
    {
      case: "a script file the outer entry excludes",
      lines: [
        "context:",
        "  - path: tools",
        '    exclude: ["run.ts"]',
        "scripts:",
        "  - name: run",
        "    path: tools/run.ts",
        "    description: Run",
      ],
      loads: ["context/notes.md", "script/run"],
    },
    {
      case: "a docs folder",
      lines: [
        "skills:",
        "  - path: skills",
        '    exclude: ["vendor/**"]',
        "docs:",
        "  - name: kb",
        "    path: skills/vendor",
      ],
      loads: ["docs/kb", "skill/a"],
    },
  ])("an outer exclude that prunes $case ends the overlap", (row) =>
    withSource(
      declare("source", ...row.lines),
      {
        "skills/a/SKILL.md": bareSkillText("a"),
        "skills/vendor/b/SKILL.md": bareSkillText("b"),
        "tools/run.ts": "export {}",
        "tools/notes.md": "notes",
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(row.loads);
          expect(catalog.quarantined).toEqual([]);
        }),
    ),
  );

  const loadsNone =
    "Each file may belong to one declaration, so none of them loads until the overlap is removed.";
  test.effect.each([
    {
      case: "an exclude that misses the nested folder",
      lines: [
        "skills:",
        "  - path: skills",
        '    exclude: ["other/**"]',
        "  - path: skills/vendor",
      ],
      says: [
        `The skills entry "skills" overlaps the skills entry "skills/vendor". ${loadsNone} Add exclude: ["vendor/**"] to the skills entry "skills", or keep one of them.`,
        `The skills entry "skills/vendor" overlaps the skills entry "skills". ${loadsNone} Add exclude: ["vendor/**"] to the skills entry "skills", or keep one of them.`,
      ],
    },
    {
      case: "an include, which never stops the walk",
      lines: ["skills:", "  - path: skills", '    include: ["a/**"]', "  - path: skills/vendor"],
      says: [
        `The skills entry "skills" overlaps the skills entry "skills/vendor". ${loadsNone} Add exclude: ["vendor/**"] to the skills entry "skills", or keep one of them.`,
        `The skills entry "skills/vendor" overlaps the skills entry "skills". ${loadsNone} Add exclude: ["vendor/**"] to the skills entry "skills", or keep one of them.`,
      ],
    },
    {
      case: "equal paths, whatever they exclude",
      lines: [
        "context:",
        "  - path: tools",
        '    exclude: ["x/**"]',
        "commands:",
        "  - path: tools",
      ],
      says: [
        `The commands entry "tools" overlaps the context entry "tools". ${loadsNone} Keep one of them.`,
        `The context entry "tools" overlaps the commands entry "tools". ${loadsNone} Keep one of them.`,
      ],
    },
    {
      case: "a script inside a context folder",
      lines: [
        "context:",
        "  - path: tools",
        "scripts:",
        "  - name: run",
        "    path: tools/run.ts",
        "    description: Run",
      ],
      says: [
        `The context entry "tools" overlaps the scripts entry "run". ${loadsNone} Add exclude: ["run.ts"] to the context entry "tools", or keep one of them.`,
        `The scripts entry "run" overlaps the context entry "tools". ${loadsNone} Add exclude: ["run.ts"] to the context entry "tools", or keep one of them.`,
      ],
    },
    {
      case: "a context folder inside one declared skill",
      lines: ["skills:", "  - path: skills/a", "context:", "  - path: skills/a/references"],
      says: [
        `The context entry "skills/a/references" overlaps the skills entry "skills/a". ${loadsNone} Keep one of them.`,
        `The skills entry "skills/a" overlaps the context entry "skills/a/references". ${loadsNone} Keep one of them.`,
      ],
    },
    {
      case: "two scripts on one file, each named by its own name",
      lines: [
        "scripts:",
        "  - name: run",
        "    path: tools/run.ts",
        "    description: Run",
        "  - name: go",
        "    path: tools/run.ts",
        "    description: Go",
      ],
      says: [
        `The scripts entry "go" overlaps the scripts entry "run". ${loadsNone} Keep one of them.`,
        `The scripts entry "run" overlaps the scripts entry "go". ${loadsNone} Keep one of them.`,
      ],
    },
    {
      case: "a docs folder inside a skills folder",
      lines: ["skills:", "  - path: skills", "docs:", "  - name: kb", "    path: skills/vendor"],
      says: [
        `The docs entry "kb" overlaps the skills entry "skills". ${loadsNone} Add exclude: ["vendor/**"] to the skills entry "skills", or keep one of them.`,
        `The skills entry "skills" overlaps the docs entry "kb". ${loadsNone} Add exclude: ["vendor/**"] to the skills entry "skills", or keep one of them.`,
      ],
    },
    {
      case: "a docs folder that holds a declared skill, which no docs exclude can end",
      lines: ["skills:", "  - path: skills/a", "docs:", "  - name: kb", "    path: skills"],
      says: [
        `The docs entry "kb" overlaps the skills entry "skills/a". ${loadsNone} Keep one of them.`,
        `The skills entry "skills/a" overlaps the docs entry "kb". ${loadsNone} Keep one of them.`,
      ],
    },
    {
      case: "a docs folder on a script",
      lines: [
        "scripts:",
        "  - name: run",
        "    path: tools/run.ts",
        "    description: Run",
        "docs:",
        "  - name: kb",
        "    path: tools",
      ],
      says: [
        `The docs entry "kb" overlaps the scripts entry "run". ${loadsNone} Keep one of them.`,
        `The scripts entry "run" overlaps the docs entry "kb". ${loadsNone} Keep one of them.`,
      ],
    },
    {
      case: "two docs on one folder, each named by its own name",
      lines: [
        "skills: []",
        "docs:",
        "  - name: kb",
        "    path: tools",
        "  - name: ref",
        "    path: tools",
      ],
      says: [
        `The docs entry "kb" overlaps the docs entry "ref". ${loadsNone} Keep one of them.`,
        `The docs entry "ref" overlaps the docs entry "kb". ${loadsNone} Keep one of them.`,
      ],
    },
    {
      case: "a docs folder inside another",
      lines: [
        "skills: []",
        "docs:",
        "  - name: kb",
        "    path: skills",
        "  - name: ref",
        "    path: skills/a",
      ],
      says: [
        `The docs entry "kb" overlaps the docs entry "ref". ${loadsNone} Keep one of them.`,
        `The docs entry "ref" overlaps the docs entry "kb". ${loadsNone} Keep one of them.`,
      ],
    },
  ])("$case still overlaps, and the message names the fix", (row) =>
    withSource(
      declare("source", ...row.lines),
      {
        "skills/a/SKILL.md": bareSkillText("a"),
        "skills/a/references/guide.md": "guide",
        "skills/vendor/b/SKILL.md": bareSkillText("b"),
        "tools/run.ts": "export {}",
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual([]);
          expect(
            catalog.quarantined
              .filter(({ code }) => code === "declaration-path-overlap")
              .map(({ message }) => message)
              .sort(),
          ).toEqual(row.says);
        }),
    ),
  );

  test.effect.each([
    { case: "passes over leaves it", inner: "_drafts", loads: ["docs/drafts", "docs/site"] },
    { case: "walks overlaps it", inner: "notes", loads: [] },
  ])("a folder that a docs . entry $case", (row) =>
    withSource(
      declare(
        "source",
        "docs:",
        "  - name: site",
        "    path: .",
        "  - name: drafts",
        `    path: ${row.inner}`,
      ),
      { "_drafts/a.md": "a", "notes/b.md": "b" },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(row.loads);
          expect(quarantines(catalog)).toEqual(
            row.loads.length === 0
              ? ["docs:declaration-path-overlap", "docs:declaration-path-overlap"]
              : [],
          );
        }),
    ),
  );

  test.effect("a declared symlink inside the source is accepted", () =>
    withSource(
      declare("source", "skills:", "  - path: shared"),
      { "lib/skills/a/SKILL.md": bareSkillText("a") },
      (fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.symlink(
            path.join(fixture.root, "lib/skills"),
            path.join(fixture.root, "shared"),
          );
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["skill/a"]);
          expect(catalog.quarantined).toEqual([]);
        }),
    ),
  );

  test.effect("a symlink inside a declared folder that leaves it is a boundary violation", () =>
    withSource(
      declare("source", "skills:", "  - path: skills", "  - path: lib"),
      {
        "skills/real/SKILL.md": bareSkillText("real"),
        "lib/inside/SKILL.md": bareSkillText("inside"),
      },
      (fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.symlink(
            path.join(fixture.root, "lib/inside"),
            path.join(fixture.root, "skills/inside"),
          );
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog).sort()).toEqual(["skill/inside", "skill/real"]);
          expect(quarantines(catalog)).toEqual(["skill:resource-boundary-violation"]);
        }),
    ),
  );

  test.effect(
    "a boundary violation inside a skill folder is reported and the skill still loads",
    () =>
      withSource(
        declare("source", "skills:", "  - path: skills"),
        { "skills/pdf/SKILL.md": bareSkillText("pdf"), "outside/x.txt": "x" },
        (fixture) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            yield* fs.symlink(
              path.join(fixture.root, "outside"),
              path.join(fixture.root, "skills/pdf/assets"),
            );
            const catalog = yield* catalogOf(fixture);
            expect(resources(catalog)).toEqual(["skill/pdf"]);
            expect(quarantines(catalog)).toEqual(["skill:resource-boundary-violation"]);
          }),
      ),
  );

  test.effect("context declared twice with one file name quarantines both items", () =>
    withSource(
      declare("source", "context:", "  - path: context", "  - path: notes"),
      { "context/team.md": "a", "notes/team.md": "b", "notes/solo.md": "c" },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["context/solo.md"]);
          expect(quarantines(catalog)).toEqual([
            "context:resource-address-duplicate",
            "context:resource-address-duplicate",
          ]);
        }),
    ),
  );

  test.effect("scripts are cataloged by declared name and scripts/tack.yaml is not read", () =>
    withSource(
      declare(
        "source",
        "scripts:",
        "  - name: report",
        "    path: tools/report.ts",
        "    description: Generate the report.",
        "  - name: dup",
        "    path: tools/a.ts",
        "    description: A",
        "  - name: dup",
        "    path: tools/b.ts",
        "    description: B",
      ),
      {
        "tools/report.ts": "export {}",
        "tools/a.ts": "export {}",
        "tools/b.ts": "export {}",
        "scripts/tack.yaml": "this is: [not valid\n",
        "scripts/left-over.ts": "export {}",
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["script/report"]);
          const report = catalog.entries.find((entry) => entry.address.name === "report");
          expect(report).toMatchObject({
            declaredPath: "tools/report.ts",
            description: "Generate the report.",
          });
          expect(quarantines(catalog)).toEqual([
            "script:resource-address-duplicate",
            "script:resource-address-duplicate",
          ]);
        }),
    ),
  );

  test.effect.each([
    ["tack-sources", "each project"],
    ["tack-user-sources", "the user"],
  ] as const)(
    "quarantines a skill named %s, which Tack reserves for the skill it generates",
    ([name, owner]) =>
      withSource(
        declare("source", "skills: [{ path: skills }]"),
        {
          [`skills/${name}/SKILL.md`]: bareSkillText(name),
          "skills/review/SKILL.md": bareSkillText("review"),
        },
        (fixture) =>
          Effect.gen(function* () {
            const catalog = yield* catalogOf(fixture);
            expect(resources(catalog)).toEqual(["skill/review"]);
            expect(quarantines(catalog)).toEqual(["skill:skill-name-reserved"]);
            expect(catalog.quarantined[0]?.message).toBe(
              `Tack reserves the skill name ${name} for the skill it generates for ${owner}. Rename this skill.`,
            );
          }),
      ),
  );

  test.effect("reports a source's description and rules on its inspection", () =>
    withSource(
      declare(
        "source",
        "description: The team handbook.",
        "rules:",
        "  description: Before any edit.",
        "  body: Branch first.",
        "docs: []",
      ),
      {},
      (fixture) =>
        Effect.gen(function* () {
          yield* registerSource(fixture.options, { sourcePath: fixture.root });
          const inspections = yield* inspectSources(yield* readState(fixture.options));
          expect(
            inspections.find(({ registration }) => registration.canonicalPath === fixture.root),
          ).toMatchObject({
            description: "The team handbook.",
            rules: { description: "Before any edit.", body: "Branch first." },
          });
        }),
    ),
  );

  test.effect("a source that declares nothing is healthy and warned about", () =>
    withSource(declare("bare"), { "notes/readme.md": "# hi" }, (fixture) =>
      Effect.gen(function* () {
        yield* registerSource(fixture.options, { sourcePath: fixture.root });
        const inspections = yield* inspectSources(yield* readState(fixture.options));
        const inspection = inspections.find(
          ({ registration }) => registration.canonicalPath === fixture.root,
        );
        expect(inspection).toMatchObject({
          status: "healthy",
          warnings: [{ code: "source-declares-no-resources" }],
        });
        expect(JSON.stringify(inspection)).toContain("manage-tack-sources");
        expect(resources(yield* resolveCatalogAt(fixture.options))).toEqual([]);
      }),
    ),
  );

  test.effect("a source with docs or an entry is not warned about", () =>
    withSource(
      declare("source", "docs:", "  - name: kb", "    path: notes"),
      { "notes/a.md": "# A" },
      (fixture) =>
        Effect.gen(function* () {
          yield* registerSource(fixture.options, { sourcePath: fixture.root });
          const inspections = yield* inspectSources(yield* readState(fixture.options));
          expect(inspections.flatMap((inspection) => inspection.warnings ?? [])).toEqual([]);
        }),
    ),
  );

  test.effect(
    "the underscore fixture of #73 keeps its catalog with declarations and a pattern",
    () =>
      withSource(
        declare(
          "source",
          "skills:",
          "  - path: skills",
          '    exclude: ["**/_*/**"]',
          "commands:",
          "  - path: commands",
          '    exclude: ["**/_*/**"]',
          "context:",
          "  - path: context",
          '    exclude: ["**/_*/**"]',
          "scripts:",
          "  - name: run",
          "    path: scripts/run.ts",
          "    description: Run it",
        ),
        {
          "skills/kept/SKILL.md": bareSkillText("kept"),
          "skills/_archive/adhd/SKILL.md": bareSkillText("adhd"),
          "skills/_wip/deep/er/SKILL.md": bareSkillText("deeper"),
          "skills/kept/_old/x.txt": "x",
          "skills/_archive/broken/SKILL.md": "no frontmatter",
          "commands/kept.md": "# Kept",
          "commands/_archive/old.md": "# Old",
          "commands/group/_wip/draft.md": "# Draft",
          "context/_kept-file.md": "# Files may start with an underscore",
          "context/kept.md": "x",
          "context/_wip/notes.md": "x",
          "context/group/_old/notes.md": "x",
          "scripts/run.ts": "export {}",
        },
        (fixture) =>
          Effect.gen(function* () {
            const catalog = yield* catalogOf(fixture);
            expect(resources(catalog)).toEqual([
              "command/kept",
              "context/_kept-file.md",
              "context/kept.md",
              "script/run",
              "skill/kept",
            ]);
            expect(catalog.quarantined).toEqual([]);
            expect(catalog.unhealthySources).toEqual([]);
          }),
      ),
  );

  test.effect("an entry that names the source declaration is not a resource", () =>
    withSource(declare("source", "skills: []", "context:", "  - path: tack.yaml"), {}, (fixture) =>
      Effect.gen(function* () {
        const catalog = yield* catalogOf(fixture);
        expect(quarantines(catalog)).toEqual(["context:declaration-path-invalid"]);
        expect(catalog.quarantined[0]?.message).toContain(
          "names the source declaration, which is not a resource",
        );
      }),
    ),
  );

  test.effect("a command entry that names one file takes no include or exclude", () =>
    withSource(
      declare("source", "commands:", "  - path: commands/ship.md", "    include: ['x']"),
      { "commands/ship.md": "# Ship" },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(quarantines(catalog)).toEqual(["command:declaration-entry-invalid"]);
          expect(catalog.quarantined[0]?.message).toContain("names one file, so include");
        }),
    ),
  );

  test.effect("names that no address can spell are still candidates that get quarantined", () =>
    withSource(
      declare(
        "source",
        "skills:",
        "  - path: skills",
        "  - path: labs/Bad_Single",
        "  - path: labs/not-a-skill",
        "commands:",
        "  - path: commands/Bad_Name.md",
      ),
      {
        "skills/Bad_Folder/SKILL.md": bareSkillText("bad-folder"),
        "skills/good/SKILL.md": bareSkillText("good"),
        "labs/Bad_Single/SKILL.md": bareSkillText("bad-single"),
        // A folder named SKILL.md is not a skill file, so this entry declares nothing.
        "labs/not-a-skill/SKILL.md/readme.md": "x",
        "commands/Bad_Name.md": "# Bad",
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["skill/good"]);
          expect(
            catalog.quarantined
              .map(({ directoryPath }) => directoryPath.slice(fixture.root.length))
              .sort(),
          ).toEqual(["/commands", "/labs/Bad_Single", "/skills/Bad_Folder"]);
          expect(catalog.quarantined.every(({ address }) => address === undefined)).toBe(true);
        }),
    ),
  );

  test.effect("an excluded walk passes over an entry it cannot stat", () =>
    withSource(
      declare("source", "skills:", "  - path: skills", "    exclude: ['**/_*/**']"),
      { "skills/good/SKILL.md": bareSkillText("good") },
      (fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.symlink("missing-target", path.join(fixture.root, "skills", "dangling"));
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["skill/good"]);
        }),
    ),
  );

  test.effect("a commands folder that cannot be read is quarantined as unreadable", () =>
    withSource(
      declare("source", "commands:", "  - path: commands"),
      { "commands/ship.md": "# Ship", "commands/locked/review.md": "# Review" },
      (fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const locked = path.join(fixture.root, "commands", "locked");
          yield* fs.chmod(locked, 0o000);
          const catalog = yield* catalogOf(fixture).pipe(
            Effect.ensuring(fs.chmod(locked, 0o755).pipe(Effect.orDie)),
          );
          expect(resources(catalog)).toEqual(["command/ship"]);
          expect(quarantines(catalog)).toEqual(["command:resource-unreadable"]);
        }),
    ),
  );

  test.effect("lists only declared skills folders, never one skill or an invalid entry", () =>
    withSource(
      declare(
        "source",
        "skills:",
        "  - path: skills",
        "  - path: labs/one",
        "  - path: missing",
        "    include: ['**']",
      ),
      { "skills/good/SKILL.md": bareSkillText("good"), "labs/one/SKILL.md": bareSkillText("one") },
      (fixture) =>
        Effect.gen(function* () {
          yield* registerSource(fixture.options, { sourcePath: fixture.root });
          const inspections = yield* inspectSources(yield* readState(fixture.options));
          const inspection = inspections.find(
            (candidate) => candidate.registration.canonicalPath === fixture.root,
          );
          if (inspection?.status !== "healthy") throw new Error("Expected a healthy source.");
          const folders = yield* declaredSkillsFolders(
            inspection.registration,
            inspection.declaration,
          );
          expect(folders).toEqual([
            {
              declaredPath: "skills",
              resolved: `${fixture.root}/skills`,
              include: undefined,
              exclude: undefined,
            },
          ]);
        }),
    ),
  );

  test.effect("a declared path below a file and an unreadable command are quarantined", () =>
    withSource(
      declare(
        "source",
        "commands:",
        "  - path: commands",
        "  - path: notes.md/inner",
        "docs:",
        "  - name: handbook",
      ),
      { "commands/ship.md": "# Ship", "commands/locked.md": "# Locked", "notes.md": "x" },
      (fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const locked = path.join(fixture.root, "commands", "locked.md");
          yield* fs.chmod(locked, 0o000);
          const catalog = yield* catalogOf(fixture).pipe(
            Effect.ensuring(fs.chmod(locked, 0o644).pipe(Effect.orDie)),
          );
          expect(resources(catalog)).toEqual(["command/ship"]);
          expect(quarantines(catalog)).toEqual([
            "command:resource-unreadable",
            "command:resource-unreadable",
            "docs:declaration-invalid",
          ]);
        }),
    ),
  );

  test.effect.each([
    { label: "lies inside", key: "skills", entry: "vendor/skills", kind: "skill" },
    { label: "is", key: "skills", entry: "vendor", kind: "skill" },
    { label: "lies inside", key: "commands", entry: "vendor/commands/ship.md", kind: "command" },
    { label: "lies inside", key: "context", entry: "vendor/notes", kind: "context" },
  ])("a $key entry that $label another source is refused", ({ key, entry, kind }) =>
    withSource(
      declare("source", `${key}:`, `  - path: ${entry}`),
      {
        "vendor/tack.yaml": declare("vendor"),
        "vendor/skills/lint/SKILL.md": bareSkillText("lint"),
        "vendor/commands/ship.md": "# Ship",
        "vendor/notes/a.md": "a",
        "vendor/lint/SKILL.md": bareSkillText("lint"),
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual([]);
          expect(quarantines(catalog)).toEqual([`${kind}:declaration-reaches-source`]);
          expect(catalog.quarantined[0]?.message).toContain(
            "vendor, which holds its own tack.yaml and is another source",
          );
        }),
    ),
  );

  test.effect("a scripts or docs entry inside another source is refused too", () =>
    withSource(
      declare(
        "source",
        "scripts:",
        "  - { name: run, path: vendor/run.ts, description: Run }",
        "docs:",
        "  - { name: kb, path: vendor/kb }",
      ),
      {
        "vendor/tack.yaml": declare("vendor"),
        "vendor/run.ts": "export {}",
        "vendor/kb/index.md": "# Kb",
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual([]);
          expect(quarantines(catalog)).toEqual([
            "docs:declaration-reaches-source",
            "script:declaration-reaches-source",
          ]);
        }),
    ),
  );

  test.effect("a folder that holds SKILL.md and tack.yaml is a skill, never another source", () =>
    withSource(
      declare("source", "skills:", "  - path: skills", "  - path: lone"),
      {
        "skills/fmt/SKILL.md": bareSkillText("fmt"),
        "skills/fmt/tack.yaml": declare("fmt"),
        "skills/fmt/examples/tack.yaml": declare("examples"),
        "lone/SKILL.md": bareSkillText("lone"),
        "lone/tack.yaml": declare("lone"),
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["skill/fmt", "skill/lone"]);
          expect(catalog.quarantined).toEqual([]);
        }),
    ),
  );

  test.effect.each([
    { key: "skills", kind: "skill", own: "skills/review/SKILL.md", nested: "lint/SKILL.md" },
    { key: "commands", kind: "command", own: "commands/review.md", nested: "lint.md" },
    { key: "context", kind: "context", own: "context/review.md", nested: "lint.md" },
  ])(
    "a $key walk that meets another source skips that folder and reports it",
    ({ key, kind, own, nested }) =>
      withSource(
        declare("source", `${key}:`, `  - path: ${key}`),
        {
          [own]: own.endsWith("SKILL.md") ? bareSkillText("review") : "# Review",
          [`${key}/team/vendor/tack.yaml`]: declare("vendor"),
          [`${key}/team/vendor/${nested}`]: nested.endsWith("SKILL.md")
            ? bareSkillText("lint")
            : "# Lint",
        },
        (fixture) =>
          Effect.gen(function* () {
            const catalog = yield* catalogOf(fixture);
            expect(resources(catalog)).toEqual([
              kind === "context" ? "context/review.md" : `${kind}/review`,
            ]);
            expect(quarantines(catalog)).toEqual([`${kind}:declaration-reaches-source`]);
            expect(catalog.quarantined[0]?.message).toBe(
              `The ${key} entry "${key}" reaches ${key}/team/vendor, which holds its own tack.yaml and is another source, so Tack skipped it. Add exclude: ["team/vendor/**"] to the entry, or delete ${key}/team/vendor/tack.yaml to keep what it holds in this source.`,
            );
          }),
      ),
  );

  test.effect("an exclude that prunes another source's folder silences the walk", () =>
    withSource(
      declare("source", "skills:", "  - path: skills", '    exclude: ["vendor/**"]'),
      {
        "skills/review/SKILL.md": bareSkillText("review"),
        "skills/vendor/tack.yaml": declare("vendor"),
        "skills/vendor/lint/SKILL.md": bareSkillText("lint"),
      },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["skill/review"]);
          expect(catalog.quarantined).toEqual([]);
        }),
    ),
  );

  test.effect("a source nested in a declared folder is cataloged once, by its own source", () =>
    withSource(
      declare("source", "skills:", "  - path: skills"),
      {
        "skills/review/SKILL.md": bareSkillText("review"),
        "skills/vendor/tack.yaml": declare("vendor", "skills:", "  - path: lint"),
        "skills/vendor/lint/SKILL.md": bareSkillText("lint"),
      },
      (fixture) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          yield* registerSource(fixture.options, {
            sourcePath: path.join(fixture.root, "skills", "vendor"),
          });
          const catalog = yield* catalogOf(fixture);
          expect(
            catalog.entries
              .filter((entry) => entry.origin !== "builtin")
              .map((entry) => `${entry.address.name} ${entry.sourcePath}`)
              .sort(),
          ).toEqual([
            `lint ${path.join(fixture.root, "skills", "vendor")}`,
            `review ${fixture.root}`,
          ]);
          expect(quarantines(catalog)).toEqual(["skill:declaration-reaches-source"]);
        }),
    ),
  );

  test.effect(
    "a skills entry at . walks the source folder past dot, underscore, node_modules and other sources",
    () =>
      withSource(
        declare("source", "skills:", "  - path: ."),
        {
          "review/SKILL.md": bareSkillText("review"),
          "review/examples/tack.yaml": declare("examples"),
          "team/lint/SKILL.md": bareSkillText("lint"),
          "Bad/SKILL.md": bareSkillText("Bad"),
          ".claude/hidden/SKILL.md": bareSkillText("hidden"),
          "_drafts/old/SKILL.md": bareSkillText("old"),
          "node_modules/pkg/SKILL.md": bareSkillText("pkg"),
          "team/_wip/next/SKILL.md": bareSkillText("next"),
          "handbook/tack.yaml": declare("handbook", "docs:", "  - name: handbook", "    path: ."),
          "handbook/sample/SKILL.md": bareSkillText("sample"),
          "README.md": "# Skills",
        },
        (fixture) =>
          Effect.gen(function* () {
            const catalog = yield* catalogOf(fixture);
            expect(catalog.unhealthySources).toEqual([]);
            expect(resources(catalog)).toEqual(["skill/lint", "skill/review"]);
            expect(quarantines(catalog)).toEqual(["skill:skill-frontmatter-schema-invalid"]);
            expect(
              catalog.entries.find((entry) => entry.address.name === "review")?.declaredPath,
            ).toBe(".");
          }),
      ),
  );

  test.effect("a skills entry at . checks that a skill's content stays inside the source", () =>
    withSource(
      declare("source", "skills:", "  - path: ."),
      { "review/SKILL.md": bareSkillText("review") },
      (fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const outside = path.join(path.dirname(fixture.root), "outside");
          yield* fs.makeDirectory(path.join(outside, "linked"), { recursive: true });
          yield* fs.writeFileString(
            path.join(outside, "linked", "SKILL.md"),
            bareSkillText("linked"),
          );
          yield* fs.writeFileString(path.join(outside, "secret.md"), "secret");
          yield* fs.symlink(path.join(outside, "linked"), path.join(fixture.root, "linked"));
          yield* fs.symlink(
            path.join(outside, "secret.md"),
            path.join(fixture.root, "review", "secret.md"),
          );
          const catalog = yield* catalogOf(fixture);
          expect(resources(catalog)).toEqual(["skill/review"]);
          expect(quarantines(catalog)).toEqual([
            "skill:resource-boundary-violation",
            "skill:resource-boundary-violation",
          ]);
        }),
    ),
  );

  test.effect("a commands entry at . reads every command below the source folder", () =>
    withSource(
      declare("source", "commands:", "  - path: .", '    exclude: ["README.md"]'),
      {
        "deploy.md": "# Deploy",
        "README.md": "# Commands",
        "_old.md": "# Old",
        "notes.txt": "notes",
        "team/ship.md": "# Ship",
      },
      (fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const outside = path.join(path.dirname(fixture.root), "outside.md");
          yield* fs.writeFileString(outside, "# Outside");
          yield* fs.symlink(outside, path.join(fixture.root, "escape.md"));
          const catalog = yield* catalogOf(fixture);
          expect(catalog.unhealthySources).toEqual([]);
          expect(resources(catalog)).toEqual(["command/deploy", "command/ship"]);
          expect(quarantines(catalog)).toEqual(["command:resource-boundary-violation"]);
        }),
    ),
  );

  test.effect("a docs entry at . is the whole source folder as one docs resource", () =>
    withSource(
      declare("notes", "docs:", "  - name: notes", "    path: ."),
      { "index.md": "# Notes" },
      (fixture) =>
        Effect.gen(function* () {
          const catalog = yield* catalogOf(fixture);
          expect(catalog.unhealthySources).toEqual([]);
          expect(resources(catalog)).toEqual(["docs/notes"]);
          expect(catalog.entries.find((entry) => entry.address.kind === "docs")).toMatchObject({
            declaredPath: ".",
            directoryPath: fixture.root,
          });
        }),
    ),
  );

  test.effect("a context entry at . is refused: context would take every file", () =>
    withSource(declare("source", "context:", "  - path: ."), { "rules.md": "# Rules" }, (fixture) =>
      Effect.gen(function* () {
        const catalog = yield* catalogOf(fixture);
        expect(resources(catalog)).toEqual([]);
        expect(catalog.quarantined.map(({ code, message }) => ({ code, message }))).toEqual([
          {
            code: "declaration-path-invalid",
            message:
              'The context entry "." names the source folder itself, where context would take every file, the tack.yaml too. Name the folder or file that holds the context.',
          },
        ]);
      }),
    ),
  );

  test.effect(
    "a skills entry at . in a folder that holds SKILL.md is one skill, not a source",
    () =>
      withSource(
        declare("source", "skills:", "  - path: ."),
        { "SKILL.md": bareSkillText("source") },
        (fixture) =>
          Effect.gen(function* () {
            const registered = yield* registerSource(fixture.options, {
              sourcePath: fixture.root,
            }).pipe(Effect.flip);
            expect(registered).toMatchObject({
              code: "source-is-one-skill",
              message: `${fixture.root} holds SKILL.md, so it is one skill, not a folder of skills. Register the folder that holds it, or import it into a source with tack import add.`,
            });
          }),
      ),
  );

  test.effect.each([
    { key: "skills", files: { "skills/review/SKILL.md": bareSkillText("review") } },
    { key: "commands", files: {} },
  ])("a $key entry at . is never warned about undeclared or missing resources", (row) =>
    withSource(declare("source", `${row.key}:`, "  - path: ."), row.files, (fixture) =>
      Effect.gen(function* () {
        yield* registerSource(fixture.options, { sourcePath: fixture.root });
        const inspections = yield* inspectSources(yield* readState(fixture.options));
        expect(
          inspections.find(({ registration }) => registration.canonicalPath === fixture.root),
        ).toMatchObject({ status: "healthy" });
        expect(
          inspections.find(({ registration }) => registration.canonicalPath === fixture.root),
        ).not.toHaveProperty("warnings");
      }),
    ),
  );
});
