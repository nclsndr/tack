import { declare, skillText } from "../../../test/support/source-tree.ts";
import { resolveCatalogAt } from "../../../test/support/snapshot-helpers.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Result } from "effect";
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
import { inspectImports } from "./import-inspect.ts";
import { removeImport } from "./import-removal.ts";
import { readImportsSection } from "./imports-section.ts";

/**
 * Copies a candidate into the destination by hand and reports whether the real catalog loads it
 * as a skill of that folder with no new quarantine, and the code of the first new quarantine.
 */
const manualCopy = (
  world: ImportWorld,
  folder: string,
  name: string,
  files: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const own = <T extends { readonly sourcePath: string }>(items: ReadonlyArray<T>) =>
      items.filter((item) => item.sourcePath === world.root);
    const before = yield* resolveCatalogAt(world.options);
    for (const [relative, content] of Object.entries(files)) {
      const target = `${world.root}/${folder}/${name}/${relative}`;
      yield* fileSystem.makeDirectory(target.split("/").slice(0, -1).join("/"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(target, content);
    }
    const after = yield* resolveCatalogAt(world.options);
    const loaded = own(after.entries).filter(
      (entry) =>
        entry.address.kind === "skill" && entry.directoryPath === `${world.root}/${folder}/${name}`,
    );
    const fresh = own(after.quarantined).filter(
      (item) =>
        before.quarantined.some((old) => JSON.stringify(old) === JSON.stringify(item)) === false,
    );
    return {
      accepted:
        loaded.length === 1 && own(after.quarantined).length === own(before.quarantined).length,
      newCode: fresh[0]?.code,
      skills: own(after.entries)
        .filter((entry) => entry.address.kind === "skill")
        .map((entry) => entry.address.name)
        .sort(),
    };
  });

const verdictOf = (world: ImportWorld, name: string, into = "personal-brain") =>
  previewImport(world.options, importRequest({ into })).pipe(
    Effect.map((plan) => plan.candidates.find((candidate) => candidate.name === name)),
  );

const pdfCommit = { files: { "skills/pdf/SKILL.md": skillText("pdf") } } as const;
const pdfFiles = { "SKILL.md": skillText("pdf") };

it.layer(LiveTestLayer)("import verdicts equal the destination's catalog", (test) => {
  test.effect("a skill of that name in a group folder blocks, naming the folder", () =>
    withImportWorld(
      {
        declaration: declare("skills: [{ path: skills }]"),
        files: { "skills/00_effect/pdf/SKILL.md": skillText("pdf") },
        commits: [pdfCommit],
      },
      (world) =>
        Effect.gen(function* () {
          const candidate = yield* verdictOf(world, "pdf");
          expect(candidate?.verdict).toMatchObject({
            importable: false,
            code: "import-name-in-destination",
          });
          expect(candidate?.verdict.importable === false && candidate.verdict.message).toContain(
            "skills/00_effect/pdf",
          );
          const copied = yield* manualCopy(world, "skills", "pdf", pdfFiles);
          expect(copied.accepted).toBe(false);
          expect(copied.newCode).toBe("skill-address-duplicate");
        }),
    ),
  );

  test.effect("a skill of that name in another declared folder blocks too", () =>
    withImportWorld(
      {
        declaration: declare("skills:", "  - path: skills", "  - path: vendor/skills"),
        files: {
          "vendor/skills/pdf/SKILL.md": skillText("pdf"),
          "skills/a/SKILL.md": skillText("a"),
        },
        commits: [pdfCommit],
      },
      (world) =>
        Effect.gen(function* () {
          const candidate = yield* verdictOf(world, "pdf", "personal-brain:skills");
          expect(candidate?.verdict).toMatchObject({ code: "import-name-in-destination" });
          expect((yield* manualCopy(world, "skills", "pdf", pdfFiles)).accepted).toBe(false);
        }),
    ),
  );

  test.effect("a quarantined skill of that name still blocks", () =>
    withImportWorld(
      {
        declaration: declare("skills: [{ path: skills }]"),
        // The folder name and the frontmatter name disagree, so the catalog quarantines it.
        files: { "skills/pdf/SKILL.md": skillText("other") },
        commits: [pdfCommit],
      },
      (world) =>
        Effect.gen(function* () {
          const candidate = yield* verdictOf(world, "pdf");
          expect(candidate?.verdict).toMatchObject({ code: "import-name-in-destination" });
        }),
    ),
  );

  test.effect("a same-name folder excluded by a pattern does not block", () =>
    withImportWorld(
      {
        declaration: declare("skills:", "  - path: skills", '    exclude: ["**/_*/**"]'),
        files: {
          "skills/_archive/pdf/SKILL.md": skillText("pdf"),
          "skills/a/SKILL.md": skillText("a"),
        },
        commits: [pdfCommit],
      },
      (world) =>
        Effect.gen(function* () {
          const candidate = yield* verdictOf(world, "pdf");
          expect(candidate?.verdict).toEqual({ importable: true });
          const copied = yield* manualCopy(world, "skills", "pdf", pdfFiles);
          expect(copied.accepted).toBe(true);
        }),
    ),
  );

  test.effect("an existing path that is not a skill is refused", () =>
    withImportWorld(
      {
        declaration: declare("skills: [{ path: skills }]"),
        files: { "skills/pdf/notes.txt": "not a skill\n" },
        commits: [pdfCommit],
      },
      (world) =>
        Effect.gen(function* () {
          const candidate = yield* verdictOf(world, "pdf");
          expect(candidate?.verdict).toMatchObject({ code: "import-path-exists" });
        }),
    ),
  );

  test.effect("a new path the declaration's include patterns do not select is refused", () =>
    withImportWorld(
      {
        declaration: declare("skills:", "  - path: skills", '    include: ["allowed-*"]'),
        files: { "skills/allowed-one/SKILL.md": skillText("allowed-one") },
        commits: [pdfCommit],
      },
      (world) =>
        Effect.gen(function* () {
          const candidate = yield* verdictOf(world, "pdf");
          expect(candidate?.verdict).toMatchObject({ code: "import-folder-not-selected" });
          const copied = yield* manualCopy(world, "skills", "pdf", pdfFiles);
          expect(copied.accepted).toBe(false);
        }),
    ),
  );

  test.effect("a name present in another registered source is importable", () =>
    withImportWorld(
      {
        declaration: declare("skills: [{ path: skills }]"),
        files: { "skills/a/SKILL.md": skillText("a") },
        commits: [pdfCommit],
      },
      (world) =>
        Effect.gen(function* () {
          yield* addSource(world, "acme-src", declare("skills: [{ path: skills }]"), {
            "skills/pdf/SKILL.md": skillText("pdf"),
          });
          const candidate = yield* verdictOf(world, "pdf");
          expect(candidate?.verdict).toEqual({ importable: true });
          expect((yield* manualCopy(world, "skills", "pdf", pdfFiles)).accepted).toBe(true);
        }),
    ),
  );

  test.effect("a nested SKILL.md is content: importable and one skill in the catalog", () =>
    withImportWorld(
      {
        declaration: declare("skills: [{ path: skills }]"),
        files: { "skills/a/SKILL.md": skillText("a") },
        commits: [
          {
            files: {
              "skills/creator/SKILL.md": skillText("creator"),
              "skills/creator/templates/example/SKILL.md": skillText("example"),
            },
          },
        ],
      },
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["creator"] }),
          );
          const creator = plan.candidates.find((candidate) => candidate.name === "creator");
          expect(creator?.verdict).toEqual({ importable: true });
          expect(creator?.nestedSkills).toEqual(["templates/example"]);
          // The nested folder is under the leaf rule, so discovery lists only the outer skill.
          expect(plan.candidates.map((candidate) => candidate.name)).toEqual(["creator"]);
          yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["creator"] }),
          );
          const catalog = yield* resolveCatalogAt(world.options);
          const skills = catalog.entries
            .filter((entry) => entry.sourcePath === world.root && entry.address.kind === "skill")
            .map((entry) => entry.address.name)
            .sort();
          expect(skills).toEqual(["a", "creator"]);
          expect(
            yield* fileSystem.exists(`${world.root}/skills/creator/templates/example/SKILL.md`),
          ).toBe(true);
        }),
    ),
  );

  test.effect("catalog reasons: an invalid name and a non-string metadata value", () =>
    withImportWorld(
      {
        declaration: declare("skills: [{ path: skills }]"),
        files: { "skills/a/SKILL.md": skillText("a") },
        commits: [
          {
            files: {
              "skills/bad/SKILL.md": skillText("Bad Name"),
              "skills/notes/SKILL.md":
                "---\nname: notes\ndescription: n\nmetadata:\n  count: 3\n---\n",
              "skills/pdf/SKILL.md": skillText("pdf"),
            },
          },
        ],
      },
      (world) =>
        Effect.gen(function* () {
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          );
          const bad = plan.candidates.find((candidate) => candidate.folder === "skills/bad");
          const notes = plan.candidates.find((candidate) => candidate.name === "notes");
          expect(bad?.verdict).toMatchObject({ importable: false });
          expect(notes?.verdict).toMatchObject({ importable: false });
          const badCopy = yield* manualCopy(world, "skills", "bad", {
            "SKILL.md": skillText("Bad Name"),
          });
          expect(badCopy.accepted).toBe(false);
          expect(bad?.verdict.importable === false && bad.verdict.code).toBe(badCopy.newCode);
          const notesCopy = yield* manualCopy(world, "skills", "notes", {
            "SKILL.md": "---\nname: notes\ndescription: n\nmetadata:\n  count: 3\n---\n",
          });
          expect(notesCopy.accepted).toBe(false);
          expect(notes?.verdict.importable === false && notes.verdict.code).toBe(notesCopy.newCode);
          // A candidate that is not importable cannot be selected.
          const error = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["notes"] }),
          ).pipe(Effect.flip);
          expect(error).toMatchObject({ code: "import-candidate-not-importable" });
        }),
    ),
  );

  test.effect("an upstream folder named differently lands under the skill's own name", () =>
    withImportWorld(
      {
        declaration: declare("skills: [{ path: skills }]"),
        files: { "skills/a/SKILL.md": skillText("a") },
        commits: [{ files: { "skills/pdf-tools/SKILL.md": skillText("pdf") } }],
      },
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          );
          expect(plan.candidates).toMatchObject([{ name: "pdf", folder: "skills/pdf-tools" }]);
          expect(plan.writes).toMatchObject([
            { path: "skills/pdf", upstreamPath: "skills/pdf-tools" },
          ]);
          yield* applyImport(world.options, importRequest({ into: "personal-brain" }));
          expect(yield* fileSystem.exists(`${world.root}/skills/pdf/SKILL.md`)).toBe(true);
          const section = readImportsSection(
            yield* fileSystem.readFileString(`${world.root}/tack.yaml`),
          );
          expect(Result.isSuccess(section) && section.success.records[0]?.["upstream-path"]).toBe(
            "skills/pdf-tools",
          );
        }),
    ),
  );

  test.effect("duplicate names inside the location are all reported and none is importable", () =>
    withImportWorld(
      {
        declaration: declare("skills: [{ path: skills }]"),
        files: { "skills/a/SKILL.md": skillText("a") },
        commits: [
          {
            files: {
              "skills/one/pdf/SKILL.md": skillText("pdf"),
              "skills/two/pdf/SKILL.md": skillText("pdf"),
              "skills/docx/SKILL.md": skillText("docx"),
            },
          },
        ],
      },
      (world) =>
        Effect.gen(function* () {
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          );
          const pdfs = plan.candidates.filter((candidate) => candidate.name === "pdf");
          expect(pdfs).toHaveLength(2);
          for (const pdf of pdfs) {
            expect(pdf.verdict).toMatchObject({ importable: false, code: "import-name-duplicate" });
          }
          expect(plan.candidates.find((candidate) => candidate.name === "docx")?.verdict).toEqual({
            importable: true,
          });
        }),
    ),
  );

  test.effect("internal skills are hidden unless named, and _ folders are not candidates", () =>
    withImportWorld(
      {
        declaration: declare("skills: [{ path: skills }]"),
        files: { "skills/a/SKILL.md": skillText("a") },
        commits: [
          {
            files: {
              "skills/pdf/SKILL.md": skillText("pdf"),
              "skills/secret/SKILL.md": skillText("secret", {
                frontmatter: 'metadata:\n  internal: "true"\n',
              }),
              "skills/_wip/draft/SKILL.md": skillText("draft"),
            },
          },
        ],
      },
      (world) =>
        Effect.gen(function* () {
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          );
          expect(plan.candidates.map((candidate) => candidate.name)).toEqual(["pdf"]);
          expect(plan.hiddenInternal).toBe(1);
          const named = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["secret"] }),
          );
          expect(named.selected).toEqual(["secret"]);
        }),
    ),
  );

  test.effect("upstream Tack metadata is surfaced and the reach follows it", () =>
    withImportWorld(
      {
        declaration: declare("skills: [{ path: skills }]"),
        files: { "skills/a/SKILL.md": skillText("a") },
        commits: [
          {
            files: {
              "skills/pdf/SKILL.md": skillText("pdf", {
                tack: [
                  "activation: opt-in",
                  "user-activation: default",
                  "projects: [alpha]",
                  "dependencies:",
                  "  - kind: skill",
                  "    name: helper",
                  "    source: elsewhere",
                ],
              }),
            },
          },
        ],
      },
      (world) =>
        Effect.gen(function* () {
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["pdf"] }),
          );
          expect(plan.candidates[0]?.upstreamTack).toEqual({
            activation: "opt-in",
            userActivation: "default",
            projects: ["alpha"],
            dependencies: [{ kind: "skill", name: "helper", source: "elsewhere" }],
          });
          expect(plan.reach).toMatchObject([
            {
              name: "pdf",
              user: { receives: false },
              undeclaredDependencies: ["elsewhere:helper"],
            },
          ]);
        }),
    ),
  );
});

