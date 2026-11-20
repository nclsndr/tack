import { declare, skillText } from "../../../test/support/source-tree.ts";
import { resolveCatalog } from "../../../test/support/snapshot-helpers.ts";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Result } from "effect";
import { vi } from "vitest";
import { chmod, cp, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import {
  addSource,
  changedPaths,
  importRequest,
  snapshotTree,
  withImportWorld,
  type ImportWorld,
} from "../../../test/support/import-world.ts";
import { mutateStateEffect, readState } from "../../services/state-store.ts";

import { agentLink } from "../../domain/links/link-record-schema.ts";
import { registerSource } from "../sources/source.ts";
import { applyImport } from "./import.ts";
import { inspectImports } from "./import-inspect.ts";
import { planImportRemoval, removeImport } from "./import-removal.ts";
import { readImportsSection } from "./imports-section.ts";
import { stagingPathOf } from "./import-write.ts";
import { crashAtVariable } from "../../services/installation.ts";

const commit = {
  files: {
    "skills/pdf/SKILL.md": skillText("pdf"),
    "skills/pdf/scripts/fill.py": { content: "print('x')\n", executable: true },
    "skills/docx/SKILL.md": skillText("docx"),
  },
} as const;
const declaration = declare("skills: [{ path: skills }]");
const files = { "skills/a/SKILL.md": skillText("a"), "notes/keep.txt": "keep\n" };

const importPdf = (world: ImportWorld) =>
  applyImport(world.options, importRequest({ into: "personal-brain", skills: ["pdf"] }));

const localOf = (world: ImportWorld, reference: string) =>
  Effect.gen(function* () {
    const list = yield* inspectImports(yield* readState(world.options));
    return list.imports.find((entry) => entry.reference === reference);
  });

const recordCount = (world: ImportWorld) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const section = readImportsSection(yield* fileSystem.readFileString(`${world.root}/tack.yaml`));
    return Result.isSuccess(section) ? section.success.records.length : -1;
  });

it.layer(LiveTestLayer)("import local change", (test) => {
  test.effect("a fresh copy reads as unchanged, ignoring operating-system files", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        yield* importPdf(world);
        expect((yield* localOf(world, "personal-brain:pdf"))?.local.state).toBe("unchanged");
        yield* Effect.promise(() => writeFile(`${world.root}/skills/pdf/.DS_Store`, "junk"));
        yield* Effect.promise(() =>
          writeFile(`${world.root}/skills/pdf/scripts/Thumbs.db`, "junk"),
        );
        expect((yield* localOf(world, "personal-brain:pdf"))?.local.state).toBe("unchanged");
        // A byte-for-byte copy of the whole source, registered as another source, reads the same.
        const copy = `${world.base}/personal-brain-copy`;
        yield* Effect.promise(() => cp(world.root, copy, { recursive: true }));
        yield* registerSource(world.options, { sourcePath: copy });
        const list = yield* inspectImports(yield* readState(world.options));
        expect(list.imports.map((entry) => [entry.reference, entry.local.state])).toEqual([
          ["personal-brain-copy:pdf", "unchanged"],
          ["personal-brain:pdf", "unchanged"],
        ]);
      }),
    ),
  );

  test.effect(
    "an edit, an added and a deleted file, a mode flip and a symlink each change it",
    () =>
      withImportWorld({ declaration, files, commits: [commit] }, (world) =>
        Effect.gen(function* () {
          yield* importPdf(world);
          const folder = `${world.root}/skills/pdf`;
          yield* Effect.promise(async () => {
            await writeFile(`${folder}/SKILL.md`, `${skillText("pdf")}edited\n`);
            await writeFile(`${folder}/notes.md`, "mine\n");
            await unlink(`${folder}/scripts/fill.py`);
            await symlink("SKILL.md", `${folder}/link`);
          });
          const local = (yield* localOf(world, "personal-brain:pdf"))?.local;
          expect(local).toMatchObject({
            state: "changed",
            added: ["notes.md"],
            removed: ["scripts/fill.py"],
            changed: ["SKILL.md"],
            special: ["link"],
          });
          yield* Effect.promise(async () => {
            await writeFile(`${folder}/scripts/fill.py`, "print('x')\n");
            await chmod(`${folder}/scripts/fill.py`, 0o644);
          });
          expect((yield* localOf(world, "personal-brain:pdf"))?.local.executable).toEqual([
            "scripts/fill.py",
          ]);
          expect(
            (yield* localOf(world, "personal-brain:pdf"))?.conditions.map((entry) => entry.code),
          ).toContain("import-locally-changed");
        }),
      ),
  );
});

