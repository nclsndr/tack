import { declare, skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { vi } from "vitest";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import {
  addSource,
  changedPaths,
  importRequest,
  snapshotTree,
  withImportWorld,
} from "../../../test/support/import-world.ts";
import { applyImport, previewImport } from "./import.ts";

const commit = {
  files: {
    "skills/pdf/SKILL.md": skillText("pdf"),
    "skills/pdf/scripts/fill.py": { content: "print('x')\n", executable: true },
    "skills/docx/SKILL.md": skillText("docx"),
  },
  tag: "v1.0.0",
} as const;

const brain = declare("skills: [{ path: skills }]");
const brainFiles = { "skills/mine/SKILL.md": skillText("mine"), "notes/todo.txt": "todo\n" };

it.layer(LiveTestLayer)("import preview", (test) => {
  test.effect("writes nothing to the destination or state and removes its scratch area", () =>
    withImportWorld({ declaration: brain, files: brainFiles, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const scratch = `${world.base}/scratch`;
        yield* fileSystem.makeDirectory(scratch);
        vi.stubEnv("TMPDIR", scratch);
        const treeBefore = yield* snapshotTree(world.root);
        const stateBefore = yield* fileSystem.readFileString(world.statePath);
        const plan = yield* previewImport(
          world.options,
          importRequest({ into: "personal-brain", skills: ["pdf"] }),
        );
        expect(plan.outcome).toBe("ready");
        expect(plan.candidates.map(({ name, verdict }) => [name, verdict.importable])).toEqual([
          ["docx", true],
          ["pdf", true],
        ]);
        expect(changedPaths(treeBefore, yield* snapshotTree(world.root))).toEqual([]);
        expect(yield* fileSystem.readFileString(world.statePath)).toBe(stateBefore);
        expect(yield* fileSystem.readDirectory(scratch)).toEqual([]);
      }),
    ),
  );

  test.effect("reports needs-selection for several candidates and no choice", () =>
    withImportWorld({ declaration: brain, files: brainFiles, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const plan = yield* previewImport(world.options, importRequest({ into: "personal-brain" }));
        expect(plan).toMatchObject({ outcome: "needs-selection", selected: [], writes: [] });
        expect(plan.destination).toMatchObject({ folder: "skills" });
      }),
    ),
  );

  test.effect("without --into lists the sources that can receive and what they declare", () =>
    withImportWorld({ declaration: brain, files: brainFiles, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        yield* addSource(world, "vendorsrc", declare("skills:", "  - path: a", "  - path: b"), {
          "a/x/SKILL.md": skillText("x"),
          "b/y/SKILL.md": skillText("y"),
        });
        yield* addSource(world, "docsonly", declare("docs: [{ path: docs }]"), {
          "docs/readme.md": "# d\n",
        });
        const plan = yield* previewImport(world.options, importRequest({ skills: ["pdf"] }));
        expect(plan.outcome).toBe("needs-destination");
        expect(plan.destination).toBeUndefined();
        expect(plan.selected).toEqual(["pdf"]);
        const byName = Object.fromEntries(
          (plan.destinations ?? []).map((choice) => [choice.name, choice.folders]),
        );
        expect(byName).toEqual({
          "personal-brain": ["skills"],
          vendorsrc: ["a", "b"],
          docsonly: [],
        });
      }),
    ),
  );

  test.effect("refuses in the plan when the source declares no folder or several", () =>
    withImportWorld(
      {
        declaration: declare("docs: [{ path: docs }]"),
        files: { "docs/r.md": "# r\n" },
        commits: [commit],
      },
      (world) =>
        Effect.gen(function* () {
          const none = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["pdf"] }),
          );
          expect(none.outcome).toBe("refused");
          expect(none.refusal?.message).toContain("skills: [{ path: skills }]");
          expect(none.writes).toEqual([]);
          yield* addSource(world, "multi", declare("skills:", "  - path: s1", "  - path: s2"), {
            "s1/a/SKILL.md": skillText("a"),
            "s2/b/SKILL.md": skillText("b"),
          });
          const several = yield* previewImport(
            world.options,
            importRequest({ into: "multi", skills: ["pdf"] }),
          );
          expect(several.outcome).toBe("refused");
          expect(several.refusal?.message).toContain("--into multi:s1 or --into multi:s2");
        }),
    ),
  );

  test.effect("reports nothing-importable when the location holds no skill", () =>
    withImportWorld(
      {
        declaration: brain,
        files: brainFiles,
        commits: [{ files: { "README.md": "# hello\n" } }],
      },
      (world) =>
        Effect.gen(function* () {
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          );
          expect(plan.outcome).toBe("nothing-importable");
          expect(plan.candidates).toEqual([]);
        }),
    ),
  );

  test.effect("an unusable --into fails before the network", () =>
    withImportWorld({ declaration: brain, files: brainFiles, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const error = yield* previewImport(world.options, importRequest({ into: "nowhere" })).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({ code: "import-destination-invalid" });
      }),
    ),
  );
});

