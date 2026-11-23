import { declare, skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import {
  addSource,
  changedPaths,
  importRequest,
  snapshotTree,
  withImportWorld,
  type ImportWorld,
} from "../../../test/support/import-world.ts";
import { readState } from "../../services/state-store.ts";
import { applyImport, previewImport } from "./import.ts";
import { inspectImports, observeImports } from "./import-inspect.ts";
import { inspectSources } from "../sources/source.ts";
import { readImportsSection } from "./imports-section.ts";

const commit = {
  files: {
    "skills/pdf/SKILL.md": skillText("pdf"),
    "skills/docx/SKILL.md": skillText("docx"),
  },
} as const;
const files = { "skills/a/SKILL.md": skillText("a") };
const declaration = declare("skills: [{ path: skills }]");

const recordsIn = (text: string) => {
  const section = readImportsSection(text);
  if (Result.isFailure(section)) throw new Error(section.failure.message);
  return section.success.records;
};

const list = (world: ImportWorld) => readState(world.options).pipe(Effect.flatMap(inspectImports));

it.layer(LiveTestLayer)("import listing", (test) => {
  test.effect("lists records across sources sorted by reference", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        yield* addSource(world, "vault", declare("skills: [{ path: skills }]"), {
          "skills/z/SKILL.md": skillText("z"),
        });
        yield* applyImport(world.options, importRequest({ into: "vault", skills: ["docx"] }));
        yield* applyImport(
          world.options,
          importRequest({ into: "personal-brain", skills: ["pdf"] }),
        );
        const result = yield* list(world);
        expect(result.kind).toBe("import-list");
        expect(result.imports.map((entry) => entry.reference)).toEqual([
          "personal-brain:pdf",
          "vault:docx",
        ]);
        expect(result.imports[0]).toMatchObject({
          name: "pdf",
          source: "personal-brain",
          path: "skills/pdf",
          location: "github:acme/skills",
          transport: "https",
          ref: { kind: "default", tracking: true },
          revision: world.revisions[0],
          upstreamPath: "skills/pdf",
          local: { state: "unchanged" },
          conditions: [],
        });
        expect(result.problems).toEqual([]);
      }),
    ),
  );

  test.effect("an imports key in flow style is a problem, and refuses preview and apply", () =>
    withImportWorld(
      {
        declaration: "version: 1\nimports: []\nskills:\n  - path: skills\n",
        files,
        commits: [commit],
      },
      (world) =>
        Effect.gen(function* () {
          const before = yield* snapshotTree(world.root);
          const result = yield* list(world);
          expect(result.problems).toMatchObject([
            { source: "personal-brain", code: "imports-invalid" },
          ]);
          expect(result.problems[0]?.message).toContain("line 2");
          const request = importRequest({ into: "personal-brain", skills: ["pdf"] });
          const preview = yield* previewImport(world.options, request).pipe(Effect.flip);
          expect(preview).toMatchObject({ code: "import-records-invalid" });
          expect(preview.message).toContain("line 2");
          const apply = yield* applyImport(world.options, request).pipe(Effect.flip);
          expect(apply).toMatchObject({ code: "import-records-invalid" });
          expect(changedPaths(before, yield* snapshotTree(world.root))).toEqual([]);
        }),
    ),
  );

  test.effect("a source with a bad section does not hide another source's imports", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        yield* applyImport(
          world.options,
          importRequest({ into: "personal-brain", skills: ["pdf"] }),
        );
        yield* addSource(world, "broken", "version: 1\nimports: []\nskills:\n  - path: skills\n", {
          "skills/z/SKILL.md": skillText("z"),
        });
        const result = yield* list(world);
        expect(result.imports.map((entry) => entry.reference)).toEqual(["personal-brain:pdf"]);
        expect(result.problems.map((problem) => [problem.source, problem.code])).toEqual([
          ["broken", "imports-invalid"],
        ]);
      }),
    ),
  );

  test.effect("a folder no declaration covers is reported as not cataloged", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* applyImport(
          world.options,
          importRequest({ into: "personal-brain", skills: ["pdf"] }),
        );
        const yamlPath = `${world.root}/tack.yaml`;
        const text = yield* fileSystem.readFileString(yamlPath);
        yield* fileSystem.writeFileString(
          yamlPath,
          text.replace(
            "skills: [{ path: skills }]",
            'skills:\n  - path: skills\n    exclude: ["pdf"]',
          ),
        );
        const [entry] = (yield* list(world)).imports;
        expect(entry?.conditions.map((condition) => condition.code)).toEqual([
          "import-folder-not-cataloged",
        ]);
      }),
    ),
  );
});

