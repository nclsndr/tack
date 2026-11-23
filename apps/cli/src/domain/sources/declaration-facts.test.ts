import { bareSkillText } from "../../../test/support/source-tree.ts";
import {
  inspectSourcesWithDeclarations,
  resolveCatalogAt,
} from "../../../test/support/snapshot-helpers.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { initializeState, type StateOptions } from "../../services/state-store.ts";

import { registerSource } from "../../features/sources/source.ts";
import { loadsNothing } from "./declaration-facts.ts";

type Fixture = { readonly root: string; readonly options: StateOptions };

const withSource = <A, E, R>(
  declaration: string,
  files: Readonly<Record<string, string>>,
  use: (fixture: Fixture) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "tack-declaration-facts-" }),
    );
    const options = {
      environment: { TACK_STATE_DIR: path.join(base, "state") },
      homeDirectory: base,
    } satisfies StateOptions;
    yield* initializeState(options);
    const root = path.join(base, "source");
    yield* fs.makeDirectory(root, { recursive: true });
    yield* fs.writeFileString(path.join(root, "tack.yaml"), declaration);
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, content);
    }
    yield* registerSource(options, { sourcePath: root });
    return yield* use({ root, options });
  });

const declarationsOf = (options: StateOptions, root: string) =>
  inspectSourcesWithDeclarations(options).pipe(
    Effect.map((sources) => {
      const source = sources.find(({ registration }) => registration.canonicalPath === root);
      return source !== undefined && source.status === "healthy" ? source.declarations : [];
    }),
  );

it.layer(LiveTestLayer)("declaration facts", (test) => {
  test.effect("lists each declaration in file order with its patterns and resource count", () =>
    withSource(
      [
        "version: 1",
        "name: source",
        "skills:",
        "  - path: skills",
        "    exclude: ['**/_*/**']",
        "  - path: vendor/skills",
        "  - path: labs/solo",
        "commands:",
        "  - path: commands",
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
        "",
      ].join("\n"),
      {
        "skills/a/SKILL.md": bareSkillText("a"),
        "skills/b/SKILL.md": bareSkillText("b"),
        "skills/_old/c/SKILL.md": bareSkillText("c"),
        "vendor/skills/.keep": "",
        "labs/solo/SKILL.md": bareSkillText("solo"),
        "commands/ship.md": "# Ship",
        "context/notes.md": "x",
        "context/skip.txt": "x",
        "tools/report.ts": "export {}",
        "knowledge/readme.md": "x",
      },
      ({ root, options }) =>
        Effect.gen(function* () {
          expect(yield* declarationsOf(options, root)).toEqual([
            { kind: "skill", path: "skills", exclude: ["**/_*/**"], resources: 2, problems: [] },
            { kind: "skill", path: "vendor/skills", resources: 0, problems: [] },
            { kind: "skill", path: "labs/solo", resources: 1, problems: [] },
            { kind: "command", path: "commands", resources: 1, problems: [] },
            { kind: "context", path: "context", include: ["**/*.md"], resources: 1, problems: [] },
            { kind: "script", path: "tools/report.ts", name: "report", resources: 1, problems: [] },
            { kind: "docs", path: "knowledge", name: "handbook", resources: 1, problems: [] },
          ]);
        }),
    ),
  );

  test.effect("attributes entry, walk and duplicate problems to the declaration behind them", () =>
    withSource(
      [
        "version: 1",
        "name: source",
        "skills:",
        "  - path: skills",
        "  - path: more",
        "  - pth: typo",
        "  - path: nowhere",
        "  - path: ov",
        "  - path: ov/inner",
        "docs:",
        "  - name: gone",
        "    path: missing",
        "",
      ].join("\n"),
      {
        "skills/dup/SKILL.md": bareSkillText("dup"),
        "skills/broken/SKILL.md": "no frontmatter",
        "more/dup/SKILL.md": bareSkillText("dup"),
        "more/fine/SKILL.md": bareSkillText("fine"),
        "ov/inner/q/SKILL.md": bareSkillText("q"),
      },
      ({ root, options }) =>
        Effect.gen(function* () {
          const facts = yield* declarationsOf(options, root);
          const codes = (index: number) =>
            (facts[index]?.problems ?? []).map(({ code }) => code).sort();
          expect(facts.map(({ resources }) => resources)).toEqual([0, 1, 0, 0, 0, 0, 0]);
          expect(codes(0)).toEqual(["skill-address-duplicate", "skill-frontmatter-missing"]);
          expect(codes(1)).toEqual(["skill-address-duplicate"]);
          expect(codes(2)).toEqual(["declaration-entry-invalid"]);
          expect(facts[2]?.path).toBeUndefined();
          expect(codes(3)).toEqual(["declaration-path-missing"]);
          expect(codes(4)).toEqual(["declaration-path-overlap"]);
          expect(codes(5)).toEqual(["declaration-path-overlap"]);
          expect(facts[6]).toMatchObject({ kind: "docs", name: "gone" });
          expect(codes(6)).toEqual(["declaration-path-missing"]);
          const withPath = facts[0]?.problems.find(
            ({ code }) => code === "skill-frontmatter-missing",
          );
          expect(withPath?.candidatePath).toContain("skills/broken");
        }),
    ),
  );

  test.effect("records the declared path on every catalog entry that a declaration found", () =>
    withSource(
      [
        "version: 1",
        "name: source",
        "skills:",
        "  - path: vendor/skills",
        "commands:",
        "  - path: prompts/review.md",
        "context:",
        "  - path: context",
        "scripts:",
        "  - name: report",
        "    path: tools/report.ts",
        "    description: Report",
        "docs:",
        "  - name: handbook",
        "    path: knowledge",
        "",
      ].join("\n"),
      {
        "vendor/skills/pdf/SKILL.md": bareSkillText("pdf"),
        "prompts/review.md": "# Review",
        "context/team/notes.md": "x",
        "tools/report.ts": "export {}",
        "knowledge/readme.md": "x",
      },
      ({ options }) =>
        Effect.gen(function* () {
          const catalog = yield* resolveCatalogAt(options);
          const declared = catalog.entries
            .filter((entry) => entry.origin !== "builtin")
            .map(
              (entry) =>
                `${entry.address.kind}/${entry.address.name}:${"declaredPath" in entry ? entry.declaredPath : "-"}`,
            )
            .sort();
          expect(declared).toEqual([
            "command/review:prompts/review.md",
            "context/team/notes.md:context",
            "docs/handbook:knowledge",
            "script/report:tools/report.ts",
            "skill/pdf:vendor/skills",
          ]);
        }),
    ),
  );
});

const problem = { code: "declaration-path-missing", message: "The folder is missing." };

it.each([
  {
    case: "every declaration has a problem and loads nothing",
    facts: [
      [0, 1],
      [0, 2],
    ],
    broken: true,
  },
  {
    case: "one declaration loads despite its problem",
    facts: [
      [0, 1],
      [3, 1],
    ],
    broken: false,
  },
  {
    case: "one declaration loads nothing but has no problem",
    facts: [
      [0, 1],
      [0, 0],
    ],
    broken: false,
  },
  { case: "nothing is declared", facts: [], broken: false },
])("a source loads nothing when $case: $broken", ({ facts, broken }) => {
  expect(
    loadsNothing(
      facts.map(([resources = 0, problems = 0]) => ({
        resources,
        problems: Array.from({ length: problems }, () => problem),
      })),
    ),
  ).toBe(broken);
});