it.layer(LiveTestLayer)("import remove", (test) => {
  test.effect("refuses a locally changed folder without force, listing the change", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        yield* importPdf(world);
        yield* Effect.promise(() => writeFile(`${world.root}/skills/pdf/SKILL.md`, "edited\n"));
        const before = yield* snapshotTree(world.root);
        const preview = yield* planImportRemoval(world.options, "personal-brain:pdf", false).pipe(
          Effect.flip,
        );
        expect(preview).toMatchObject({ code: "import-removal-blocked" });
        expect(preview.message).toContain("SKILL.md changed");
        const apply = yield* removeImport(world.options, "personal-brain:pdf", false).pipe(
          Effect.flip,
        );
        expect(apply).toMatchObject({ code: "import-removal-blocked" });
        expect(changedPaths(before, yield* snapshotTree(world.root))).toEqual([]);
      }),
    ),
  );

  test.effect("--force lists every lost change, then deletes the folder and the record", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* importPdf(world);
        yield* Effect.promise(async () => {
          await writeFile(`${world.root}/skills/pdf/SKILL.md`, "edited\n");
          await writeFile(`${world.root}/skills/pdf/new.md`, "n\n");
        });
        const plan = yield* planImportRemoval(world.options, "pdf", true);
        expect(plan).toMatchObject({
          force: true,
          folderPresent: true,
          files: 2,
          local: { state: "changed", added: ["new.md"], changed: ["SKILL.md"] },
        });
        const stateBefore = yield* fileSystem.readFileString(world.statePath);
        const { applied } = yield* removeImport(world.options, "pdf", true);
        expect(applied.removed).toEqual(["skills/pdf/", "tack.yaml"]);
        expect(yield* fileSystem.exists(`${world.root}/skills/pdf`)).toBe(false);
        expect(yield* fileSystem.exists(`${world.root}/.tack-import-staging`)).toBe(false);
        expect(yield* recordCount(world)).toBe(0);
        // The section and its comment are gone; the authored declaration remains.
        expect(yield* fileSystem.readFileString(`${world.root}/tack.yaml`)).not.toContain(
          "imports",
        );
        expect(yield* fileSystem.readFileString(world.statePath)).toBe(stateBefore);
        const catalog = yield* resolveCatalog(world.options);
        expect(
          catalog.entries.some(
            (entry) => entry.sourcePath === world.root && entry.address.name === "pdf",
          ),
        ).toBe(false);
      }),
    ),
  );

  test.effect("an unchanged folder removes without force and touches nothing else", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        yield* applyImport(world.options, importRequest({ into: "personal-brain", all: true }));
        const before = yield* snapshotTree(world.root);
        yield* removeImport(world.options, "personal-brain:pdf", false);
        const changed = changedPaths(before, yield* snapshotTree(world.root));
        expect(changed.every((path) => path === "tack.yaml" || path.startsWith("skills/pdf"))).toBe(
          true,
        );
        expect(yield* recordCount(world)).toBe(1);
        expect((yield* localOf(world, "personal-brain:docx"))?.local.state).toBe("unchanged");
      }),
    ),
  );

  test.effect("an unknown reference fails listing what is imported", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        yield* importPdf(world);
        const error = yield* planImportRemoval(world.options, "nope", false).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-not-found" });
        expect(error.message).toContain("personal-brain:pdf");
      }),
    ),
  );

  test.effect("a record whose folder is gone drops alone", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* importPdf(world);
        yield* fileSystem.remove(`${world.root}/skills/pdf`, { recursive: true });
        const entry = yield* localOf(world, "personal-brain:pdf");
        expect(entry?.local.state).toBe("missing");
        expect(entry?.conditions.map((condition) => condition.code)).toContain(
          "import-folder-missing",
        );
        const plan = yield* planImportRemoval(world.options, "personal-brain:pdf", false);
        expect(plan.folderPresent).toBe(false);
        const before = yield* snapshotTree(world.root);
        const { applied } = yield* removeImport(world.options, "personal-brain:pdf", false);
        expect(applied.removed).toEqual(["tack.yaml"]);
        expect(changedPaths(before, yield* snapshotTree(world.root))).toEqual(["tack.yaml"]);
        expect(yield* recordCount(world)).toBe(0);
      }),
    ),
  );

  test.effect("a hand-moved folder reads as missing while the moved one is an authored skill", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        yield* importPdf(world);
        yield* Effect.promise(async () => {
          const { mkdir } = await import("node:fs/promises");
          await mkdir(`${world.root}/skills/tools`);
          await rename(`${world.root}/skills/pdf`, `${world.root}/skills/tools/pdf`);
        });
        expect((yield* localOf(world, "personal-brain:pdf"))?.local.state).toBe("missing");
        const catalog = yield* resolveCatalog(world.options);
        expect(
          catalog.entries.some(
            (entry) =>
              entry.address.kind === "skill" &&
              entry.address.name === "pdf" &&
              entry.directoryPath === `${world.root}/skills/tools/pdf`,
          ),
        ).toBe(true);
        yield* removeImport(world.options, "personal-brain:pdf", false);
        expect(yield* recordCount(world)).toBe(0);
        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.exists(`${world.root}/skills/tools/pdf/SKILL.md`)).toBe(true);
      }),
    ),
  );

  test.effect("the plan lists where the skill is delivered and the picks that name it", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        yield* importPdf(world);
        const registrationId = (yield* readState(world.options)).data.sources[0]?.id ?? "";
        yield* mutateStateEffect(world.options, (state) =>
          Effect.succeed({
            state: {
              ...state,
              data: {
                ...state.data,
                links: [
                  agentLink({
                    adapter: "claude",
                    address: { kind: "skill", name: "pdf", sourceRegistrationId: registrationId },
                    sourceDirectoryPath: `${world.root}/skills/pdf`,
                    sourceRegistrationId: registrationId,
                    target: { _tag: "user", canonicalPath: world.base },
                  }),
                ],
                userChoices: [
                  {
                    address: { kind: "skill", name: "pdf", sourceRegistrationId: registrationId },
                    decision: "include",
                  },
                ],
              },
            },
            value: undefined,
          }),
        );
        const plan = yield* planImportRemoval(world.options, "personal-brain:pdf", false);
        expect(plan.delivered).toEqual(["user"]);
        expect(plan.picks).toEqual([{ namespace: "user", address: "include pdf" }]);
      }),
    ),
  );

  test.effect("an unknown reference with nothing imported says nothing has been imported", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const error = yield* removeImport(world.options, "pdf", false).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-not-found", details: { imported: [] } });
        expect(error.message).toContain("Nothing has been imported");
      }),
    ),
  );

  test.effect("a bare name imported into two sources asks for a qualified reference", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        yield* importPdf(world);
        yield* addSource(world, "other", declaration, { "skills/b/SKILL.md": skillText("b") });
        yield* applyImport(world.options, importRequest({ into: "other", skills: ["pdf"] }));
        const error = yield* planImportRemoval(world.options, "pdf", false).pipe(Effect.flip);
        expect(error).toMatchObject({
          code: "import-not-found",
          details: { candidates: ["other:pdf", "personal-brain:pdf"] },
        });
        expect(error.message).toBe(
          "pdf matches several imported skills. Use other:pdf or personal-brain:pdf.",
        );
        expect((yield* planImportRemoval(world.options, "other:pdf", false)).source).toBe("other");
      }),
    ),
  );

  test.effect(
    "a removal killed after rewriting tack.yaml is finished by the next one, past a source that cannot settle",
    () =>
      withImportWorld({ declaration, files, commits: [commit] }, (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* importPdf(world);
          // Another source holds an interrupted import whose records cannot be rewritten.
          const other = yield* addSource(world, "other", `${declaration}imports: nonsense\n`, {
            "skills/b/SKILL.md": skillText("b"),
          });
          yield* fileSystem.makeDirectory(stagingPathOf(other));
          yield* fileSystem.writeFileString(
            `${stagingPathOf(other)}/intent.json`,
            JSON.stringify({ version: 1, operation: "add", items: [] }),
          );
          // The crash hook ends the removal right after tack.yaml lost the record.
          const kill = vi.spyOn(process, "kill").mockImplementation(() => {
            throw new Error("killed");
          });
          vi.stubEnv(crashAtVariable, "tack-yaml");
          const killed = yield* removeImport(world.options, "personal-brain:pdf", false).pipe(
            Effect.exit,
            Effect.ensuring(
              Effect.sync(() => {
                vi.unstubAllEnvs();
                kill.mockRestore();
              }),
            ),
          );
          expect(Exit.isFailure(killed)).toBe(true);
          expect(yield* recordCount(world)).toBe(0);
          expect(yield* fileSystem.exists(stagingPathOf(world.root))).toBe(true);

          const { plan, applied } = yield* removeImport(world.options, "personal-brain:pdf", false);
          expect(plan).toBeUndefined();
          expect(applied).toEqual({
            kind: "import-removal-application",
            reference: "personal-brain:pdf",
            removed: [],
            recovered: ["Finished the interrupted removal of skills/pdf."],
          });
          expect(yield* fileSystem.exists(stagingPathOf(world.root))).toBe(false);
          expect(yield* fileSystem.exists(`${world.root}/skills/pdf`)).toBe(false);
          // The source that could not settle keeps its staging folder for a later command.
          expect(yield* fileSystem.exists(stagingPathOf(other))).toBe(true);
        }),
      ),
  );
});
