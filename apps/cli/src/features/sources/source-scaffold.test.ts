import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { seedSource, skillText } from "../../../test/support/source-tree.ts";
import type { SourceFolders } from "../../domain/sources/source-folders.ts";
import type { SourceDeclaration } from "../../domain/sources/source-schema.ts";
import {
  applyCommand,
  planSourceScaffold,
  refuseScaffoldInsideSources,
  writeSourceScaffold,
} from "./source-scaffold.ts";

/** No folder of any kind: the plain registration of a source that has its tack.yaml. */
const noFolders: SourceFolders = { skills: [], commands: [], context: [], docs: [] };

/** A fresh source folder holding `files`, without tack.yaml unless `files` has one. */
const sourceOf = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "tack-scaffold-" }),
    );
    return yield* seedSource((yield* Path.Path).join(root, "source"), files);
  });

it.layer(LiveTestLayer)("source declaration creation", (test) => {
  test.effect(
    "writes one folder entry per kind flag, in kind order, docs named after their folder",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* sourceOf({
          "personal/skills/review/SKILL.md": skillText("review"),
          "personal/skills/group/commit/SKILL.md": skillText("commit"),
          "alpha/skills/deploy/SKILL.md": skillText("deploy"),
          "alpha/documents/index.md": "# Alpha",
          "prompts/ship.md": "Ship it",
          "notes/guide.md": "Guide",
        });
        const plan = yield* planSourceScaffold(root, {
          ...noFolders,
          docs: ["alpha/documents"],
          context: ["notes/"],
          skills: ["./personal/skills", "alpha/skills"],
          commands: ["prompts"],
        });
        expect(plan?.declarationPath).toBe(path.join(root, "tack.yaml"));
        expect(plan?.content).toBe(
          [
            "version: 1",
            "name: source",
            "skills:",
            "  - path: personal/skills",
            "  - path: alpha/skills",
            "commands:",
            "  - path: prompts",
            "context:",
            "  - path: notes",
            "docs:",
            "  - name: documents",
            "    path: alpha/documents",
            "",
          ].join("\n"),
        );
        expect(plan?.entries).toEqual([
          { kind: "skill", path: "personal/skills", resources: ["commit", "review"], findings: [] },
          { kind: "skill", path: "alpha/skills", resources: ["deploy"], findings: [] },
          { kind: "command", path: "prompts", resources: ["ship"], findings: [] },
          { kind: "context", path: "notes", resources: ["guide.md"], findings: [] },
          {
            kind: "docs",
            path: "alpha/documents",
            name: "documents",
            resources: ["documents"],
            findings: [],
          },
        ]);
      }),
  );
  test.effect.each([
    {
      flag: "skills",
      files: {
        "review/SKILL.md": skillText("review"),
        "git/SKILL.md": skillText("git"),
        "README.md": "# Skills",
      },
      content: "version: 1\nname: notes\nkind: skills\n",
      entry: { kind: "skill", resources: ["git", "review"] },
    },
    {
      flag: "commands",
      files: { "ship.md": "Ship it", "README.md": "# Commands" },
      content: "version: 1\nname: notes\nkind: commands\n",
      entry: { kind: "command", resources: ["ship"] },
    },
    {
      flag: "docs",
      files: { "index.md": "# Notes", ".obsidian/app.md": "state" },
      content: "version: 1\nname: notes\nkind: docs\n",
      entry: { kind: "docs", name: "notes", resources: ["notes"] },
    },
  ])("writes a $flag collection for --$flag .", (row) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const parent = yield* sourceOf({});
      const root = yield* seedSource(path.join(parent, "notes"), row.files);
      for (const value of [".", "./"]) {
        const plan = yield* planSourceScaffold(root, { ...noFolders, [row.flag]: [value] });
        expect(plan?.content).toBe(row.content);
        expect(plan?.entries).toEqual([{ ...row.entry, collection: true, findings: [] }]);
        expect(plan === undefined ? [] : applyCommand(plan)).toEqual([
          "tack",
          "source",
          "add",
          root,
          `--${row.flag}`,
          ".",
          "--apply",
        ]);
      }
    }),
  );
  test.effect.each([
    {
      case: "--context .",
      folders: { context: ["."] },
      code: "declaration-flag-path-invalid",
      says: "--context .: context needs a folder of the source, such as --context notes. Only skills, commands and docs can be a collection.",
    },
    {
      case: "--skills . with another flag",
      folders: { skills: ["."], docs: ["handbook"] },
      code: "declaration-flags-conflict",
      says: "--skills . makes ROOT a skills collection, which declares nothing else. Register the collection alone, and handbook as a source of its own.",
      next: [
        ["tack", "source", "add", "ROOT", "--skills", "."],
        ["tack", "source", "add", "ROOT/handbook", "--docs", "."],
      ],
    },
    {
      case: "--skills . with commands, docs and context flags",
      folders: { skills: ["."], commands: ["./prompts/"], docs: ["handbook"], context: ["notes"] },
      code: "declaration-flags-conflict",
      says: "--skills . makes ROOT a skills collection, which declares nothing else. Register the collection alone, and prompts and handbook as sources of their own. Context needs a folder of a source, so notes cannot be a source of its own.",
      next: [
        ["tack", "source", "add", "ROOT", "--skills", "."],
        ["tack", "source", "add", "ROOT/prompts", "--commands", "."],
        ["tack", "source", "add", "ROOT/handbook", "--docs", "."],
      ],
    },
    {
      case: "--commands . with a context flag",
      folders: { commands: ["."], context: ["notes"] },
      code: "declaration-flags-conflict",
      says: "--commands . makes ROOT a commands collection, which declares nothing else. Register the collection alone. Context needs a folder of a source, so notes cannot be a source of its own.",
      next: [["tack", "source", "add", "ROOT", "--commands", "."]],
    },
    {
      case: "two collections",
      folders: { skills: ["."], commands: ["."] },
      code: "declaration-flags-conflict",
      says: "--skills . and --commands . would both make ROOT a collection, and a folder holds one. Keep one of them.",
    },
    {
      case: "a flag folder inside another",
      folders: { context: ["lib"], commands: ["lib/vendor/"] },
      code: "declaration-flags-conflict",
      says: '--commands lib/vendor/ and --context lib overlap, and each file may belong to one declaration. Keep one of them, or write tack.yaml by hand with exclude: ["vendor/**"] on the context entry "lib".',
    },
    {
      case: "one folder named by two flags",
      folders: { skills: ["handbook"], commands: ["./handbook"] },
      code: "declaration-flags-conflict",
      says: "--skills handbook and --commands ./handbook overlap, and each file may belong to one declaration. Keep one of them.",
    },
    {
      case: "--skills . on one skill",
      folders: { skills: ["."] },
      oneSkill: true,
      code: "source-is-one-skill",
      says: "ROOT holds SKILL.md, so it is one skill, not a folder of skills. Register the folder that holds it, or import it into a source with tack import add.",
    },
  ])("refuses $case", (row) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* sourceOf({
        "handbook/index.md": "# Handbook",
        "review/SKILL.md": skillText("review"),
        "lib/vendor/ship.md": "Ship",
        ...(row.oneSkill === true ? { "SKILL.md": skillText("one") } : {}),
      });
      const error = yield* Effect.flip(planSourceScaffold(root, { ...noFolders, ...row.folders }));
      expect(error).toMatchObject({
        _tag: "SourceAddRequestError",
        code: row.code,
        message: row.says.replaceAll("ROOT", root),
        ...(row.next === undefined
          ? {}
          : { next: row.next.map((command) => command.map((part) => part.replace("ROOT", root))) }),
      });
      expect(yield* fs.exists(path.join(root, "tack.yaml"))).toBe(false);
    }),
  );
  test.effect("lets a docs folder hold or equal another kind's folder", () =>
    Effect.gen(function* () {
      const root = yield* sourceOf({
        "handbook/index.md": "# Handbook",
        "handbook/notes/team.md": "Team",
      });
      const plan = yield* planSourceScaffold(root, {
        ...noFolders,
        context: ["handbook/notes"],
        docs: ["handbook"],
      });
      expect(plan?.entries.map((entry) => entry.findings)).toEqual([[], []]);
    }),
  );
  test.effect("refuses --docs . on a folder whose name is no docs name", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const parent = yield* sourceOf({});
      const root = yield* seedSource(path.join(parent, "My Notes"), { "index.md": "# Notes" });
      const error = yield* Effect.flip(planSourceScaffold(root, { ...noFolders, docs: ["."] }));
      expect(error).toMatchObject({
        _tag: "SourceAddRequestError",
        code: "declaration-docs-name-invalid",
      });
    }),
  );
  test.effect.each([
    { folder: "My Skills", flag: "skills", value: "skills", name: "my-skills" },
    { folder: "Team_Prompts", flag: "commands", value: ".", name: "team-prompts" },
  ])("names the source $name after the folder $folder", (row) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const parent = yield* sourceOf({});
      const root = yield* seedSource(path.join(parent, row.folder), {
        "skills/review/SKILL.md": skillText("review"),
        "ship.md": "Ship it",
      });
      const plan = yield* planSourceScaffold(root, { ...noFolders, [row.flag]: [row.value] });
      expect(plan?.content).toContain(`version: 1\nname: ${row.name}\n`);
    }),
  );
  test.effect.each([
    { flag: "skills", value: "skills" },
    { flag: "commands", value: "." },
  ])("refuses --$flag $value on a folder that suggests no source name", (row) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const parent = yield* sourceOf({});
      const root = yield* seedSource(path.join(parent, "___"), {
        "skills/review/SKILL.md": skillText("review"),
        "ship.md": "Ship it",
      });
      const error = yield* Effect.flip(
        planSourceScaffold(root, { ...noFolders, [row.flag]: [row.value] }),
      );
      expect(error).toMatchObject({
        _tag: "SourceAddRequestError",
        code: "declaration-name-invalid",
        message: expect.stringContaining('The folder name "___" suggests no source name'),
      });
    }),
  );
  test.effect("reports the problems of each entry as tack check reports them", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* sourceOf({
        "skills/review/SKILL.md": skillText("other"),
        "skills/fine/SKILL.md": skillText("fine"),
        "guide.md": "Not a folder of skills",
      });
      const plan = yield* planSourceScaffold(root, {
        ...noFolders,
        skills: ["skills", "guide.md"],
      });
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
            expect.objectContaining({
              code: "declaration-path-wrong-type",
              field: "skills[1]",
              file: path.join(root, "tack.yaml"),
            }),
          ],
        },
      ]);
    }),
  );
  test.effect.each([
    { case: "an absolute path", value: "/etc", reason: "relative to the source" },
    { case: "a path that climbs out", value: "../other", reason: "relative to the source" },
    { case: "a missing path", value: "nowhere", reason: "does not exist" },
    { case: "a link out of the source", value: "escape", reason: "outside" },
    { case: "a folder of another source", value: "vendor/skills", reason: "another source" },
  ])("refuses a kind flag that names $case", (row) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* sourceOf({
        "vendor/tack.yaml": "version: 1\nname: vendor\n",
        "vendor/skills/lint/SKILL.md": skillText("lint"),
      });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "tack-outside-" });
      yield* fs.symlink(outside, path.join(root, "escape"));
      const error = yield* Effect.flip(
        planSourceScaffold(root, { ...noFolders, skills: [row.value] }),
      );
      expect(error).toMatchObject({
        _tag: "SourceAddRequestError",
        code: "declaration-flag-path-invalid",
        message: expect.stringContaining(`--skills ${row.value}`),
      });
      expect(error.message).toContain(row.reason);
      expect(yield* fs.exists(path.join(root, "tack.yaml"))).toBe(false);
    }),
  );
  test.effect(
    "refuses a kind flag that names a folder it cannot read, and a source it cannot reach",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* sourceOf({ "locked/skills/review/SKILL.md": skillText("review") });
        const locked = path.join(root, "locked");
        yield* fs.chmod(locked, 0o000);
        const [unreadable, unreachable] = yield* Effect.all([
          Effect.flip(planSourceScaffold(root, { ...noFolders, skills: ["locked"] })),
          Effect.flip(
            planSourceScaffold(path.join(locked, "skills"), { ...noFolders, skills: ["x"] }),
          ),
        ]).pipe(Effect.ensuring(fs.chmod(locked, 0o755).pipe(Effect.orDie)));
        expect(unreadable).toMatchObject({
          _tag: "SourceAddRequestError",
          code: "declaration-flag-path-invalid",
          message: expect.stringContaining("--skills locked: "),
        });
        expect(unreachable).toMatchObject({
          _tag: "SourceStorageError",
          code: "source-access-failed",
          operation: "plan source declaration",
          path: path.join(locked, "skills"),
        });
      }),
  );
  test.effect.each([
    {
      case: "two docs folders share a name",
      docs: ["a/docs", "b/docs"],
      code: "declaration-docs-name-clash",
      says: 'Both a/docs and b/docs would be docs "docs"',
    },
    {
      case: "a docs folder name is no docs name",
      docs: ["My Docs"],
      code: "declaration-docs-name-invalid",
      says: 'The folder name "My Docs" is no docs name',
    },
  ])("refuses docs flags when $case", (row) =>
    Effect.gen(function* () {
      const root = yield* sourceOf({
        "a/docs/index.md": "A",
        "b/docs/index.md": "B",
        "My Docs/index.md": "Mine",
      });
      const error = yield* Effect.flip(planSourceScaffold(root, { ...noFolders, docs: row.docs }));
      expect(error).toMatchObject({ _tag: "SourceAddRequestError", code: row.code });
      expect(error.message).toContain(row.says);
    }),
  );
  test.effect.each([
    {
      case: "a valid tack.yaml",
      declaration: "version: 1\nname: source\nskills:\n  - path: skills\n",
    },
    { case: "a broken tack.yaml", declaration: "version: [" },
  ])("never writes over $case, whatever kind flag names", (row) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* sourceOf({
        "tack.yaml": row.declaration,
        "skills/review/SKILL.md": skillText("review"),
      });
      const error = yield* Effect.flip(
        planSourceScaffold(root, { ...noFolders, skills: ["skills"] }),
      );
      expect(error).toMatchObject({
        _tag: "SourceAddRequestError",
        code: "declaration-exists",
        next: [["tack", "source", "add", root]],
      });
      expect(yield* fs.readFileString(path.join(root, "tack.yaml"))).toBe(row.declaration);
    }),
  );
  test.effect("registers a source with tack.yaml as it is when no kind flag is given", () =>
    Effect.gen(function* () {
      const root = yield* sourceOf({ "tack.yaml": "version: 1\nname: source\n" });
      expect(yield* planSourceScaffold(root, noFolders)).toBeUndefined();
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
      next: [["ROOT", "--skills", "."]],
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
      // The collection holds skills/; context needs a folder of a source, so it is no source of its own.
      next: [
        ["ROOT", "--skills", "."],
        ["ROOT/commands", "--commands", "."],
        ["ROOT/docs", "--docs", "."],
      ],
    },
    {
      layout: "folders named after the kinds they hold",
      files: {
        "skills/review/SKILL.md": skillText("review"),
        "context/rules.md": "Rules",
        "docs/index.md": "# Docs",
        "command/ship.md": "Ship it",
        ".git/HEAD": "ref",
        "notes/todo.md": "Todo",
      },
      next: [
        [
          "ROOT",
          "--skills",
          "skills",
          "--commands",
          "command",
          "--context",
          "context",
          "--docs",
          "docs",
        ],
      ],
    },
    {
      layout: "folders that name no kind",
      files: { "personal/skills/review/SKILL.md": skillText("review"), "notes/todo.md": "Todo" },
      next: [["ROOT", "--skills", "FOLDER"]],
    },
  ])("refuses a folder without tack.yaml and no kind flag, proposing $layout", (row) =>
    Effect.gen(function* () {
      const root = yield* sourceOf(row.files);
      const error = yield* Effect.flip(planSourceScaffold(root, noFolders));
      expect(error).toMatchObject({
        _tag: "SourceAddRequestError",
        code: "declaration-flags-required",
        next: row.next.map(([source = "", ...flags]) => [
          "tack",
          "source",
          "add",
          source.replace("ROOT", root),
          ...flags,
        ]),
      });
      for (const flag of ["--skills", "--commands", "--context", "--docs"])
        expect(error.message).toContain(flag);
    }),
  );
  test.effect("keeps the validation failure of a path that is no source folder", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* sourceOf({});
      const missing = yield* Effect.flip(
        planSourceScaffold(path.join(root, "missing"), { ...noFolders, skills: ["skills"] }),
      );
      expect(missing).toMatchObject({ _tag: "SourceValidationError", code: "source-missing" });
    }),
  );
  test.effect("refuses a file created between planning and exclusive creation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* sourceOf({ "skills/review/SKILL.md": skillText("review") });
      const plan = yield* planSourceScaffold(root, { ...noFolders, skills: ["skills"] });
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
    { case: "the source is a skills collection", collection: true },
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
                row.collection === true
                  ? { version: 1, name: "parent", kind: "skills" }
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
