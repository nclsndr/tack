import { skillText } from "./support/source-tree.ts";
import { fakeGit } from "./support/fake-git.ts";
import { writeUnder } from "./support/source-tree.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { exitCodeForEnvelope } from "../src/cli/host/public-outcome.ts";
import { SourceRegistrationPayloadSchema } from "../src/features/sources/source.ts";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

const git = (root: string) => fakeGit(root, [{ path: root }]);

/**
 * Runs one command in process and returns its raw stdout. The scratch root is the home, so a
 * user-scope command writes its links there and never into the operator's real agent folders.
 */
const run = (root: string, state: string, arguments_: ReadonlyArray<string>, stdin?: string) =>
  runHost({
    args: ["--state-dir", state, ...arguments_],
    git: git(root),
    env: { HOME: root },
    ...(stdin === undefined ? {} : { stdin }),
  }).pipe(Effect.map((result) => result.stdout));

const json = (root: string, state: string, arguments_: ReadonlyArray<string>, stdin?: string) =>
  run(root, state, ["--json", ...arguments_], stdin).pipe(Effect.map(decodeEnvelope));

const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-decl-out-" }));
  const write = writeUnder(root);
  /** `declaration` as the JSON `--config` takes, pretty-printed so each key has its own line. */
  const config = (declaration: unknown) => JSON.stringify(declaration, null, 2);
  return { root, state: path.join(root, "state"), path, write, config };
});