/** Writes the intent of an interrupted add of `pdf`, with the staged folder when asked. */
const interruptedAdd = (world: ImportWorld, staged: boolean) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const yamlPath = `${world.root}/tack.yaml`;
    const original = yield* fileSystem.readFileString(yamlPath);
    yield* applyImport(world.options, importRequest({ into: "personal-brain", skills: ["pdf"] }));
    const record = recordsIn(yield* fileSystem.readFileString(yamlPath))[0];
    // Rewind to the moment of the crash: the declaration as it was, the staging folder in place.
    yield* fileSystem.writeFileString(yamlPath, original);
    const staging = `${world.root}/.tack-import-staging`;
    yield* fileSystem.makeDirectory(staging, { recursive: true });
    yield* fileSystem.writeFileString(
      `${staging}/intent.json`,
      JSON.stringify({
        version: 1,
        operation: "add",
        items: [{ index: 0, path: "skills/pdf", record, newFolders: [] }],
      }),
    );
    if (staged) {
      yield* fileSystem.rename(`${world.root}/skills/pdf`, `${staging}/pdf-staged`);
      yield* fileSystem.makeDirectory(`${staging}/new`, { recursive: true });
      yield* fileSystem.rename(`${staging}/pdf-staged`, `${staging}/new/0`);
    }
    return original;
  });

it.layer(LiveTestLayer)("import recovery", (test) => {
  test.effect("a leftover staging folder is a problem the next apply settles", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(`${world.root}/.tack-import-staging/new`, {
          recursive: true,
        });
        expect((yield* list(world)).problems.map((problem) => problem.code)).toEqual([
          "staging-left-over",
        ]);
        // A preview reports and writes nothing.
        const before = yield* snapshotTree(world.root);
        yield* previewImport(
          world.options,
          importRequest({ into: "personal-brain", skills: ["pdf"] }),
        );
        expect(changedPaths(before, yield* snapshotTree(world.root))).toEqual([]);
        const { applied } = yield* applyImport(
          world.options,
          importRequest({ into: "personal-brain", skills: ["pdf"] }),
        );
        expect(applied.recovered).toHaveLength(1);
        expect(yield* fileSystem.exists(`${world.root}/.tack-import-staging`)).toBe(false);
        expect((yield* list(world)).problems).toEqual([]);
      }),
    ),
  );

  test.effect(
    "a folder moved into place without its record is finished: the record is written",
    () =>
      withImportWorld({ declaration, files, commits: [commit] }, (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          // Interrupted after the move: the folder is in place, the record is not.
          const original = yield* fileSystem.readFileString(`${world.root}/tack.yaml`);
          yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["pdf"] }),
          );
          const withRecord = yield* fileSystem.readFileString(`${world.root}/tack.yaml`);
          const records = recordsIn(withRecord);
          yield* fileSystem.writeFileString(`${world.root}/tack.yaml`, original);
          yield* fileSystem.makeDirectory(`${world.root}/.tack-import-staging`);
          yield* fileSystem.writeFileString(
            `${world.root}/.tack-import-staging/intent.json`,
            JSON.stringify({
              version: 1,
              operation: "add",
              items: [
                {
                  index: 0,
                  path: "skills/pdf",
                  record: records[0],
                  newFolders: [],
                },
              ],
            }),
          );
          const { applied } = yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["docx"] }),
          );
          expect(applied.recovered).toEqual(["Finished the interrupted import of skills/pdf."]);
          const result = yield* list(world);
          expect(result.imports.map((entry) => [entry.reference, entry.local.state])).toEqual([
            ["personal-brain:docx", "unchanged"],
            ["personal-brain:pdf", "unchanged"],
          ]);
          expect(yield* fileSystem.exists(`${world.root}/.tack-import-staging`)).toBe(false);
        }),
      ),
  );

  test.effect("a staged folder that was never moved is rolled back", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const original = yield* interruptedAdd(world, true);
        expect(yield* fileSystem.exists(`${world.root}/skills/pdf`)).toBe(false);
        const { applied } = yield* applyImport(
          world.options,
          importRequest({ into: "personal-brain", skills: ["docx"] }),
        );
        expect(applied.recovered).toEqual(["Rolled back the interrupted import of skills/pdf."]);
        expect(yield* fileSystem.exists(`${world.root}/skills/pdf`)).toBe(false);
        expect(yield* fileSystem.exists(`${world.root}/.tack-import-staging`)).toBe(false);
        const text = yield* fileSystem.readFileString(`${world.root}/tack.yaml`);
        expect(text.startsWith(original)).toBe(true);
        expect(text).not.toContain("path: skills/pdf");
        expect(text).toContain("path: skills/docx");
      }),
    ),
  );

  test.effect("a tack.yaml that vanished after inspection reads as an invalid section", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const inspections = yield* inspectSources(yield* readState(world.options));
        yield* fileSystem.remove(`${world.root}/tack.yaml`);
        const observed = yield* observeImports(inspections);
        expect(observed.imports).toEqual([]);
        expect(observed.problems).toMatchObject([
          {
            source: "personal-brain",
            code: "imports-invalid",
            message: expect.stringContaining("mapping"),
          },
        ]);
      }),
    ),
  );
});
