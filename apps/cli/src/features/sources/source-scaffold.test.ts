import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { seedSource, skillText } from "../../../test/support/source-tree.ts";
import { Yaml } from "../../domain/runtime-neutral.ts";
import type { SourceDeclaration } from "../../domain/sources/source-schema.ts";
import { checkSource } from "./source-check.ts";
import {
  planSourceScaffold,
  refuseScaffoldInsideSources,
  scaffoldLoadsNothing,
  writeSourceScaffold,
} from "./source-scaffold.ts";

/** A fresh source folder named `folder` holding `files`, without tack.yaml unless `files` has one. */
const sourceOf = (files: Readonly<Record<string, string>>, folder = "source") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "tack-scaffold-" }),
    );
    return yield* seedSource((yield* Path.Path).join(root, folder), files);
  });

/** A config as `source add --config` takes it: pretty-printed JSON, given as the flag's value. */
const configOf = (declaration: unknown) => ({
  text: JSON.stringify(declaration, null, 2),
  origin: "argument" as const,
});

/** The files of a source that holds every kind, each in its own folder. */
const everyKind = {
  "personal/skills/review/SKILL.md": skillText("review"),
  "personal/skills/group/commit/SKILL.md": skillText("commit"),
  "alpha/documents/index.md": "# Alpha",
  "prompts/ship.md": "Ship it",
  "notes/guide.md": "Guide",
  "tools/report.ts": "export {}",
};

