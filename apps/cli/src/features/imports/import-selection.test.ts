import { declare, skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import {
  changedPaths,
  importRequest,
  snapshotTree,
  withImportWorld,
} from "../../../test/support/import-world.ts";
import { applyImport, previewImport } from "./import.ts";

const commit = {
  files: {
    "skills/pdf/SKILL.md": skillText("pdf"),
    "skills/docx/SKILL.md": skillText("docx"),
    "skills/Bad/SKILL.md": skillText("Bad Name"),
  },
} as const;
const single = { files: { "skills/pdf/SKILL.md": skillText("pdf") } } as const;

it.layer(LiveTestLayer)("import destination folders", (test) => {
  const multi = declare(
    "skills:",
    "  - path: skills",
    '    exclude: ["**/_*/**"]',
    "  - path: vendor/skills",
  );
  const files = {
    "skills/a/SKILL.md": skillText("a"),
    "skills/_archive/old/SKILL.md": skillText("old"),
    "vendor/skills/b/SKILL.md": skillText("b"),
    "other/readme.txt": "x\n",
  };

  test.effect("a named declared folder, and a missing group folder it creates", () =>
    withImportWorld({ declaration: multi, files, commits: [single] }, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const plan = yield* previewImport(
          world.options,
          importRequest({ into: "personal-brain:vendor/skills" }),
        );
        expect(plan.destination).toMatchObject({ folder: "vendor/skills", newFolders: [] });
        expect(plan.writes).toMatchObject([{ path: "vendor/skills/pdf" }]);
        const created = yield* previewImport(
          world.options,
          importRequest({ into: "personal-brain:vendor/skills/anthropic" }),
        );
        expect(created.destination).toMatchObject({
          folder: "vendor/skills/anthropic",
          newFolders: ["vendor/skills/anthropic"],
        });
        const yamlBefore = yield* fileSystem.readFileString(`${world.root}/tack.yaml`);
        yield* applyImport(
          world.options,
          importRequest({ into: "personal-brain:vendor/skills/anthropic" }),
        );
        expect(yield* fileSystem.exists(`${world.root}/vendor/skills/anthropic/pdf/SKILL.md`)).toBe(
          true,
        );
        // No declaration was added or edited: the original bytes are an exact prefix.
        expect(
          (yield* fileSystem.readFileString(`${world.root}/tack.yaml`)).startsWith(yamlBefore),
        ).toBe(true);
      }),
    ),
  );

  test.effect("several declared folders refuse both preview and apply, listing the choices", () =>
    withImportWorld({ declaration: multi, files, commits: [single] }, (world) =>
      Effect.gen(function* () {
        const before = yield* snapshotTree(world.root);
        const plan = yield* previewImport(world.options, importRequest({ into: "personal-brain" }));
        expect(plan.outcome).toBe("refused");
        expect(plan.refusal?.message).toContain(
          "--into personal-brain:skills or --into personal-brain:vendor/skills",
        );
        const error = yield* applyImport(
          world.options,
          importRequest({ into: "personal-brain" }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-destination-invalid" });
        expect(changedPaths(before, yield* snapshotTree(world.root))).toEqual([]);
      }),
    ),
  );

  test.effect("no declared skills folder refuses and writes nothing", () =>
    withImportWorld(
      {
        declaration: declare("docs: [{ path: docs }]"),
        files: { "docs/r.md": "# r\n" },
        commits: [single],
      },
      (world) =>
        Effect.gen(function* () {
          const before = yield* snapshotTree(world.root);
          const error = yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          ).pipe(Effect.flip);
          expect(error.message).toContain("skills: [{ path: skills }]");
          expect(changedPaths(before, yield* snapshotTree(world.root))).toEqual([]);
        }),
    ),
  );

  test.effect("outside every declaration, excluded, and inside a skill are refused", () =>
    withImportWorld({ declaration: multi, files, commits: [single] }, (world) =>
      Effect.gen(function* () {
        const refusal = (into: string) =>
          previewImport(world.options, importRequest({ into })).pipe(
            Effect.map((plan) => plan.refusal?.message),
          );
        expect(yield* refusal("personal-brain:other")).toContain("outside every skills folder");
        expect(yield* refusal("personal-brain:skills/_archive")).toContain("excluded");
        expect(yield* refusal("personal-brain:skills/a")).toContain("leaf");
        expect(yield* refusal("personal-brain:skills/a/deeper")).toContain(
          "skills/a is a skill folder",
        );
      }),
    ),
  );

  test.effect("the new path must be selected by the declaration's patterns", () =>
    withImportWorld(
      {
        declaration: declare("skills:", "  - path: skills", '    include: ["allowed-*"]'),
        files: { "skills/allowed-one/SKILL.md": skillText("allowed-one") },
        commits: [single],
      },
      (world) =>
        Effect.gen(function* () {
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          );
          expect(plan.outcome).toBe("nothing-importable");
          expect(plan.candidates[0]?.verdict).toMatchObject({ code: "import-folder-not-selected" });
        }),
    ),
  );
});

