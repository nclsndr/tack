import { writeUnder } from "./support/source-tree.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { type GitService } from "../src/services/git.ts";
import { exitCodeForEnvelope } from "../src/cli/host/public-outcome.ts";
import { SourceRegistrationPayloadSchema } from "../src/features/sources/source.ts";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

const git = (root: string) =>
  ({
    listWorktrees: () => Effect.succeed([{ bare: false, detached: false, path: root }]),
    resolveCommonDirectory: () => Effect.succeed(root),
  }) satisfies GitService;

/**
 * Runs one command in process and returns its raw stdout. The scratch root is the home, so a
 * user-scope command writes its links there and never into the operator's real agent folders.
 */
const run = (root: string, state: string, arguments_: ReadonlyArray<string>) =>
  runHost({
    args: ["--state-dir", state, ...arguments_],
    git: git(root),
    env: { HOME: root },
  }).pipe(Effect.map((result) => result.stdout));

const json = (root: string, state: string, arguments_: ReadonlyArray<string>) =>
  run(root, state, ["--json", ...arguments_]).pipe(Effect.map(decodeEnvelope));

const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-decl-out-" }));
  const write = writeUnder(root);
  return { root, state: path.join(root, "state"), path, write };
});

it.layer(LiveTestLayer)("local source authoring", (test) => {
  test.effect("checks an unregistered source without initialized state and does not write", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      const fs = yield* FileSystem.FileSystem;
      yield* write("source/tack.yaml", "version: 1\nskills:\n  - path: skills\n");
      yield* write(
        "source/skills/review/SKILL.md",
        "---\nname: review\ndescription: Review changes\n---\n",
      );
      const result = yield* json(root, state, ["check", path.join(root, "source")]);
      expect(exitCodeForEnvelope(result)).toBe(0);
      expect(result.result).toMatchObject({
        kind: "check-report",
        checks: [
          expect.objectContaining({
            kind: "source",
            details: expect.arrayContaining([
              "skill: 1",
              "command: 0",
              "context: 0",
              "script: 0",
              "docs: 0",
            ]),
          }),
        ],
        findings: [],
      });
      expect(yield* fs.exists(state)).toBe(false);
      expect(yield* run(root, state, ["check", path.join(root, "source")])).toContain("skill: 1");
    }),
  );
  test.effect("reports every broken declaration and resource with locations", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write(
        "source/tack.yaml",
        "version: 1\nskills:\n  - path: skills\ncommands:\n  - path: missing\ncontext:\n  - path: absent\n",
      );
      yield* write("source/skills/review/SKILL.md", "---\nname: review\n---\n");
      const result = yield* json(root, state, ["check", path.join(root, "source")]);
      expect(exitCodeForEnvelope(result)).toBe(1);
      expect(result.result).toMatchObject({
        findings: expect.arrayContaining([
          expect.objectContaining({
            code: "skill-frontmatter-schema-invalid",
            line: 1,
            file: path.join(root, "source/skills/review/SKILL.md"),
          }),
          expect.objectContaining({
            code: "declaration-path-missing",
            line: 5,
            file: path.join(root, "source/tack.yaml"),
          }),
          expect.objectContaining({ code: "declaration-path-missing", line: 7 }),
        ]),
      });
    }),
  );
  test.effect("stops resource inspection when the declaration schema is invalid", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write("source/tack.yaml", "version: 1\nname: Bad Label\nskills:\n  - path: missing\n");
      const result = yield* json(root, state, ["check", path.join(root, "source")]);
      expect(exitCodeForEnvelope(result)).toBe(1);
      expect(result.result).toMatchObject({
        checks: [
          expect.objectContaining({
            details: expect.arrayContaining([
              "skill: 0",
              "command: 0",
              "context: 0",
              "script: 0",
              "docs: 0",
            ]),
          }),
        ],
        findings: [
          expect.objectContaining({
            code: "declaration-schema-invalid",
            file: path.join(root, "source/tack.yaml"),
          }),
        ],
      });
    }),
  );
  test.effect("quarantines duplicates and boundary violations using catalog discovery", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      const fs = yield* FileSystem.FileSystem;
      yield* write(
        "source/tack.yaml",
        "version: 1\ncommands:\n  - path: commands\ncontext:\n  - path: context\n",
      );
      yield* write("source/commands/a/review.md", "Review");
      yield* write("source/commands/b/review.md", "Review");
      yield* write("outside.md", "Outside");
      yield* fs.makeDirectory(path.join(root, "source/context"));
      yield* fs.symlink(path.join(root, "outside.md"), path.join(root, "source/context/escape.md"));
      const result = yield* json(root, state, ["check", path.join(root, "source")]);
      expect(exitCodeForEnvelope(result)).toBe(1);
      expect(result.result).toMatchObject({
        checks: [
          expect.objectContaining({
            details: expect.arrayContaining(["command: 0", "context: 0"]),
          }),
        ],
        findings: expect.arrayContaining([
          expect.objectContaining({ code: "resource-address-duplicate" }),
          expect.objectContaining({ code: "resource-boundary-violation" }),
        ]),
      });
    }),
  );
  test.effect(
    "locates non-list declarations at the field rather than an invented array index",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write } = yield* scratch;
        yield* write("source/tack.yaml", "version: 1\nskills: wrong\ndocs: wrong\n");
        const result = yield* json(root, state, ["check", path.join(root, "source")]);
        expect(result.result).toMatchObject({
          findings: expect.arrayContaining([
            expect.objectContaining({ line: 2 }),
            expect.objectContaining({ line: 3 }),
          ]),
        });
      }),
  );
  test.effect("empty declarations warn with success, malformed and missing declarations fail", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write("empty/tack.yaml", "version: 1\n");
      const empty = yield* json(root, state, ["check", path.join(root, "empty")]);
      expect(exitCodeForEnvelope(empty)).toBe(0);
      expect(empty.result).toMatchObject({
        findings: [{ severity: "warning", code: "source-declares-no-resources" }],
      });
      for (const text of ["version: [", "version: 3\n", "version: 1\nunknown: true\n"]) {
        yield* write("broken/tack.yaml", text);
        expect(
          exitCodeForEnvelope(yield* json(root, state, ["check", path.join(root, "broken")])),
        ).toBe(1);
      }
      expect(
        exitCodeForEnvelope(yield* json(root, state, ["check", path.join(root, "absent")])),
      ).toBe(1);
    }),
  );
  test.effect("reports entry errors and stops at declaration failures", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write(
        "entry/tack.yaml",
        "version: 1\nscripts:\n  - name: Bad Name\n    path: 42\n    description: ''\n",
      );
      const entry = yield* json(root, state, ["check", path.join(root, "entry")]);
      expect(exitCodeForEnvelope(entry)).toBe(1);
      expect(entry.result).toMatchObject({
        findings: [expect.objectContaining({ code: "declaration-entry-invalid", line: 3 })],
      });
      yield* write("layout/skills/.keep", "");
      yield* write(
        "layout/tack.yaml",
        "version: 1\ndocs:\n  - name: handbook\n    path: missing-docs\n",
      );
      const layout = yield* json(root, state, ["check", path.join(root, "layout")]);
      expect(exitCodeForEnvelope(layout)).toBe(1);
      expect(layout.result).toMatchObject({
        findings: [expect.objectContaining({ code: "declaration-resources-undeclared" })],
      });
    }),
  );
  test.effect("source add accepts resource problems, reports counts and points to check", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write("source/tack.yaml", "version: 1\nskills:\n  - path: missing\n");
      yield* run(root, state, ["state", "init"]);
      const result = yield* json(root, state, ["source", "add", path.join(root, "source")]);
      expect(exitCodeForEnvelope(result)).toBe(0);
      expect(result.applied).toMatchObject({
        inspection: {
          counts: { skill: 0 },
          findings: [expect.objectContaining({ code: "declaration-path-missing" })],
        },
      });
      expect(result.next.join(" ")).toContain("tack check");
      const text = yield* run(root, state, ["source", "add", path.join(root, "source")]);
      expect(text).toContain("declaration-path-missing");
      expect(text).toContain("0 skills");
    }),
  );
  test.effect(
    "source add previews the tack.yaml its kind flags declare without state, writes only with apply, never overwrites",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write } = yield* scratch;
        const fs = yield* FileSystem.FileSystem;
        yield* write(
          "source/personal/skills/review/SKILL.md",
          "---\nname: review\ndescription: Review changes\n---\n",
        );
        yield* write("source/prompts/review.md", "---\ndescription: Review\n---\n");
        yield* write("source/notes/guide.md", "Guide");
        yield* write("source/alpha/documents/index.md", "# Guide");
        const directory = path.join(root, "source");
        const declaration = path.join(directory, "tack.yaml");
        const flags = [
          "--skills",
          "personal/skills",
          "--commands",
          "prompts",
          "--context",
          "notes",
          "--docs",
          "alpha/documents",
        ];
        const bare = yield* json(root, state, ["source", "add", directory]);
        expect(exitCodeForEnvelope(bare)).toBe(2);
        expect(bare.diagnostics).toMatchObject([{ code: "declaration-flags-required" }]);
        expect(bare.next).toEqual([`tack source add ${directory} --skills FOLDER`]);
        const outside = yield* json(root, state, ["source", "add", directory, "--docs", "../x"]);
        expect(exitCodeForEnvelope(outside)).toBe(2);
        expect(outside.diagnostics).toMatchObject([{ code: "declaration-flag-path-invalid" }]);
        expect(outside.next).toEqual([]);
        const preview = yield* json(root, state, ["source", "add", directory, ...flags]);
        expect(exitCodeForEnvelope(preview)).toBe(0);
        expect(preview.applied).toBe(null);
        expect(preview.plan).toMatchObject({
          kind: "source-scaffold",
          name: "source",
          declarationPath: declaration,
          content: expect.stringContaining("  - name: documents\n    path: alpha/documents\n"),
          entries: [
            { kind: "skill", path: "personal/skills", resources: ["review"] },
            { kind: "command", path: "prompts", resources: ["review"] },
            { kind: "context", path: "notes", resources: ["guide.md"] },
            { kind: "docs", path: "alpha/documents", resources: ["documents"] },
          ],
        });
        expect(preview.next).toEqual([`tack source add ${directory} ${flags.join(" ")} --apply`]);
        expect(yield* fs.exists(declaration)).toBe(false);
        expect(yield* fs.exists(state)).toBe(false);
        expect(yield* run(root, state, ["source", "add", directory, ...flags])).toContain(
          "skills personal/skills · 1 skill",
        );
        const failed = yield* json(root, state, ["source", "add", directory, ...flags, "--apply"]);
        expect(exitCodeForEnvelope(failed)).toBe(2);
        expect(yield* fs.exists(declaration)).toBe(false);
        yield* run(root, state, ["state", "init"]);
        const stateFile = path.join(state, "state.json");
        const initial = yield* fs.readFileString(stateFile);
        yield* write("present/tack.yaml", "version: 1\n");
        const registered = yield* json(root, state, ["source", "add", path.join(root, "present")]);
        expect(registered.applied).not.toBe(null);
        const afterRegistration = yield* fs.readFileString(stateFile);
        expect(afterRegistration).not.toBe(initial);
        yield* json(root, state, ["source", "add", directory, ...flags]);
        expect(yield* fs.readFileString(stateFile)).toBe(afterRegistration);
        const applied = yield* json(root, state, ["source", "add", directory, ...flags, "--apply"]);
        expect(exitCodeForEnvelope(applied)).toBe(0);
        expect(applied.applied).toMatchObject({
          scaffolded: declaration,
          name: "source",
          inspection: { counts: { skill: 1, command: 1, context: 1, script: 0, docs: 1 } },
        });
        const content = yield* fs.readFileString(declaration);
        yield* fs.writeFileString(declaration, content + "# keep my edits\n");
        const again = yield* json(root, state, ["source", "add", directory, ...flags, "--apply"]);
        expect(again.diagnostics).toMatchObject([{ code: "declaration-exists" }]);
        expect(yield* fs.readFileString(declaration)).toBe(content + "# keep my edits\n");
      }),
  );
  test.effect(
    "source add names a source whose folder name another source already labels by its registration ID",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write } = yield* scratch;
        yield* write("one/team/tack.yaml", "version: 1\nkind: skills\n");
        yield* write("two/team/review/SKILL.md", "---\nname: review\ndescription: R\n---\n");
        yield* run(root, state, ["state", "init"]);
        yield* json(root, state, ["source", "add", path.join(root, "one", "team")]);
        const flags = ["source", "add", path.join(root, "two", "team"), "--skills", "."];
        const preview = yield* json(root, state, flags);
        expect(preview.plan).toMatchObject({ kind: "source-scaffold" });
        expect(preview.plan).not.toHaveProperty("name");
        expect(preview.plan).not.toHaveProperty("declaration");
        const applied = yield* json(root, state, [...flags, "--apply"]);
        expect(applied.applied).toMatchObject({ registration: { id: expect.any(String) } });
        const registration = Schema.decodeUnknownSync(SourceRegistrationPayloadSchema)(
          applied.applied,
        );
        expect(registration.name).toBe(registration.registration.id);
      }),
  );
  test.effect(
    "source add and check warn about each folder of a skills collection that is not a skill",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write } = yield* scratch;
        const flat = path.join(root, "flat");
        for (const name of ["alpha", "beta", "team/review"])
          yield* write(
            `flat/${name}/SKILL.md`,
            `---\nname: ${path.basename(name)}\ndescription: S\n---\n`,
          );
        yield* write("flat/commands/hi.md", "# Hi");
        const warnings = ["commands", "team"].map((folder) => ({
          code: "collection-folder-not-skill",
          severity: "warning",
          field: "kind",
          message: expect.stringContaining(`${folder}/ holds no SKILL.md`),
          candidatePath: path.join(flat, folder),
        }));
        const preview = yield* json(root, state, ["source", "add", flat, "--skills", "."]);
        expect(exitCodeForEnvelope(preview)).toBe(0);
        expect(preview.plan).toMatchObject({
          entries: [{ resources: ["alpha", "beta"], findings: warnings }],
        });
        const human = (yield* run(root, state, ["source", "add", flat, "--skills", "."]))
          .split(/\s+/)
          .join(" ");
        expect(human).toContain(
          "warning: collection-folder-not-skill: commands/ holds no SKILL.md",
        );
        expect(human).toContain("warning: collection-folder-not-skill: team/ holds no SKILL.md");
        yield* run(root, state, ["state", "init"]);
        const applied = yield* json(root, state, [
          "source",
          "add",
          flat,
          "--skills",
          ".",
          "--apply",
        ]);
        expect(exitCodeForEnvelope(applied)).toBe(0);
        expect(applied.applied).toMatchObject({
          inspection: { counts: { skill: 2, command: 0 }, findings: warnings },
        });
        const checked = yield* json(root, state, ["check", flat]);
        expect(exitCodeForEnvelope(checked)).toBe(0);
        expect(checked.result).toMatchObject({
          summary: { errors: 0, warnings: 2 },
          findings: warnings,
        });
      }),
  );
  test.effect(
    "source add registers a skills collection that holds no skill, with the warning",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write } = yield* scratch;
        const flat = path.join(root, "flat");
        yield* write("flat/commands/hi.md", "# Hi");
        yield* run(root, state, ["state", "init"]);
        const applied = yield* json(root, state, [
          "source",
          "add",
          flat,
          "--skills",
          ".",
          "--apply",
        ]);
        expect(exitCodeForEnvelope(applied)).toBe(0);
        expect(applied.applied).toMatchObject({
          inspection: { findings: [{ code: "collection-folder-not-skill" }] },
        });
      }),
  );
  test.effect(
    "source add refuses a tack.yaml that a registered source's walk reaches until it excludes it",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write } = yield* scratch;
        yield* write("parent/tack.yaml", "version: 1\nname: parent\nskills:\n  - path: skills\n");
        yield* write("parent/skills/review/SKILL.md", "---\nname: review\ndescription: R\n---\n");
        yield* write(
          "parent/skills/vendor/skills/lint/SKILL.md",
          "---\nname: lint\ndescription: L\n---\n",
        );
        yield* run(root, state, ["state", "init"]);
        yield* json(root, state, ["source", "add", path.join(root, "parent")]);
        const vendor = path.join(root, "parent", "skills", "vendor");
        const refused = yield* json(root, state, ["source", "add", vendor, "--skills", "skills"]);
        expect(exitCodeForEnvelope(refused)).toBe(2);
        expect(refused.diagnostics).toMatchObject([
          {
            code: "declaration-inside-source",
            message: expect.stringContaining('Add exclude: ["vendor/**"] to that entry first'),
          },
        ]);
        yield* write(
          "parent/tack.yaml",
          'version: 1\nname: parent\nskills:\n  - path: skills\n    exclude: ["vendor/**"]\n',
        );
        const preview = yield* json(root, state, ["source", "add", vendor, "--skills", "skills"]);
        expect(exitCodeForEnvelope(preview)).toBe(0);
        expect(preview.plan).toMatchObject({ entries: [{ kind: "skill", resources: ["lint"] }] });
      }),
  );
  test.effect(
    "source add previews a declared resource that cannot be read as partial, under Problems",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write } = yield* scratch;
        yield* write(
          "source/skills/review/SKILL.md",
          "---\nname: review\ndescription: Review a change.\n---\nReview.\n",
        );
        // An unquoted colon in a description is a common hand-written frontmatter mistake.
        yield* write("source/commands/ship.md", "---\ndescription: Ship it: now\n---\nShip.\n");
        const directory = path.join(root, "source");
        const flags = ["--skills", "skills", "--commands", "commands"];
        yield* run(root, state, ["state", "init"]);

        const preview = yield* json(root, state, ["source", "add", directory, ...flags]);
        expect(exitCodeForEnvelope(preview)).toBe(1);
        expect(preview).toMatchObject({
          classification: "partial",
          diagnostics: [
            {
              code: "command-frontmatter-invalid",
              severity: "error",
              details: { file: path.join(directory, "commands", "ship.md") },
            },
          ],
          next: [`tack source add ${directory} ${flags.join(" ")} --apply`],
        });
        const text = yield* run(root, state, ["source", "add", directory, ...flags]);
        // Listed once, under Problems, not again beside its entry.
        expect(text).toContain("Problems");
        expect(text.split("command-frontmatter-invalid").length).toBe(2);
      }),
  );
  test.effect(
    "source add previews a declaration that would load nothing as partial and refuses to apply it",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write } = yield* scratch;
        const fs = yield* FileSystem.FileSystem;
        // Each flag names a file its kind cannot read, so every entry has a problem.
        yield* write("source/guide.md", "# Guide\n");
        yield* write("source/notes.txt", "Notes\n");
        const directory = path.join(root, "source");
        const declaration = path.join(directory, "tack.yaml");
        const flags = ["--skills", "guide.md", "--commands", "notes.txt"];
        yield* run(root, state, ["state", "init"]);
        const stateFile = path.join(state, "state.json");
        const initial = yield* fs.readFileString(stateFile);

        const preview = yield* json(root, state, ["source", "add", directory, ...flags]);
        expect(exitCodeForEnvelope(preview)).toBe(1);
        expect(preview.diagnostics).toMatchObject([
          { code: "declaration-path-wrong-type", severity: "error" },
          { code: "declaration-path-wrong-type", severity: "error" },
          { code: "declaration-loads-nothing", severity: "warning" },
        ]);
        expect(preview.next).toEqual([]);
        expect(preview.plan).toMatchObject({
          entries: [
            { kind: "skill", resources: [], findings: [{ code: "declaration-path-wrong-type" }] },
            { kind: "command", resources: [], findings: [{ code: "declaration-path-wrong-type" }] },
          ],
        });
        const text = yield* run(root, state, ["source", "add", directory, ...flags]);
        expect(text).toContain("declaration-loads-nothing");
        expect(text).not.toContain("--apply");

        const applied = yield* json(root, state, ["source", "add", directory, ...flags, "--apply"]);
        expect(exitCodeForEnvelope(applied)).toBe(2);
        expect(applied.diagnostics).toMatchObject([{ code: "declaration-loads-nothing" }]);
        expect(applied.next).toEqual([`tack source add ${directory} ${flags.join(" ")}`]);
        expect(yield* fs.exists(declaration)).toBe(false);
        expect(yield* fs.readFileString(stateFile)).toBe(initial);
      }),
  );
});