it.layer(LiveTestLayer)("import apply writes two places only", (test) => {
  test.effect("changes only the skill folder and tack.yaml, keeping every other byte", () =>
    withImportWorld(
      {
        declaration: declare("# keep me", "", "skills: [{ path: skills }]", "", "# trailing"),
        files: brainFiles,
        commits: [commit],
      },
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const treeBefore = yield* snapshotTree(world.root);
          const stateBefore = yield* fileSystem.readFileString(world.statePath);
          const yamlBefore = yield* fileSystem.readFileString(path.join(world.root, "tack.yaml"));
          yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["pdf"] }),
          );
          const treeAfter = yield* snapshotTree(world.root);
          expect(changedPaths(treeBefore, treeAfter)).toEqual([
            "skills/pdf",
            "skills/pdf/SKILL.md",
            "skills/pdf/scripts",
            "skills/pdf/scripts/fill.py",
            "tack.yaml",
          ]);
          const yamlAfter = yield* fileSystem.readFileString(path.join(world.root, "tack.yaml"));
          expect(yamlAfter.startsWith(yamlBefore)).toBe(true);
          expect(yamlAfter.slice(yamlBefore.length)).toMatch(/^\n# Written by tack import\./);
          expect(yield* fileSystem.readFileString(world.statePath)).toBe(stateBefore);
        }),
    ),
  );

  test.effect("keeps CRLF line endings and rewrites only the block on a second import", () =>
    withImportWorld(
      {
        declaration: ["version: 1", "# crlf", "skills: [{ path: skills }]", ""].join("\r\n"),
        files: brainFiles,
        commits: [commit],
      },
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const yamlPath = `${world.root}/tack.yaml`;
          const original = yield* fileSystem.readFileString(yamlPath);
          yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["pdf"] }),
          );
          const first = yield* fileSystem.readFileString(yamlPath);
          expect(first.startsWith(original)).toBe(true);
          expect(first.replaceAll("\r\n", "")).not.toContain("\n");
          yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["docx"] }),
          );
          const second = yield* fileSystem.readFileString(yamlPath);
          expect(second.startsWith(original)).toBe(true);
          expect(second.replaceAll("\r\n", "")).not.toContain("\n");
          expect(second).toContain("path: skills/docx");
          expect(second).toContain("path: skills/pdf");
          // The first block is a prefix of the second except where the new record sorts in.
          const blockStart = first.indexOf("# Written by tack import");
          expect(second.slice(0, blockStart)).toBe(first.slice(0, blockStart));
        }),
    ),
  );

  test.effect("a created group folder is part of the change, and nothing else is", () =>
    withImportWorld(
      { declaration: declare("skills: [{ path: skills }]"), files: brainFiles, commits: [commit] },
      (world) =>
        Effect.gen(function* () {
          const before = yield* snapshotTree(world.root);
          const { applied } = yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain:skills/anthropic", skills: ["docx"] }),
          );
          expect(applied.written).toEqual([
            "skills/anthropic/",
            "skills/anthropic/docx/",
            "tack.yaml",
          ]);
          expect(changedPaths(before, yield* snapshotTree(world.root))).toEqual([
            "skills/anthropic",
            "skills/anthropic/docx",
            "skills/anthropic/docx/SKILL.md",
            "tack.yaml",
          ]);
        }),
    ),
  );

  test.effect("an apply that fails validation leaves the destination untouched", () =>
    withImportWorld({ declaration: brain, files: brainFiles, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const before = yield* snapshotTree(world.root);
        const error = yield* applyImport(
          world.options,
          importRequest({ into: "personal-brain", skills: ["nope"] }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "import-selection-unknown" });
        expect(changedPaths(before, yield* snapshotTree(world.root))).toEqual([]);
      }),
    ),
  );
});
