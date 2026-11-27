import { skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Result } from "effect";
import { symlink } from "node:fs/promises";
import { vi } from "vitest";
import { crashAtVariable } from "../../services/installation.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import type { ImportRecord } from "../../domain/imports/import-record.ts";
import { isTextBytes, recordFilesOf, type SkillFile } from "./import-files.ts";
import {
  recoverStaging,
  removeImports,
  stagingPathOf,
  writeImports,
  type StagedImport,
} from "./import-write.ts";
import { readImportsSection } from "./imports-section.ts";

const encoder = new TextEncoder();
const filesOf = (name: string): ReadonlyArray<SkillFile> => [
  { path: "SKILL.md", bytes: encoder.encode(skillText(name)), executable: false },
];
const recordOf = (name: string, folder = "skills"): ImportRecord => {
  const { files, digest } = recordFilesOf(filesOf(name));
  return {
    path: `${folder}/${name}`,
    location: "github:acme/skills",
    transport: "https",
    "ref-kind": "default",
    revision: "c".repeat(40),
    "upstream-path": `skills/${name}`,
    "upstream-tree": "d".repeat(40),
    "imported-at": "2026-11-11T12:40:00Z",
    digest,
    files,
  };
};
const staged = (name: string, newFolders: ReadonlyArray<string> = []): StagedImport => {
  const folder = newFolders.at(-1) ?? "skills";
  return {
    name,
    path: `${folder}/${name}`,
    files: filesOf(name),
    record: recordOf(name, folder),
    newFolders,
  };
};

/** A source root with a declared `skills` folder and no imports yet. */
const withRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-import-write-" }),
    );
    yield* fileSystem.makeDirectory(`${root}/skills`);
    yield* fileSystem.writeFileString(
      `${root}/tack.yaml`,
      "version: 1\nskills:\n  - path: skills\n",
    );
    return yield* use(root);
  }).pipe(Effect.scoped);

const recordPaths = (root: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const section = readImportsSection(yield* fileSystem.readFileString(`${root}/tack.yaml`));
    return Result.isSuccess(section) ? section.success.records.map((record) => record.path) : [];
  });

const exists = (target: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.exists(target));

/** Writes an intent by hand, the way an interrupted write leaves it. */
const leaveIntent = (
  root: string,
  operation: "add" | "remove",
  items: ReadonlyArray<{
    readonly path: string;
    readonly record: ImportRecord;
    readonly newFolders?: ReadonlyArray<string>;
  }>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const staging = stagingPathOf(root);
    yield* fileSystem.makeDirectory(staging, { recursive: true });
    yield* fileSystem.writeFileString(
      `${staging}/intent.json`,
      JSON.stringify({
        version: 1,
        operation,
        items: items.map((item, index) => ({ index, newFolders: [], ...item })),
      }),
    );
  });