it.layer(LiveTestLayer)("import selection", (test) => {
  const declaration = declare("skills: [{ path: skills }]");
  const files = { "skills/a/SKILL.md": skillText("a") };

  test.effect("--skill matches exactly then case-insensitively", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const exact = yield* previewImport(
          world.options,
          importRequest({ into: "personal-brain", skills: ["pdf"] }),
        );
        expect(exact.selected).toEqual(["pdf"]);
        const folded = yield* previewImport(
          world.options,
          importRequest({ into: "personal-brain", skills: ["DOCX", "pdf", "PDF"] }),
        );
        expect(folded.selected).toEqual(["docx", "pdf"]);
      }),
    ),
  );

  test.effect("an unknown name fails listing what exists", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const error = yield* previewImport(
          world.options,
          importRequest({ into: "personal-brain", skills: ["nope"] }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({
          code: "import-selection-unknown",
          details: { available: expect.arrayContaining(["pdf", "docx"]) },
        });
        expect(error.message).toContain("docx, pdf");
      }),
    ),
  );

  test.effect("a not-importable name fails with its reason", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const error = yield* previewImport(
          world.options,
          importRequest({ into: "personal-brain", skills: ["Bad Name"] }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-candidate-not-importable" });
        expect(error.message).toContain("Bad Name");
      }),
    ),
  );

  test.effect("--all imports every importable skill and lists the rest as rejected", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const { applied } = yield* applyImport(
          world.options,
          importRequest({ into: "personal-brain", all: true }),
        );
        expect(applied.imported.map((write) => write.name)).toEqual(["docx", "pdf"]);
        expect(applied.rejected).toMatchObject([{ name: "Bad Name", folder: "skills/Bad" }]);
        expect(applied.written).toEqual(["skills/docx/", "skills/pdf/", "tack.yaml"]);
      }),
    ),
  );

  test.effect("a single candidate needs no selection", () =>
    withImportWorld({ declaration, files, commits: [single] }, (world) =>
      Effect.gen(function* () {
        const plan = yield* previewImport(world.options, importRequest({ into: "personal-brain" }));
        expect(plan).toMatchObject({ outcome: "ready", selected: ["pdf"] });
        const { applied } = yield* applyImport(
          world.options,
          importRequest({ into: "personal-brain" }),
        );
        expect(applied.imported.map((write) => write.name)).toEqual(["pdf"]);
      }),
    ),
  );

  test.effect("a sole candidate that is not importable fails the apply with its reason", () =>
    withImportWorld(
      {
        declaration,
        files,
        commits: [{ files: { "skills/Bad/SKILL.md": skillText("Bad Name") } }],
      },
      (world) =>
        Effect.gen(function* () {
          const error = yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          ).pipe(Effect.flip);
          expect(error).toMatchObject({ code: "import-no-candidates" });
          expect(error.message).toContain("cannot be imported");
        }),
    ),
  );

  test.effect("several candidates and no selection fail the apply", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const before = yield* snapshotTree(world.root);
        const error = yield* applyImport(
          world.options,
          importRequest({ into: "personal-brain" }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-selection-required" });
        expect(changedPaths(before, yield* snapshotTree(world.root))).toEqual([]);
      }),
    ),
  );

  test.effect("--apply without --into fails with import-destination-required", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const error = yield* applyImport(world.options, importRequest({ skills: ["pdf"] })).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({ code: "import-destination-required" });
      }),
    ),
  );

  test.effect("a location that cannot be parsed fails before any network call", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const error = yield* previewImport(
          world.options,
          importRequest({ location: "owner/repo@v1", into: "personal-brain" }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-location-invalid" });
      }),
    ),
  );

  test.effect("a location without any skill fails the apply and names nothing it found", () =>
    withImportWorld(
      { declaration, files, commits: [{ files: { "README.md": "no skills\n" } }] },
      (world) =>
        Effect.gen(function* () {
          const unknown = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["pdf"] }),
          ).pipe(Effect.flip);
          expect(unknown).toMatchObject({
            code: "import-selection-unknown",
            details: { available: [] },
          });
          expect(unknown.message).toContain("Skills found: none.");
          const error = yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          ).pipe(Effect.flip);
          expect(error).toMatchObject({
            code: "import-no-candidates",
            message:
              "Nothing in this location can be imported. Scope it to a folder, or search deeper with --full-depth.",
            details: { candidates: [] },
          });
        }),
    ),
  );
});