it.layer(LiveTestLayer)("local source authoring", (test) => {
  test.effect(
    "source add previews registering a source that has a tack.yaml, and --apply registers it",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write } = yield* scratch;
        const fs = yield* FileSystem.FileSystem;
        yield* write("source/tack.yaml", "version: 1\nname: tools\nskills:\n  - path: skills\n");
        yield* write(
          "source/skills/review/SKILL.md",
          skillText("review", { description: "Review changes", body: "" }),
        );
        const directory = path.join(root, "source");
        yield* run(root, state, ["state", "init"]);
        const stateFile = path.join(state, "state.json");
        const initial = yield* fs.readFileString(stateFile);

        const preview = yield* json(root, state, ["source", "add", directory]);
        expect(preview).toMatchObject({
          classification: "success",
          applied: null,
          plan: {
            kind: "source-registration-plan",
            sourcePath: directory,
            name: "tools",
            alreadyRegistered: false,
            inspection: { counts: { skill: 1 }, findings: [] },
          },
          next: [`tack source add ${directory} --apply`],
        });
        expect(yield* fs.readFileString(stateFile)).toBe(initial);
        const text = (yield* run(root, state, ["source", "add", directory])).replaceAll(
          /\s+/g,
          " ",
        );
        expect(text).toContain("Would register source tools (");
        expect(text).toContain("No files or state changed.");

        const applied = yield* json(root, state, ["source", "add", directory, "--apply"]);
        expect(applied).toMatchObject({
          classification: "success",
          applied: { kind: "source-registration", alreadyRegistered: false, name: "tools" },
        });
        // A source that is registered already previews as such; applying changes nothing.
        const again = yield* json(root, state, ["source", "add", directory]);
        expect(again).toMatchObject({
          classification: "success",
          plan: { alreadyRegistered: true, name: "tools" },
        });
        expect(
          (yield* run(root, state, ["source", "add", directory])).replaceAll(/\s+/g, " "),
        ).toContain(") is already registered.");
      }),
  );
  test.effect("checks an unregistered source without initialized state and does not write", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      const fs = yield* FileSystem.FileSystem;
      yield* write("source/tack.yaml", "version: 1\nname: source\nskills:\n  - path: skills\n");
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
        "version: 1\nname: source\nskills:\n  - path: skills\ncommands:\n  - path: missing\ncontext:\n  - path: absent\n",
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
            line: 6,
            file: path.join(root, "source/tack.yaml"),
          }),
          expect.objectContaining({ code: "declaration-path-missing", line: 8 }),
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
        "version: 1\nname: source\ncommands:\n  - path: commands\ncontext:\n  - path: context\n",
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
        yield* write("source/tack.yaml", "version: 1\nname: source\nskills: wrong\ndocs: wrong\n");
        const result = yield* json(root, state, ["check", path.join(root, "source")]);
        expect(result.result).toMatchObject({
          findings: expect.arrayContaining([
            expect.objectContaining({ line: 3 }),
            expect.objectContaining({ line: 4 }),
          ]),
        });
      }),
  );
  test.effect("empty declarations warn with success, malformed and missing declarations fail", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write("empty/tack.yaml", "version: 1\nname: empty\n");
      const empty = yield* json(root, state, ["check", path.join(root, "empty")]);
      expect(exitCodeForEnvelope(empty)).toBe(0);
      expect(empty.result).toMatchObject({
        findings: [{ severity: "warning", code: "source-declares-no-resources" }],
      });
      for (const text of [
        "version: [",
        "version: 3\n",
        "version: 1\n",
        "version: 1\nname: broken\nunknown: true\n",
      ]) {
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
        "version: 1\nname: entry\nscripts:\n  - name: Bad Name\n    path: 42\n    description: ''\n",
      );
      const entry = yield* json(root, state, ["check", path.join(root, "entry")]);
      expect(exitCodeForEnvelope(entry)).toBe(1);
      expect(entry.result).toMatchObject({
        findings: [expect.objectContaining({ code: "declaration-entry-invalid", line: 4 })],
      });
      yield* write("layout/skills/.keep", "");
      yield* write(
        "layout/tack.yaml",
        "version: 1\nname: layout\ndocs:\n  - name: handbook\n    path: missing-docs\n",
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
      yield* write("source/tack.yaml", "version: 1\nname: source\nskills:\n  - path: missing\n");
      yield* run(root, state, ["state", "init"]);
      const result = yield* json(root, state, [
        "source",
        "add",
        path.join(root, "source"),
        "--apply",
      ]);
      expect(exitCodeForEnvelope(result)).toBe(0);
      expect(result.applied).toMatchObject({
        inspection: {
          counts: { skill: 0 },
          findings: [expect.objectContaining({ code: "declaration-path-missing" })],
        },
      });
      expect(result.next.join(" ")).toContain("tack check");
      const text = yield* run(root, state, ["source", "add", path.join(root, "source"), "--apply"]);
      expect(text).toContain("declaration-path-missing");
      expect(text).toContain("0 skills");
    }),
  );
  test.effect(
    "source add previews the tack.yaml a config declares without state, writes only with apply, never overwrites",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write, config } = yield* scratch;
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
        const declared = config({
          version: 1,
          name: "source",
          skills: [{ path: "personal/skills" }],
          commands: [{ path: "prompts" }],
          context: [{ path: "notes" }],
          docs: [{ name: "documents", path: "alpha/documents" }],
        });
        const bare = yield* json(root, state, ["source", "add", directory, "--apply"]);
        expect(exitCodeForEnvelope(bare)).toBe(2);
        expect(bare.diagnostics).toMatchObject([{ code: "declaration-config-required" }]);
        expect(bare.next).toEqual(["tack guide tack-yaml"]);
        const preview = yield* json(root, state, [
          "source",
          "add",
          directory,
          "--config",
          declared,
        ]);
        expect(exitCodeForEnvelope(preview)).toBe(0);
        expect(preview.applied).toBe(null);
        expect(preview.plan).toMatchObject({
          kind: "source-scaffold",
          name: "source",
          config: "argument",
          declarationPath: declaration,
          content: expect.stringMatching(/^version: 1\nname: source\n/),
          entries: [
            { kind: "skill", path: "personal/skills", resources: ["review"] },
            { kind: "command", path: "prompts", resources: ["review"] },
            { kind: "context", path: "notes", resources: ["guide.md"] },
            { kind: "docs", path: "alpha/documents", resources: ["documents"] },
          ],
        });
        expect(preview.next).toEqual([]);
        expect(yield* fs.exists(declaration)).toBe(false);
        expect(yield* fs.exists(state)).toBe(false);
        const human = yield* run(root, state, ["source", "add", directory, "--config", declared]);
        expect(human).toContain("skills personal/skills · 1 skill");
        // The JSON is never echoed back: the preview says to repeat the command with --apply.
        expect(human.split(/\s+/).join(" ")).toContain(
          "Run the same command again with --apply to write tack.yaml and register the source.",
        );
        expect(human).not.toContain('"version"');
        const flags = ["source", "add", directory, "--config", declared, "--apply"];
        const failed = yield* json(root, state, flags);
        expect(exitCodeForEnvelope(failed)).toBe(2);
        expect(yield* fs.exists(declaration)).toBe(false);
        yield* run(root, state, ["state", "init"]);
        const stateFile = path.join(state, "state.json");
        const initial = yield* fs.readFileString(stateFile);
        yield* write("present/tack.yaml", "version: 1\nname: present\n");
        const registered = yield* json(root, state, [
          "source",
          "add",
          path.join(root, "present"),
          "--apply",
        ]);
        expect(registered.applied).not.toBe(null);
        const afterRegistration = yield* fs.readFileString(stateFile);
        expect(afterRegistration).not.toBe(initial);
        yield* json(root, state, ["source", "add", directory, "--config", declared]);
        expect(yield* fs.readFileString(stateFile)).toBe(afterRegistration);
        const applied = yield* json(root, state, flags);
        expect(exitCodeForEnvelope(applied)).toBe(0);
        expect(applied.applied).toMatchObject({
          scaffolded: declaration,
          name: "source",
          inspection: { counts: { skill: 1, command: 1, context: 1, script: 0, docs: 1 } },
        });
        const content = yield* fs.readFileString(declaration);
        expect(preview.plan).toMatchObject({ content });
        yield* fs.writeFileString(declaration, content + "# keep my edits\n");
        const again = yield* json(root, state, flags);
        expect(again.diagnostics).toMatchObject([{ code: "declaration-exists" }]);
        expect(yield* fs.readFileString(declaration)).toBe(content + "# keep my edits\n");
      }),
  );
  test.effect("source add reads --config - from standard input and names - again to apply", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      const fs = yield* FileSystem.FileSystem;
      yield* write("team/review/SKILL.md", "---\nname: review\ndescription: R\n---\n");
      const directory = path.join(root, "team");
      const stdin = JSON.stringify({ version: 1, name: "team", skills: [{ path: "." }] });
      const args = ["source", "add", directory, "--config", "-"];
      const preview = yield* json(root, state, args, stdin);
      expect(preview).toMatchObject({
        classification: "success",
        plan: {
          config: "standard-input",
          content: "version: 1\nname: team\nskills:\n  - path: .\n",
        },
        next: [],
      });
      expect((yield* run(root, state, args, stdin)).split(/\s+/).join(" ")).toContain(
        "Run the same command again with --apply, piping the same JSON,",
      );
      yield* run(root, state, ["state", "init"]);
      const applied = yield* json(root, state, [...args, "--apply"], stdin);
      expect(applied.applied).toMatchObject({ scaffolded: path.join(directory, "tack.yaml") });
      expect(yield* fs.readFileString(path.join(directory, "tack.yaml"))).toBe(
        "version: 1\nname: team\nskills:\n  - path: .\n",
      );
      // A folder that does not exist is refused before standard input is parsed.
      const empty = yield* json(root, state, [
        "source",
        "add",
        path.join(root, "x"),
        "--config",
        "-",
      ]);
      expect(empty.diagnostics).toMatchObject([{ code: "source-missing" }]);
    }),
  );
  test.effect("source add reads --config as JSON, never as a path to a file", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write("team/review/SKILL.md", "---\nname: review\ndescription: R\n---\n");
      yield* write("team.json", JSON.stringify({ version: 1, name: "team", kind: "skills" }));
      const refused = yield* json(root, state, [
        "source",
        "add",
        path.join(root, "team"),
        "--config",
        path.join(root, "team.json"),
      ]);
      expect(exitCodeForEnvelope(refused)).toBe(2);
      expect(refused.diagnostics).toMatchObject([{ code: "config-not-json" }]);
    }),
  );
  test.effect(
    "source add reports every issue of a config that does not validate, at its field and line",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write, config } = yield* scratch;
        const fs = yield* FileSystem.FileSystem;
        yield* write(
          "My Skills/skills/review/SKILL.md",
          "---\nname: review\ndescription: R\n---\n",
        );
        const directory = path.join(root, "My Skills");
        const declared = config({
          version: 1,
          skils: [{ path: "skills" }],
          "depends-on": ["Bad"],
        });
        const refused = yield* json(root, state, [
          "source",
          "add",
          directory,
          "--config",
          declared,
        ]);
        expect(exitCodeForEnvelope(refused)).toBe(2);
        expect(refused).toMatchObject({
          classification: "invalid-configuration",
          next: ["tack guide tack-yaml"],
          diagnostics: [
            {
              code: "declaration-schema-invalid",
              message: expect.stringContaining('Unknown key "skils"'),
              details: { config: "argument", field: "skils", line: 3 },
            },
            {
              code: "declaration-schema-invalid",
              message: expect.stringContaining("depends-on[0]: "),
              details: { config: "argument", field: "depends-on[0]", line: 9 },
            },
            {
              code: "declaration-schema-invalid",
              message: expect.stringContaining('Add "name: my-skills" to it'),
              details: { config: "argument", field: "name", line: 1 },
            },
          ],
        });
        const human = (yield* run(root, state, ["source", "add", directory, "--config", declared]))
          .split(/\s+/)
          .join(" ");
        expect(human).toContain("field skils");
        expect(human).toContain("line 3");
        const yaml = yield* json(
          root,
          state,
          ["source", "add", directory, "--config", "-"],
          "version: 1\n",
        );
        expect(yaml.diagnostics).toMatchObject([{ code: "config-not-json" }]);
        expect(yield* fs.exists(path.join(directory, "tack.yaml"))).toBe(false);
      }),
  );
  test.effect(
    "source add names a source whose name another source already carries by its registration ID",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write, config } = yield* scratch;
        yield* write("one/team/tack.yaml", "version: 1\nname: team\nskills: [{ path: . }]\n");
        yield* write("two/team/review/SKILL.md", "---\nname: review\ndescription: R\n---\n");
        yield* run(root, state, ["state", "init"]);
        yield* json(root, state, ["source", "add", path.join(root, "one", "team"), "--apply"]);
        const declared = config({ version: 1, name: "team", skills: [{ path: "." }] });
        const flags = ["source", "add", path.join(root, "two", "team"), "--config", declared];
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
        // The same holds for a source that has its tack.yaml: its preview names it by path only.
        yield* write("three/team/tack.yaml", "version: 1\nname: team\nskills: [{ path: . }]\n");
        const third = path.join(root, "three", "team");
        const registering = yield* json(root, state, ["source", "add", third]);
        expect(registering.plan).toMatchObject({ kind: "source-registration-plan" });
        expect(registering.plan).not.toHaveProperty("name");
        expect(
          (yield* run(root, state, ["source", "add", third])).replaceAll(/\s+/g, " "),
        ).toContain("Would register source /");
      }),
  );
  test.effect("source add and check refuse kind with the declaration to write instead", () =>
    Effect.gen(function* () {
      const { root, state, path, write, config } = yield* scratch;
      const flat = path.join(root, "flat");
      yield* write("flat/alpha/SKILL.md", "---\nname: alpha\ndescription: S\n---\n");
      const args = [
        "source",
        "add",
        flat,
        "--config",
        config({ version: 1, name: "flat", kind: "skills" }),
      ];
      const preview = yield* json(root, state, args);
      expect(preview.diagnostics).toMatchObject([
        {
          code: "declaration-schema-invalid",
          message: expect.stringContaining(
            'Write instead:\n  {"version":1,"name":"flat","skills":[{"path":"."}]}',
          ),
        },
      ]);
      yield* write("flat/tack.yaml", "version: 1\nname: flat\nkind: skills\n");
      const checked = yield* run(root, state, ["check", flat]);
      expect(checked).toContain(
        [
          `${path.join(flat, "tack.yaml")}:3: error declaration-schema-invalid: A tack.yaml takes no kind key: a "." entry declares the folder that holds it. Write instead:`,
          "  version: 1",
          "  name: flat",
          "  skills:",
          "    - path: .",
        ].join("\n"),
      );
    }),
  );
  test.effect("source add previews a tack.yaml that warns with the warning beside its counts", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write("flat/tack.yaml", "version: 1\nname: flat\n");
      const text = (yield* run(root, state, ["source", "add", path.join(root, "flat")]))
        .split(/\s+/)
        .join(" ");
      expect(text).toContain("Would register source flat");
      expect(text).toContain("warning: source-declares-no-resources:");
    }),
  );
  test.effect(
    "source add refuses a tack.yaml that a registered source's walk reaches until it excludes it",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write, config } = yield* scratch;
        yield* write("parent/tack.yaml", "version: 1\nname: parent\nskills:\n  - path: skills\n");
        yield* write("parent/skills/review/SKILL.md", "---\nname: review\ndescription: R\n---\n");
        yield* write(
          "parent/skills/vendor/skills/lint/SKILL.md",
          "---\nname: lint\ndescription: L\n---\n",
        );
        yield* run(root, state, ["state", "init"]);
        yield* json(root, state, ["source", "add", path.join(root, "parent"), "--apply"]);
        const vendor = path.join(root, "parent", "skills", "vendor");
        const declared = config({
          version: 1,
          name: "vendor",
          skills: [{ path: "skills" }],
        });
        const refused = yield* json(root, state, ["source", "add", vendor, "--config", declared]);
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
        const preview = yield* json(root, state, ["source", "add", vendor, "--config", declared]);
        expect(exitCodeForEnvelope(preview)).toBe(0);
        expect(preview.plan).toMatchObject({ entries: [{ kind: "skill", resources: ["lint"] }] });
      }),
  );
  test.effect(
    "source add previews a declared resource that cannot be read as partial, under Problems",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write, config } = yield* scratch;
        yield* write(
          "source/skills/review/SKILL.md",
          "---\nname: review\ndescription: Review a change.\n---\nReview.\n",
        );
        // An unquoted colon in a description is a common hand-written frontmatter mistake.
        yield* write("source/commands/ship.md", "---\ndescription: Ship it: now\n---\nShip.\n");
        const directory = path.join(root, "source");
        const declared = config({
          version: 1,
          name: "source",
          skills: [{ path: "skills" }],
          commands: [{ path: "commands" }],
        });
        yield* run(root, state, ["state", "init"]);

        const args = ["source", "add", directory, "--config", declared];
        const preview = yield* json(root, state, args);
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
          next: [],
        });
        const text = yield* run(root, state, args);
        // Listed once, under Problems, not again beside its entry.
        expect(text).toContain("Problems");
        expect(text.split("command-frontmatter-invalid").length).toBe(2);
      }),
  );
  test.effect(
    "source add previews a declaration that would load nothing as partial and refuses to apply it",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write, config } = yield* scratch;
        const fs = yield* FileSystem.FileSystem;
        // Each entry names a file its kind cannot read, so every entry has a problem.
        yield* write("source/guide.md", "# Guide\n");
        yield* write("source/notes.txt", "Notes\n");
        const directory = path.join(root, "source");
        const declaration = path.join(directory, "tack.yaml");
        const declared = config({
          version: 1,
          name: "source",
          skills: [{ path: "guide.md" }],
          commands: [{ path: "notes.txt" }],
        });
        yield* run(root, state, ["state", "init"]);
        const stateFile = path.join(state, "state.json");
        const initial = yield* fs.readFileString(stateFile);

        const args = ["source", "add", directory, "--config", declared];
        const preview = yield* json(root, state, args);
        expect(exitCodeForEnvelope(preview)).toBe(1);
        expect(preview.diagnostics).toMatchObject([
          {
            code: "declaration-path-wrong-type",
            severity: "error",
            details: { field: "commands[0]", line: 10 },
          },
          {
            code: "declaration-path-wrong-type",
            severity: "error",
            details: { field: "skills[0]", line: 5 },
          },
          { code: "declaration-loads-nothing", severity: "warning" },
        ]);
        expect(preview.next).toEqual([]);
        expect(preview.plan).toMatchObject({
          entries: [
            { kind: "skill", resources: [], findings: [{ code: "declaration-path-wrong-type" }] },
            { kind: "command", resources: [], findings: [{ code: "declaration-path-wrong-type" }] },
          ],
        });
        const text = yield* run(root, state, args);
        expect(text).toContain("declaration-loads-nothing");
        expect(text).not.toContain("--apply");

        const applied = yield* json(root, state, [...args, "--apply"]);
        expect(exitCodeForEnvelope(applied)).toBe(2);
        expect(applied.diagnostics).toMatchObject([{ code: "declaration-loads-nothing" }]);
        expect(applied.next).toEqual([]);
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
      yield* run(root, state, ["source", "add", path.join(root, "bare"), "--apply"]);

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
      yield* write("broken/tack.yaml", "version: 1\nname: broken\nskills:\n  - path: missing\n");
      yield* run(root, state, ["state", "init"]);
      yield* run(root, state, ["source", "add", path.join(root, "broken"), "--apply"]);

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
      yield* run(root, state, ["source", "add", path.join(root, "old"), "--apply"]);
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

  test.effect(
    "shows a skills entry at . as the path . in source, catalog --details and check",
    () =>
      Effect.gen(function* () {
        const { root, state, path, write } = yield* scratch;
        yield* write("flat/tack.yaml", "version: 1\nname: flat\nskills:\n  - path: .\n");
        yield* write("flat/review/SKILL.md", "---\nname: review\ndescription: R\n---\n");
        yield* write("flat/git/SKILL.md", "---\nname: git\ndescription: G\n---\n");
        const directory = path.join(root, "flat");
        const check = yield* run(root, state, ["check", directory]);
        expect(check).toContain("skill: 2");
        yield* run(root, state, ["state", "init"]);
        yield* run(root, state, ["source", "add", directory, "--apply"]);
        expect(yield* run(root, state, ["source"])).toMatch(/skills +\. +2 resources/);
        expect(yield* run(root, state, ["catalog", "--details"])).toContain(
          "declared by skills: .",
        );
        const details = Schema.decodeUnknownSync(
          Schema.Struct({
            resources: Schema.Array(
              Schema.Struct({
                origin: Schema.String,
                declaredPath: Schema.optionalKey(Schema.String),
              }),
            ),
          }),
        )((yield* json(root, state, ["catalog", "--details"])).result);
        expect(
          details.resources
            .filter(({ origin }) => origin === "registered")
            .map(({ declaredPath }) => declaredPath),
        ).toEqual([".", "."]);
      }),
  );
  test.effect("lists each declaration reason code in catalog, in JSON and in human output", () =>
    Effect.gen(function* () {
      const { root, state, path, write } = yield* scratch;
      yield* write(
        "mixed/tack.yaml",
        [
          "version: 1",
          "name: mixed",
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
      yield* run(root, state, ["source", "add", path.join(root, "mixed"), "--apply"]);
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
            "name: lib",
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
        yield* run(root, state, ["source", "add", path.join(root, "lib"), "--apply"]);

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