it.layer(LiveTestLayer)("import writes", (test) => {
  test.effect("a leftover staging folder refuses a new write before anything moves", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(stagingPathOf(root));
        // The refusal asks for a rerun to recover, so it must keep the interrupted write's intent.
        const intent = `${stagingPathOf(root)}/intent.json`;
        yield* fileSystem.writeFileString(intent, "{}");
        const error = yield* writeImports(root, [staged("pdf")]).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-staging-conflict" });
        expect(error.message).toContain("--apply");
        expect(yield* exists(intent)).toBe(true);
        expect(yield* exists(`${root}/skills/pdf`)).toBe(false);
        expect(yield* recordPaths(root)).toEqual([]);
      }),
    ),
  );

  test.effect("a staged copy that does not match its record changes nothing", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const item = staged("pdf", ["skills/team"]);
        const error = yield* writeImports(root, [
          { ...item, record: { ...item.record, files: recordOf("other").files } },
        ]).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-write-failed" });
        expect(error.message).toContain("staged copy of pdf does not match");
        expect(yield* exists(stagingPathOf(root))).toBe(false);
        expect(yield* exists(`${root}/skills/team`)).toBe(false);
        expect(yield* recordPaths(root)).toEqual([]);
      }),
    ),
  );

  test.effect("a file path that leaves the skill folder is refused", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const item = staged("pdf");
        const error = yield* writeImports(root, [
          {
            ...item,
            files: [
              ...item.files,
              { path: "../escape.md", bytes: new Uint8Array(), executable: false },
            ],
          },
        ]).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-write-failed" });
        expect(error.message).toContain('Refusing to write "../escape.md"');
        expect(yield* exists(`${root}/skills/escape.md`)).toBe(false);
        expect(yield* exists(stagingPathOf(root))).toBe(false);
      }),
    ),
  );

  test.effect("a destination that appeared while the import ran is never overwritten", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(`${root}/skills/pdf`);
        yield* fileSystem.writeFileString(`${root}/skills/pdf/mine.md`, "mine\n");
        const error = yield* writeImports(root, [staged("pdf")]).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-write-failed" });
        expect(error.message).toBe(
          "skills/pdf appeared while the import ran. Nothing was overwritten.",
        );
        expect(yield* fileSystem.readDirectory(`${root}/skills/pdf`)).toEqual(["mine.md"]);
        expect(yield* exists(stagingPathOf(root))).toBe(false);
      }),
    ),
  );

  test.effect(
    "a move that fails after another moved leaves the intent, and recovery settles both",
    () =>
      withRoot((root) =>
        Effect.gen(function* () {
          // A dangling link reads as absent but cannot be replaced by a folder.
          yield* Effect.promise(() => symlink("nowhere", `${root}/skills/docx`));
          const error = yield* writeImports(root, [staged("pdf"), staged("docx")]).pipe(
            Effect.flip,
          );
          expect(error).toMatchObject({ code: "import-write-failed" });
          expect(error.message).toContain(
            "could not move the staged copy of docx into skills/docx",
          );
          expect(yield* exists(`${root}/skills/pdf/SKILL.md`)).toBe(true);
          expect(yield* exists(`${stagingPathOf(root)}/intent.json`)).toBe(true);
          expect(yield* recordPaths(root)).toEqual([]);

          expect(yield* recoverStaging(root)).toEqual([
            "Finished the interrupted import of skills/pdf.",
            "Rolled back the interrupted import of skills/docx.",
          ]);
          expect(yield* recordPaths(root)).toEqual(["skills/pdf"]);
          expect(yield* exists(stagingPathOf(root))).toBe(false);
        }),
      ),
  );

  test.effect("an unreadable tack.yaml fails the write after the move and keeps the intent", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.remove(`${root}/tack.yaml`);
        const error = yield* writeImports(root, [staged("pdf")]).pipe(Effect.flip);
        expect(error).toMatchObject({
          code: "import-write-failed",
          message: `Tack could not read ${root}/tack.yaml.`,
        });
        expect(yield* exists(`${root}/skills/pdf/SKILL.md`)).toBe(true);
        expect(yield* exists(`${stagingPathOf(root)}/intent.json`)).toBe(true);
      }),
    ),
  );

  test.effect("an invalid imports section fails the write with its line", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(
          `${root}/tack.yaml`,
          "version: 1\nskills:\n  - path: skills\nimports: nonsense\n",
        );
        const error = yield* writeImports(root, [staged("pdf")]).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-records-invalid" });
        expect(error.message).toContain(`The imports section of ${root}/tack.yaml (line `);
      }),
    ),
  );

  test.effect("an edit that would break an alias elsewhere in tack.yaml fails the write", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* writeImports(root, [staged("docx")]);
        // Another key aliases a value inside the section, which a rewrite would remove.
        const original = `${(yield* fileSystem.readFileString(`${root}/tack.yaml`)).replace(
          "location: github:acme/skills",
          "location: &origin github:acme/skills",
        )}notes: *origin\n`;
        yield* fileSystem.writeFileString(`${root}/tack.yaml`, original);
        const error = yield* writeImports(root, [staged("pdf")]).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-records-invalid" });
        expect(error.message).toContain("(line 1): tack.yaml does not parse as YAML");
        expect(yield* fileSystem.readFileString(`${root}/tack.yaml`)).toBe(original);
      }),
    ),
  );

  test.effect("the crash test hook kills the process at the step it names", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const signals: Array<unknown> = [];
        const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          signals.push([pid, signal]);
          return true;
        });
        vi.stubEnv(crashAtVariable, "staged");
        const written = yield* writeImports(root, [staged("pdf")]).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              vi.unstubAllEnvs();
              kill.mockRestore();
            }),
          ),
        );
        expect(written).toEqual(["skills/pdf"]);
        expect(signals).toEqual([[process.pid, "SIGKILL"]]);
      }),
    ),
  );
});

it.layer(LiveTestLayer)("import removals", (test) => {
  test.effect("a record whose folder is gone drops alone, without a staging folder", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* writeImports(root, [staged("pdf")]);
        yield* fileSystem.remove(`${root}/skills/pdf`, { recursive: true });
        expect(
          yield* removeImports(root, [
            { path: "skills/pdf", record: recordOf("pdf"), folderPresent: false },
          ]),
        ).toEqual(["skills/pdf"]);
        expect(yield* recordPaths(root)).toEqual([]);
      }),
    ),
  );

  test.effect("a leftover staging folder refuses a removal and deletes nothing", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* writeImports(root, [staged("pdf")]);
        yield* fileSystem.makeDirectory(stagingPathOf(root));
        const error = yield* removeImports(root, [
          { path: "skills/pdf", record: recordOf("pdf"), folderPresent: true },
        ]).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-staging-conflict" });
        expect(yield* exists(`${root}/skills/pdf/SKILL.md`)).toBe(true);
        expect(yield* recordPaths(root)).toEqual(["skills/pdf"]);
      }),
    ),
  );

  test.effect("a folder that cannot be moved into staging is not deleted", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        yield* writeImports(root, [staged("pdf")]);
        const error = yield* removeImports(root, [
          { path: "skills/missing", record: recordOf("missing"), folderPresent: true },
        ]).pipe(Effect.flip);
        expect(error).toMatchObject({
          code: "import-write-failed",
          message:
            "Tack could not move skills/missing into the staging folder. Nothing was deleted.",
        });
        expect(yield* recordPaths(root)).toEqual(["skills/pdf"]);
      }),
    ),
  );
});