it.layer(LiveTestLayer)("source declaration creation", (test) => {
  test.effect(
    "plans a config as the normalized tack.yaml it writes, which tack check reads the same way",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* sourceOf(everyKind);
        // Keys out of the schema's order, which the written tack.yaml puts back in order.
        const declaration = {
          docs: [{ path: "alpha/documents", name: "alpha" }],
          scripts: [{ name: "report", path: "tools/report.ts", description: "Weekly report" }],
          context: [{ path: "notes" }],
          commands: [{ path: "prompts" }],
          skills: [{ path: "personal/skills", exclude: ["**/_*/**"] }],
          name: "brain",
          version: 1,
        };
        const plan = yield* planSourceScaffold(root, configOf(declaration));
        expect(plan?.declarationPath).toBe(path.join(root, "tack.yaml"));
        expect(plan?.config).toBe("argument");
        expect(plan?.content).toBe(
          [
            "version: 1",
            "name: brain",
            "skills:",
            "  - path: personal/skills",
            "    exclude:",
            '      - "**/_*/**"',
            "commands:",
            "  - path: prompts",
            "context:",
            "  - path: notes",
            "scripts:",
            "  - name: report",
            "    path: tools/report.ts",
            "    description: Weekly report",
            "docs:",
            "  - path: alpha/documents",
            "    name: alpha",
            "",
          ].join("\n"),
        );
        expect(Yaml.parse(plan?.content ?? "")).toEqual(declaration);
        expect(
          plan?.entries.map(({ kind, path: at, resources }) => ({ kind, at, resources })),
        ).toEqual([
          { kind: "skill", at: "personal/skills", resources: ["commit", "review"] },
          { kind: "command", at: "prompts", resources: ["ship"] },
          { kind: "context", at: "notes", resources: ["guide.md"] },
          { kind: "script", at: "tools/report.ts", resources: ["report"] },
          { kind: "docs", at: "alpha/documents", resources: ["alpha"] },
        ]);
        // Once written, tack check counts what the plan's entries found.
        yield* fs.writeFileString(path.join(root, "tack.yaml"), plan?.content ?? "");
        const report = yield* checkSource(root);
        expect(report.findings).toEqual([]);
        expect(report.counts).toEqual({ skill: 2, command: 1, context: 1, script: 1, docs: 1 });
      }),
  );
  test.effect.each([
    {
      key: "skills",
      declaration: { version: 1, name: "skills", skills: [{ path: "." }] },
      files: { "review/SKILL.md": skillText("review") },
      entry: { kind: "skill", path: ".", resources: ["review"] },
    },
    {
      key: "commands",
      declaration: { version: 1, name: "prompts", commands: [{ path: "." }] },
      files: { "ship.md": "Ship it" },
      entry: { kind: "command", path: ".", resources: ["ship"] },
    },
    {
      key: "docs",
      declaration: { version: 1, name: "notes", docs: [{ name: "notes", path: "." }] },
      files: { "index.md": "# Notes" },
      entry: { kind: "docs", path: ".", name: "notes", resources: ["notes"] },
    },
  ])("plans the $key entry at . a config declares", (row) =>
    Effect.gen(function* () {
      const root = yield* sourceOf(row.files);
      const plan = yield* planSourceScaffold(root, configOf(row.declaration));
      expect(plan?.content).toBe(Yaml.stringify(row.declaration));
      expect(plan?.entries).toEqual([{ ...row.entry, findings: [] }]);
      expect(plan?.findings).toEqual([]);
    }),
  );
  test.effect("reports the problems of each entry as tack check, at their line in the config", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* sourceOf({
        "skills/review/SKILL.md": skillText("other"),
        "skills/fine/SKILL.md": skillText("fine"),
        "guide.md": "Not a folder of skills",
      });
      const plan = yield* planSourceScaffold(
        root,
        configOf({
          version: 1,
          name: "source",
          skills: [{ path: "skills" }, { path: "guide.md" }],
        }),
      );
      expect(plan?.entries).toEqual([
        {
          kind: "skill",
          path: "skills",
          resources: ["fine"],
          findings: [
            expect.objectContaining({
              code: "skill-name-mismatch",
              severity: "error",
              field: "skills[0]",
              file: path.join(root, "skills/review/SKILL.md"),
            }),
          ],
        },
        {
          kind: "skill",
          path: "guide.md",
          resources: [],
          findings: [
            {
              code: "declaration-path-wrong-type",
              severity: "error",
              message: expect.any(String),
              field: "skills[1]",
              file: path.join(root, "tack.yaml"),
              candidatePath: path.join(root, "guide.md"),
              line: 8,
            },
          ],
        },
      ]);
      expect(plan === undefined ? undefined : scaffoldLoadsNothing(plan)).toBeUndefined();
    }),
  );
  test.effect(
    "refuses to write a config every entry of which has a problem and finds nothing",
    () =>
      Effect.gen(function* () {
        const root = yield* sourceOf({ "README.md": "# Source" });
        const plan = yield* planSourceScaffold(
          root,
          configOf({ version: 1, name: "source", skills: [{ path: "nowhere" }] }),
        );
        expect(plan === undefined ? undefined : scaffoldLoadsNothing(plan)).toMatchObject({
          code: "declaration-loads-nothing",
        });
      }),
  );
  test.effect("keeps the warnings of the declaration as a whole beside its entries", () =>
    Effect.gen(function* () {
      const root = yield* sourceOf({ "README.md": "# Source" });
      const plan = yield* planSourceScaffold(root, configOf({ version: 1, name: "source" }));
      expect(plan?.entries).toEqual([]);
      expect(plan?.findings).toEqual([
        expect.objectContaining({ code: "source-declares-no-resources", severity: "warning" }),
      ]);
    }),
  );
  test.effect("refuses kind in a config with the JSON to pass instead", () =>
    Effect.gen(function* () {
      const root = yield* sourceOf({ "index.md": "# Notes" });
      const error = yield* Effect.flip(
        planSourceScaffold(root, configOf({ version: 1, name: "notes", kind: "docs" })),
      );
      expect(error).toMatchObject({
        _tag: "SourceConfigInvalidError",
        code: "declaration-schema-invalid",
        issues: [
          {
            field: "kind",
            line: 4,
            message:
              'A tack.yaml takes no kind key: a "." entry declares the folder that holds it. Write instead:\n  {"version":1,"name":"notes","docs":[{"name":"notes","path":"."}]}',
          },
        ],
      });
    }),
  );
  test.effect("reports every issue of a config that does not decode, at its line", () =>
    Effect.gen(function* () {
      const root = yield* sourceOf({ "skills/review/SKILL.md": skillText("review") });
      const error = yield* Effect.flip(
        planSourceScaffold(
          root,
          configOf({ version: 1, skils: [], maintainers: [""], skills: [{ path: "skills" }] }),
        ),
      );
      expect(error).toMatchObject({
        _tag: "SourceConfigInvalidError",
        code: "declaration-schema-invalid",
        config: "argument",
        issues: [
          {
            field: "skils",
            line: 3,
            message: expect.stringContaining('Unknown key "skils". A tack.yaml takes:'),
          },
          {
            field: "name",
            message:
              'tack.yaml has no name. Add "name: source" to it: the name is the source label that depends-on and source: references use on every machine.',
          },
          {
            field: "maintainers[0]",
            line: 5,
            message: "maintainers[0]: A maintainers entry must not be empty.",
          },
        ],
      });
    }),
  );
  test.effect.each([
    {
      case: "a skills entry at . whose folder holds SKILL.md",
      declaration: { version: 1, name: "source", skills: [{ path: "." }] },
      code: "source-is-one-skill",
    },
    {
      case: "folders of a kind it does not declare",
      declaration: { version: 1, name: "source", docs: [{ name: "kb", path: "kb" }] },
      code: "declaration-resources-undeclared",
    },
    {
      case: "an unsupported version",
      declaration: { version: 3, name: "source" },
      code: "declaration-version-unsupported",
    },
    { case: "a list", declaration: [{ version: 1 }], code: "declaration-root-not-mapping" },
  ])("refuses a config with $case as tack check refuses it", (row) =>
    Effect.gen(function* () {
      const root = yield* sourceOf({
        "SKILL.md": skillText("source"),
        "skills/review/SKILL.md": skillText("review"),
        "kb/index.md": "# Kb",
      });
      expect(yield* Effect.flip(planSourceScaffold(root, configOf(row.declaration)))).toMatchObject(
        {
          _tag: "SourceConfigInvalidError",
          code: row.code,
          issues: [{ message: expect.any(String) }],
        },
      );
    }),
  );
  test.effect.each([
    {
      case: "YAML",
      text: "version: 1\nname: source\n",
      says: "--config takes the declaration as JSON, or - to read it from standard input: ",
    },
    {
      case: "truncated JSON",
      text: '{"version": 1,',
      says: "--config takes the declaration as JSON, or - to read it from standard input: ",
    },
  ])("refuses a config in $case", (row) =>
    Effect.gen(function* () {
      const root = yield* sourceOf({ "README.md": "# Source" });
      const error = yield* Effect.flip(
        planSourceScaffold(root, { text: row.text, origin: "standard-input" }),
      );
      expect(error).toMatchObject({
        _tag: "SourceAddRequestError",
        code: "config-not-json",
        next: [["tack", "guide", "tack-yaml"]],
      });
      expect(error.message).toContain(row.says);
    }),
  );
  test.effect("refuses a config that declares imports, which only tack import writes", () =>
    Effect.gen(function* () {
      const root = yield* sourceOf({ "README.md": "# Source" });
      expect(
        yield* Effect.flip(
          planSourceScaffold(root, configOf({ version: 1, name: "source", imports: [] })),
        ),
      ).toMatchObject({ _tag: "SourceAddRequestError", code: "config-imports-not-allowed" });
    }),
  );
  test.effect.each([
    {
      case: "a valid tack.yaml",
      declaration: "version: 1\nname: source\nskills:\n  - path: skills\n",
    },
    { case: "a broken tack.yaml", declaration: "version: [" },
  ])("never writes over $case, whatever the config declares", (row) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* sourceOf({
        "tack.yaml": row.declaration,
        "skills/review/SKILL.md": skillText("review"),
      });
      const error = yield* Effect.flip(
        planSourceScaffold(root, configOf({ version: 1, name: "source", skills: [{ path: "." }] })),
      );
      expect(error).toMatchObject({
        _tag: "SourceAddRequestError",
        code: "declaration-exists",
        next: [["tack", "source", "add", root]],
      });
      expect(yield* fs.readFileString(path.join(root, "tack.yaml"))).toBe(row.declaration);
    }),
  );
  test.effect("registers a source with tack.yaml as it is when no config is given", () =>
    Effect.gen(function* () {
      const root = yield* sourceOf({ "tack.yaml": "version: 1\nname: source\n" });
      expect(yield* planSourceScaffold(root, undefined)).toBeUndefined();
    }),
  );
  test.effect.each([
    {
      layout: "skill folders at its top",
      files: {
        "review/SKILL.md": skillText("review"),
        "git/SKILL.md": skillText("git"),
        "README.md": "# Skills",
      },
      suggests: '{"version":1,"name":"source","skills":[{"path":"."}]}.',
    },
    {
      layout: "skill folders at its top beside skills, commands, docs and context folders",
      files: {
        "review/SKILL.md": skillText("review"),
        "commands/ship.md": "Ship it",
        "skills/lint/SKILL.md": skillText("lint"),
        "docs/index.md": "# Docs",
        "context/rules.md": "Rules",
      },
      // The skills entry "." holds skills/; context needs a folder of a source, so it is no source
      // of its own.
      suggests:
        '{"version":1,"name":"source","skills":[{"path":"."}]}, {"version":1,"name":"commands","commands":[{"path":"."}]} for ROOT/commands as a source of its own, and {"version":1,"name":"docs","docs":[{"name":"docs","path":"."}]} for ROOT/docs as a source of its own.',
    },
    {
      layout: "folders named after the kinds they hold",
      files: {
        "skills/review/SKILL.md": skillText("review"),
        "context/rules.md": "Rules",
        "Docs/index.md": "# Docs",
        "command/ship.md": "Ship it",
        ".git/HEAD": "ref",
        "notes/todo.md": "Todo",
      },
      suggests:
        '{"version":1,"name":"source","skills":[{"path":"skills"}],"commands":[{"path":"command"}],"context":[{"path":"context"}]}.',
    },
    {
      layout: "folders that name no kind",
      files: { "personal/skills/review/SKILL.md": skillText("review"), "notes/todo.md": "Todo" },
      suggests: '{"version":1,"name":"source","skills":[{"path":"FOLDER"}]}.',
    },
  ])("refuses a folder without tack.yaml and no config, suggesting one from $layout", (row) =>
    Effect.gen(function* () {
      const root = yield* sourceOf(row.files);
      const error = yield* Effect.flip(planSourceScaffold(root, undefined));
      expect(error).toMatchObject({
        _tag: "SourceAddRequestError",
        code: "declaration-config-required",
        next: [["tack", "guide", "tack-yaml"]],
      });
      expect(error.message).toBe(
        `${root} has no tack.yaml. Write its tack.yaml as JSON and preview it with tack source add ${root} --config 'JSON', or --config - to read it from standard input; tack guide tack-yaml lists every key. Its layout suggests ${row.suggests.replaceAll("ROOT", root)}`,
      );
    }),
  );
  test.effect("suggests a placeholder name for a folder whose name suggests none", () =>
    Effect.gen(function* () {
      const root = yield* sourceOf({ "review/SKILL.md": skillText("review") }, "___");
      const error = yield* Effect.flip(planSourceScaffold(root, undefined));
      expect(error.message).toContain(
        'Its layout suggests {"version":1,"name":"NAME","skills":[{"path":"."}]}.',
      );
    }),
  );
  test.effect("keeps the validation failure of a path that is no source folder", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* sourceOf({ "README.md": "# Source" });
      const missing = yield* Effect.flip(
        planSourceScaffold(path.join(root, "missing"), configOf({ version: 1, name: "source" })),
      );
      expect(missing).toMatchObject({ _tag: "SourceValidationError", code: "source-missing" });
    }),
  );
  test.effect("refuses a source folder it cannot reach", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* sourceOf({ "locked/skills/review/SKILL.md": skillText("review") });
      const locked = path.join(root, "locked");
      yield* fs.chmod(locked, 0o000);
      const unreachable = yield* Effect.flip(
        planSourceScaffold(path.join(locked, "skills"), configOf({ version: 1, name: "skills" })),
      ).pipe(Effect.ensuring(fs.chmod(locked, 0o755).pipe(Effect.orDie)));
      expect(unreachable).toMatchObject({
        _tag: "SourceStorageError",
        code: "source-access-failed",
        operation: "plan source declaration",
        path: path.join(locked, "skills"),
      });
    }),
  );
  test.effect("refuses a file created between planning and exclusive creation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* sourceOf({ "skills/review/SKILL.md": skillText("review") });
      const plan = yield* planSourceScaffold(
        root,
        configOf({ version: 1, name: "source", skills: [{ path: "skills" }] }),
      );
      expect(plan).toBeDefined();
      if (plan === undefined) return;
      yield* fs.writeFileString(plan.declarationPath, "version: 1\n# written by another process\n");
      const result = yield* Effect.exit(writeSourceScaffold(plan));
      expect(result).toMatchObject({ _tag: "Failure" });
      expect(yield* fs.readFileString(plan.declarationPath)).toBe(
        "version: 1\n# written by another process\n",
      );
    }),
  );
  test.effect.each([
    {
      case: "a folder a skills walk reaches",
      declaration: { version: 1, name: "parent", skills: [{ path: "skills" }] },
      target: "skills/team/vendor",
      says: 'is inside the skills entry "skills" of source parent. A tack.yaml here would take this folder out of parent. Add exclude: ["team/vendor/**"] to that entry first, then repeat.',
    },
    {
      case: "a folder that holds a declared path",
      declaration: { version: 1, name: "parent", docs: [{ name: "kb", path: "vendor/kb" }] },
      target: "vendor",
      says: 'holds the docs entry "vendor/kb" of source parent. A tack.yaml here would take that entry out of parent. Remove the entry from parent first, then repeat.',
    },
    {
      case: "a declared folder itself",
      declaration: { version: 1, name: "parent", commands: [{ path: "skills/team" }] },
      target: "skills/team",
      says: 'holds the commands entry "skills/team" of source parent.',
    },
  ] satisfies ReadonlyArray<{
    case: string;
    declaration: SourceDeclaration;
    target: string;
    says: string;
  }>)("refuses a tack.yaml in $case of a registered source", (row) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* sourceOf({
        "skills/team/vendor/lint/SKILL.md": skillText("lint"),
        "vendor/kb/index.md": "# Kb",
      });
      const error = yield* Effect.flip(
        refuseScaffoldInsideSources(path.join(root, row.target), [
          {
            status: "healthy",
            registration: { id: "00000000-0000-4000-8000-000000000001", canonicalPath: root },
            declaration: row.declaration,
            label: "parent",
          },
        ]),
      );
      expect(error).toMatchObject({
        _tag: "SourceAddRequestError",
        code: "declaration-inside-source",
      });
      expect(error.message).toContain(`${path.join(root, row.target)} ${row.says}`);
    }),
  );
  test.effect.each([
    { case: "an exclude prunes it", entry: { path: "skills", exclude: ["team/**"] } },
    { case: "a source between stops the walk", entry: { path: "skills" }, between: true },
    { case: "a skill folder holds it", entry: { path: "skills" }, inSkill: true },
    { case: "only a docs folder holds it", docs: true },
    { case: "the source is unhealthy", unhealthy: true },
    { case: "a skills entry at . passes over other sources", dot: true },
    { case: "a folder between cannot be listed", entry: { path: "skills" }, locked: true },
  ])("writes a tack.yaml where no walk reaches it: $case", (row) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* sourceOf({
        "skills/team/vendor/lint/SKILL.md": skillText("lint"),
        "skills/team/lint/SKILL.md": skillText("lint"),
        ...(row.between === true ? { "skills/team/tack.yaml": "version: 1\nname: team\n" } : {}),
        ...(row.inSkill === true ? { "skills/team/SKILL.md": skillText("team") } : {}),
        "lone/SKILL.md": skillText("lone"),
        "other/fmt/SKILL.md": skillText("fmt"),
        "run.ts": "export {}",
      });
      const registration = { id: "00000000-0000-4000-8000-000000000001", canonicalPath: root };
      const fs = yield* FileSystem.FileSystem;
      const team = path.join(root, "skills/team");
      if (row.locked === true) yield* fs.chmod(team, 0o000);
      yield* refuseScaffoldInsideSources(path.join(root, "skills/team/vendor"), [
        row.unhealthy === true
          ? {
              status: "unhealthy",
              registration,
              issue: { code: "declaration-missing", message: "No tack.yaml." },
            }
          : {
              status: "healthy",
              registration,
              declaration:
                row.dot === true
                  ? { version: 1, name: "parent", skills: [{ path: "." }] }
                  : row.docs === true
                    ? { version: 1, name: "parent", docs: [{ name: "kb", path: "skills" }] }
                    : {
                        version: 1,
                        name: "parent",
                        // A broken entry, one skill and an unrelated folder never reach it.
                        skills: [
                          row.entry,
                          { path: "lone" },
                          { path: "missing" },
                          { path: "other" },
                        ],
                        scripts: [{ name: "run", path: "run.ts", description: "Run" }],
                      },
            },
      ]).pipe(Effect.ensuring(fs.chmod(team, 0o755).pipe(Effect.orDie)));
    }),
  );
});