it.layer(LiveTestLayer)("source declaration output", (test) => {
  test.effect("reports a source that declares nothing as a warning that changes no exit code", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write("bare/tack.yaml", "version: 1\nname: bare\n");
      yield* run(root, state, ["state", "init"]);
      yield* run(root, state, ["source", "add", path.join(root, "bare")]);

      const source = yield* json(root, state, ["source"]);
      expect(source.classification).toBe("success");
      expect(exitCodeForEnvelope(source)).toBe(0);
      expect(source.result).toMatchObject({
        sources: [{ status: "healthy", warnings: [{ code: "source-declares-no-resources" }] }],
      });
      const status = yield* json(root, state, ["status", "--user"]);
      expect(exitCodeForEnvelope(status)).toBe(0);
      expect(status.result).toMatchObject({
        sources: [{ status: "healthy", warnings: [{ code: "source-declares-no-resources" }] }],
      });
      expect(yield* run(root, state, ["source"])).toContain(
        "source-declares-no-resources: This source declares no resources",
      );
      expect(yield* run(root, state, ["status", "--user"])).toContain(
        "1 source, all healthy; 1 declare no resources",
      );
    }),
  );

  test.effect("reports a registered source whose every declaration loads nothing as broken", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write("broken/tack.yaml", "version: 1\nskills:\n  - path: missing\n");
      yield* run(root, state, ["state", "init"]);
      yield* run(root, state, ["source", "add", path.join(root, "broken")]);

      const source = yield* json(root, state, ["source"]);
      expect(exitCodeForEnvelope(source)).toBe(1);
      expect(source.diagnostics).toMatchObject([
        { code: "source-loads-nothing", severity: "warning" },
      ]);
      const text = yield* run(root, state, ["source"]);
      expect(text).toContain("✗ broken");
      expect(text).toContain("tack check");
    }),
  );

  test.effect("names a source with undeclared folders in source, doctor and the sync preview", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write("old/tack.yaml", "version: 1\nname: old\nskills:\n  - path: skills\n");
      yield* write("old/skills/adhd/SKILL.md", "---\nname: adhd\ndescription: Adhd\n---\n");
      yield* run(root, state, ["state", "init"]);
      yield* run(root, state, ["source", "add", path.join(root, "old")]);
      yield* run(root, state, ["adapter", "enable", "claude"]);
      yield* run(root, state, ["pick", "include", "adhd", "--user"]);
      yield* run(root, state, ["sync", "--user", "--apply"]);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.realPath(path.join(root, ".claude/skills/adhd"))).toBe(
        path.join(root, "old/skills/adhd"),
      );
      yield* write("old/tack.yaml", "version: 1\nname: old\n");

      const source = yield* json(root, state, ["source"]);
      expect(source.classification).toBe("partial");
      expect(source.result).toMatchObject({
        sources: [{ status: "unhealthy", issue: { code: "declaration-resources-undeclared" } }],
      });
      const message = JSON.stringify(source.result);
      expect(message).toContain("Found `skills/`. Add `skills: [{ path: skills }]`.");
      const sync = yield* json(root, state, ["sync", "--user"]);
      expect(sync.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "source-unhealthy",
            details: {
              subject: expect.objectContaining({
                issue: expect.objectContaining({ code: "declaration-resources-undeclared" }),
              }),
            },
          }),
        ]),
      );
      expect(JSON.stringify(sync.plan)).toContain("remove");

      const human = yield* run(root, state, ["source"]);
      expect(human).toContain("✗ unhealthy");
      expect(human).toContain("declaration-resources-undeclared: Tack reads resources only");
      // Nothing was applied: the link delivered before the edit is still there.
      const status = yield* json(root, state, ["status", "--user"]);
      expect(JSON.stringify(status.result)).toContain("adhd");
    }),
  );

  test.effect("shows a collection in source, catalog --details and check without a path", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write("flat/tack.yaml", "version: 1\nkind: skills\n");
      yield* write("flat/review/SKILL.md", "---\nname: review\ndescription: R\n---\n");
      yield* write("flat/git/SKILL.md", "---\nname: git\ndescription: G\n---\n");
      const directory = path.join(root, "flat");
      const check = yield* run(root, state, ["check", directory]);
      expect(check).toContain("skill: 2");
      yield* run(root, state, ["state", "init"]);
      yield* run(root, state, ["source", "add", directory]);
      expect(yield* run(root, state, ["source"])).toMatch(/skills +\(collection\) +2 resources/);
      expect(yield* run(root, state, ["catalog", "--details"])).toContain("skills collection");
      expect(yield* run(root, state, ["catalog"])).not.toContain("collection");
      const details = Schema.decodeUnknownSync(
        Schema.Struct({
          resources: Schema.Array(
            Schema.Struct({
              origin: Schema.String,
              collection: Schema.optionalKey(Schema.Boolean),
            }),
          ),
        }),
      )((yield* json(root, state, ["catalog", "--details"])).result);
      expect(
        details.resources
          .filter(({ origin }) => origin === "registered")
          .map(({ collection }) => collection),
      ).toEqual([true, true]);
    }),
  );
  test.effect("lists each declaration reason code in catalog, in JSON and in human output", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write(
        "mixed/tack.yaml",
        [
          "version: 1",
          "skills:",
          "  - path: skills",
          "  - pth: typo",
          "  - path: ../up",
          "  - path: nowhere",
          "  - path: skills/file.txt",
          "  - path: labs/solo",
          "    exclude: ['x']",
          "  - path: skills/nested",
          "",
        ].join("\n"),
      );
      yield* write("mixed/skills/ok/SKILL.md", "---\nname: ok\ndescription: Ok\n---\n");
      yield* write("mixed/skills/file.txt", "x");
      yield* write("mixed/skills/nested/other/SKILL.md", "---\nname: other\ndescription: O\n---\n");
      yield* write("mixed/labs/solo/SKILL.md", "---\nname: solo\ndescription: S\n---\n");
      yield* run(root, state, ["state", "init"]);
      yield* run(root, state, ["source", "add", path.join(root, "mixed")]);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.symlink(path.dirname(root), path.join(root, "mixed", "escape"));
      yield* write(
        "mixed/tack.yaml",
        (yield* fs.readFileString(path.join(root, "mixed/tack.yaml"))) +
          "  - path: escape\nscripts:\n  - name: report\n    path: skills/ok/SKILL.md\n    description: Not typescript\n",
      );

      const catalog = yield* json(root, state, ["catalog"]);
      const { issues } = Schema.decodeUnknownSync(
        Schema.Struct({ issues: Schema.Array(Schema.Struct({ code: Schema.String })) }),
      )(catalog.result);
      const codes = new Set(issues.map(({ code }) => code));
      for (const code of [
        "declaration-entry-invalid",
        "declaration-path-invalid",
        "declaration-path-missing",
        "declaration-path-outside-source",
        "declaration-path-overlap",
        "declaration-path-wrong-type",
      ])
        expect(codes.has(code), code).toBe(true);
      const human = yield* run(root, state, ["catalog"]);
      for (const code of codes) expect(human).toContain(code);
    }),
  );
  test.effect(
    "lists each declaration of a source in source and names the declaring entry in catalog",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write } = yield* scratch;
        yield* write(
          "lib/tack.yaml",
          [
            "version: 1",
            "skills:",
            "  - path: skills",
            "    exclude: ['**/_*/**']",
            "  - path: vendor/skills",
            "  - path: nowhere",
            "scripts:",
            "  - name: report",
            "    path: tools/report.ts",
            "    description: Report",
            "",
          ].join("\n"),
        );
        yield* write("lib/skills/adhd/SKILL.md", "---\nname: adhd\ndescription: Adhd\n---\n");
        yield* write("lib/skills/_old/gone/SKILL.md", "---\nname: gone\ndescription: Gone\n---\n");
        yield* write("lib/vendor/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: Pdf\n---\n");
        yield* write("lib/tools/report.ts", "export {}");
        yield* run(root, state, ["state", "init"]);
        yield* run(root, state, ["source", "add", path.join(root, "lib")]);

        const source = yield* json(root, state, ["source"]);
        const lib = Schema.decodeUnknownSync(
          Schema.Struct({
            sources: Schema.Array(
              Schema.Struct({
                status: Schema.String,
                origin: Schema.optionalKey(Schema.String),
                declarations: Schema.optionalKey(Schema.Array(Schema.Unknown)),
              }),
            ),
          }),
        )(source.result).sources.find(({ origin }) => origin === undefined);
        expect(lib?.declarations).toEqual([
          { kind: "skill", path: "skills", exclude: ["**/_*/**"], resources: 1, problems: [] },
          { kind: "skill", path: "vendor/skills", resources: 1, problems: [] },
          {
            kind: "skill",
            path: "nowhere",
            resources: 0,
            problems: [
              expect.objectContaining({
                code: "declaration-path-missing",
                candidatePath: expect.any(String),
              }),
            ],
          },
          { kind: "script", path: "tools/report.ts", name: "report", resources: 1, problems: [] },
        ]);
        const human = yield* run(root, state, ["source"]);
        expect(human).toMatch(/skills\s+skills\s+1 resource\s+exclude \*\*\/_\*\/\*\*/);
        expect(human).toMatch(/skills\s+vendor\/skills\s+1 resource/);
        expect(human).toMatch(/skills\s+nowhere\s+0 resources/);
        expect(human).toContain("! declaration-path-missing");
        expect(human).toMatch(/scripts\s+tools\/report.ts\s+1 resource\s+name report/);

        const catalog = yield* json(root, state, ["catalog", "--details"]);
        const declared = Schema.decodeUnknownSync(
          Schema.Struct({
            resources: Schema.Array(
              Schema.Struct({
                address: Schema.Struct({ name: Schema.String }),
                origin: Schema.String,
                declaredPath: Schema.optionalKey(Schema.String),
              }),
            ),
          }),
        )(catalog.result)
          .resources.filter(({ origin }) => origin === "registered")
          .map(({ address, declaredPath }) => `${address.name}:${declaredPath}`);
        expect(declared.toSorted((left, right) => left.localeCompare(right))).toEqual([
          "adhd:skills",
          "pdf:vendor/skills",
          "report:tools/report.ts",
        ]);
        const plain = Schema.decodeUnknownSync(
          Schema.Struct({
            resources: Schema.Array(
              Schema.Struct({
                address: Schema.Struct({ name: Schema.String }),
                declaredPath: Schema.optionalKey(Schema.String),
                kind: Schema.String,
              }),
            ),
          }),
        )((yield* json(root, state, ["catalog"])).result);
        expect(
          plain.resources
            .filter(({ kind }) => kind !== "script")
            .every(({ declaredPath }) => declaredPath === undefined),
        ).toBe(true);
        expect(yield* run(root, state, ["catalog", "--details"])).toContain(
          "declared by skills: vendor/skills",
        );
        expect(yield* run(root, state, ["catalog"])).not.toContain("declared by");
      }),
  );
});