it.layer(LiveTestLayer)("import verdicts from earlier imports", (test) => {
  const twoRevisions = [
    { files: { "skills/pdf/SKILL.md": skillText("pdf") }, tag: "v1" },
    { files: { "skills/pdf/extra.md": "more\n" } },
  ] as const;

  test.effect(
    "same location: unchanged revision says nothing to do, a moved one names remove",
    () =>
      withImportWorld(
        {
          declaration: declare("skills: [{ path: skills }]"),
          files: { "skills/a/SKILL.md": skillText("a") },
          commits: twoRevisions,
        },
        (world) =>
          Effect.gen(function* () {
            yield* applyImport(
              world.options,
              importRequest({
                location: "github:acme/skills#v1",
                into: "personal-brain",
                skills: ["pdf"],
              }),
            );
            const same = (yield* previewImport(
              world.options,
              importRequest({ location: "github:acme/skills#v1", into: "personal-brain" }),
            )).candidates[0]?.verdict;
            expect(same).toMatchObject({ code: "import-already-imported" });
            expect(same?.importable === false && same.message).toContain("Nothing to do");
            const moved = yield* previewImport(
              world.options,
              importRequest({ location: "github:acme/skills", into: "personal-brain" }),
            );
            const verdict = moved.candidates[0]?.verdict;
            expect(verdict).toMatchObject({ code: "import-already-imported" });
            expect(verdict?.importable === false && verdict.message).toContain(
              "tack import remove",
            );
            // Naming the moved skill fails with the remove command as data beside the message.
            const refused = yield* applyImport(
              world.options,
              importRequest({
                location: "github:acme/skills",
                into: "personal-brain",
                skills: ["pdf"],
              }),
            ).pipe(Effect.flip);
            expect(refused).toMatchObject({
              code: "import-candidate-not-importable",
              next: [["tack", "import", "remove", "personal-brain:pdf", "--apply"]],
            });
            // Applying again changes nothing and fails with the reason.
            const before = yield* snapshotTree(world.root);
            const error = yield* applyImport(
              world.options,
              importRequest({ into: "personal-brain" }),
            ).pipe(Effect.flip);
            expect(error).toMatchObject({ code: "import-no-candidates" });
            expect(changedPaths(before, yield* snapshotTree(world.root))).toEqual([]);
          }),
      ),
  );

  /** Applies the first revision, then rewrites the record's location in the destination's tack.yaml. */
  const withRewrittenRecord = <A, E, R>(
    location: string,
    use: (world: ImportWorld) => Effect.Effect<A, E, R>,
  ) =>
    withImportWorld(
      {
        declaration: declare("skills: [{ path: skills }]"),
        files: { "skills/a/SKILL.md": skillText("a") },
        commits: twoRevisions,
      },
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* applyImport(
            world.options,
            importRequest({
              location: "github:acme/skills#v1",
              into: "personal-brain",
              skills: ["pdf"],
            }),
          );
          const yamlPath = path.join(world.root, "tack.yaml");
          yield* fileSystem.writeFileString(
            yamlPath,
            (yield* fileSystem.readFileString(yamlPath)).replace("github:acme/skills", location),
          );
          return yield* use(world);
        }),
    );

  test.effect("the same repository in another casing, or with .git, is already imported", () =>
    Effect.forEach(
      ["github:Acme/Skills", "github:ACME/SKILLS.git", "github:acme/skills.git"],
      (recorded) =>
        withRewrittenRecord(recorded, (world) =>
          verdictOf(world, "pdf").pipe(
            Effect.tap((candidate) =>
              Effect.sync(() =>
                expect(candidate?.verdict, recorded).toMatchObject({
                  code: "import-already-imported",
                }),
              ),
            ),
          ),
        ),
    ),
  );

  test.effect(
    "a record from a provider this release lacks keeps import working and is another location",
    () =>
      withRewrittenRecord("forge:acme/skills", (world) =>
        Effect.gen(function* () {
          // The record decodes by shape, so the section reads and lists.
          const list = yield* inspectImports(yield* readState(world.options));
          expect(list.imports.map((entry) => [entry.name, entry.location])).toEqual([
            ["pdf", "forge:acme/skills"],
          ]);
          // A provider's identity is its own: another provider's location is never the same.
          const candidate = yield* verdictOf(world, "pdf");
          expect(candidate?.verdict).toMatchObject({ code: "import-imported-elsewhere" });
          expect(candidate?.verdict.importable === false && candidate.verdict.message).toContain(
            "forge:acme/skills",
          );
          // It can still be removed: removal needs no provider.
          const { applied } = yield* removeImport(world.options, "personal-brain:pdf", false);
          expect(applied.removed).toEqual(["skills/pdf/", "tack.yaml"]);
        }),
      ),
  );

  test.effect("another location's record names that location", () =>
    withImportWorld(
      {
        declaration: declare("skills: [{ path: skills }]"),
        files: { "skills/a/SKILL.md": skillText("a") },
        commits: twoRevisions,
      },
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* applyImport(
            world.options,
            importRequest({
              location: "github:acme/skills#v1",
              into: "personal-brain",
              skills: ["pdf"],
            }),
          );
          const yamlPath = path.join(world.root, "tack.yaml");
          yield* fileSystem.writeFileString(
            yamlPath,
            (yield* fileSystem.readFileString(yamlPath)).replace(
              "github:acme/skills",
              "github:other/repo",
            ),
          );
          const candidate = yield* verdictOf(world, "pdf");
          expect(candidate?.verdict).toMatchObject({ code: "import-imported-elsewhere" });
          expect(candidate?.verdict.importable === false && candidate.verdict.message).toContain(
            "github:other/repo",
          );
        }),
    ),
  );
});