it.layer(LiveTestLayer)("import recovery", (test) => {
  test.effect("a root without a staging folder has nothing to settle", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        expect(yield* recoverStaging(root)).toEqual([]);
      }),
    ),
  );

  test.effect("a staging folder without a usable intent is scratch and is removed", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const staging = stagingPathOf(root);
        yield* fileSystem.makeDirectory(`${staging}/new/0`, { recursive: true });
        const scratch = [
          "Removed the staging folder of an interrupted write that had not changed anything.",
        ];
        expect(yield* recoverStaging(root)).toEqual(scratch);
        expect(yield* exists(staging)).toBe(false);
        yield* fileSystem.makeDirectory(staging);
        yield* fileSystem.writeFileString(`${staging}/intent.json`, '{"version":99}');
        expect(yield* recoverStaging(root)).toEqual(scratch);
        expect(yield* exists(staging)).toBe(false);
      }),
    ),
  );

  test.effect(
    "an interrupted import whose folder changed is rolled back with its new folders",
    () =>
      withRoot((root) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const item = staged("pdf", ["skills/team"]);
          yield* fileSystem.makeDirectory(path.join(root, "skills/team"));
          yield* fileSystem.makeDirectory(path.join(root, "skills/empty"));
          yield* leaveIntent(root, "add", [
            { path: "skills/team/pdf", record: item.record, newFolders: ["skills/team"] },
            {
              path: "skills/empty/docx",
              record: recordOf("docx", "skills/empty"),
              newFolders: ["skills/empty"],
            },
          ]);
          yield* fileSystem.makeDirectory(path.join(root, "skills/team/pdf"));
          yield* fileSystem.writeFileString(
            path.join(root, "skills/team/pdf/SKILL.md"),
            "edited\n",
          );
          expect(yield* recoverStaging(root)).toEqual([
            "Rolled back the interrupted import of skills/team/pdf.",
            "Rolled back the interrupted import of skills/empty/docx.",
          ]);
          // A non-empty group folder stays; an empty one the import created goes.
          expect(yield* exists(path.join(root, "skills/team/pdf/SKILL.md"))).toBe(true);
          expect(yield* exists(path.join(root, "skills/empty"))).toBe(false);
          expect(yield* recordPaths(root)).toEqual([]);
          expect(yield* exists(stagingPathOf(root))).toBe(false);
        }),
      ),
  );

  test.effect(
    "an interrupted removal finishes a moved or vanished folder and rolls back the rest",
    () =>
      withRoot((root) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* writeImports(root, [staged("pdf"), staged("docx"), staged("xlsx")]);
          yield* leaveIntent(root, "remove", [
            { path: "skills/pdf", record: recordOf("pdf") },
            { path: "skills/docx", record: recordOf("docx") },
            { path: "skills/xlsx", record: recordOf("xlsx") },
          ]);
          // pdf reached staging, docx vanished by hand, xlsx was never moved.
          yield* fileSystem.makeDirectory(`${stagingPathOf(root)}/old`);
          yield* fileSystem.rename(`${root}/skills/pdf`, `${stagingPathOf(root)}/old/0`);
          yield* fileSystem.remove(`${root}/skills/docx`, { recursive: true });
          expect(yield* recoverStaging(root)).toEqual([
            "Finished the interrupted removal of skills/pdf.",
            "Finished the interrupted removal of skills/docx.",
            "Rolled back the interrupted removal of skills/xlsx.",
          ]);
          expect(yield* recordPaths(root)).toEqual(["skills/xlsx"]);
          expect(yield* exists(`${root}/skills/xlsx/SKILL.md`)).toBe(true);
          expect(yield* exists(stagingPathOf(root))).toBe(false);
        }),
      ),
  );
});

it("text bytes exclude NUL and invalid UTF-8", () => {
  expect(isTextBytes(encoder.encode("plain\n"))).toBe(true);
  expect(isTextBytes(Uint8Array.of(0x61, 0x00))).toBe(false);
  expect(isTextBytes(Uint8Array.of(0xc3, 0x28))).toBe(false);
});
