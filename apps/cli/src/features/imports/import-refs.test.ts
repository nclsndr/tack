import { declare, skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import { execFileSync } from "node:child_process";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { importRequest, withImportWorld } from "../../../test/support/import-world.ts";
import { applyImport, previewImport } from "./import.ts";
import { filesDigest, sha256Hex } from "../../domain/imports/import-record.ts";
import { readImportsSection } from "./imports-section.ts";

const binary = new Uint8Array([0, 1, 2, 255, 0]);
const commits = [
  {
    files: {
      "skills/pdf/SKILL.md": skillText("pdf"),
      "skills/pdf/scripts/fill.py": { content: "print('x')\n", executable: true },
      "skills/pdf/assets/logo.bin": binary,
    },
    tag: "v1.0.0",
  },
  { files: { "skills/pdf/extra.md": "more\n" }, branch: "feature/install" },
] as const;
const declaration = declare("skills: [{ path: skills }]");
const files = { "skills/a/SKILL.md": skillText("a") };

const recordsOf = (root: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const section = readImportsSection(yield* fileSystem.readFileString(`${root}/tack.yaml`));
    if (Result.isFailure(section)) throw new Error(section.failure.message);
    return section.success.records;
  });

it.layer(LiveTestLayer)("import refs and records", (test) => {
  test.effect("the default branch is tracking and records no ref", () =>
    withImportWorld({ declaration, files, commits }, (world) =>
      Effect.gen(function* () {
        const { plan } = yield* applyImport(
          world.options,
          importRequest({ into: "personal-brain" }),
        );
        expect(plan.ref).toEqual({ kind: "default", tracking: true });
        expect(plan.revision).toBe(world.revisions[0]);
        const [record] = yield* recordsOf(world.root);
        expect(record).toMatchObject({
          path: "skills/pdf",
          location: "github:acme/skills",
          transport: "https",
          "ref-kind": "default",
          revision: world.revisions[0],
          "upstream-path": "skills/pdf",
        });
        expect(record?.ref).toBeUndefined();
      }),
    ),
  );

  test.effect("a slashed branch, a tag and a full commit are each understood", () =>
    withImportWorld({ declaration, files, commits }, (world) =>
      Effect.gen(function* () {
        const branch = yield* previewImport(
          world.options,
          importRequest({ location: "github:acme/skills#feature/install", into: "personal-brain" }),
        );
        expect(branch.ref).toEqual({ kind: "branch", request: "feature/install", tracking: true });
        expect(branch.revision).toBe(world.revisions[1]);
        expect(branch.location).toBe("github:acme/skills#feature/install");
        const tag = yield* previewImport(
          world.options,
          importRequest({ location: "github:acme/skills#v1.0.0", into: "personal-brain" }),
        );
        expect(tag.ref).toEqual({ kind: "tag", request: "v1.0.0", tracking: false });
        expect(tag.revision).toBe(world.revisions[0]);
        const sha = world.revisions[1] ?? "";
        const commit = yield* previewImport(
          world.options,
          importRequest({ location: `github:acme/skills#${sha}`, into: "personal-brain" }),
        );
        expect(commit.ref).toEqual({ kind: "commit", request: sha, tracking: false });
        expect(commit.revision).toBe(sha);
      }),
    ),
  );

  test.effect("a missing ref and an abbreviated commit are refused", () =>
    withImportWorld({ declaration, files, commits }, (world) =>
      Effect.gen(function* () {
        const missing = yield* previewImport(
          world.options,
          importRequest({ location: "github:acme/skills#nope", into: "personal-brain" }),
        ).pipe(Effect.flip);
        expect(missing).toMatchObject({ code: "import-ref-not-found" });
        const short = yield* previewImport(
          world.options,
          importRequest({
            location: `github:acme/skills#${(world.revisions[0] ?? "").slice(0, 10)}`,
            into: "personal-brain",
          }),
        ).pipe(Effect.flip);
        expect(short).toMatchObject({ code: "import-location-invalid" });
      }),
    ),
  );

  test.effect("a tree URL on a slashed branch reports where the ref was split", () =>
    withImportWorld({ declaration, files, commits }, (world) =>
      Effect.gen(function* () {
        const plan = yield* previewImport(
          world.options,
          importRequest({
            location: "https://github.com/acme/skills/tree/feature/install/skills/pdf",
            into: "personal-brain",
          }),
        );
        expect(plan.split).toEqual({
          ref: "feature/install",
          scope: "skills/pdf",
          explicit: "github:acme/skills/skills/pdf#feature/install",
        });
        expect(plan.ref.kind).toBe("branch");
        expect(plan.candidates.map((candidate) => candidate.folder)).toEqual(["skills/pdf"]);
      }),
    ),
  );

  test.effect("a blob URL to SKILL.md selects exactly that skill", () =>
    withImportWorld(
      {
        declaration,
        files,
        commits: [
          {
            files: {
              "skills/pdf/SKILL.md": skillText("pdf"),
              "skills/docx/SKILL.md": skillText("docx"),
            },
          },
        ],
      },
      (world) =>
        Effect.gen(function* () {
          const plan = yield* previewImport(
            world.options,
            importRequest({
              location: "https://github.com/acme/skills/blob/main/skills/pdf/SKILL.md",
              into: "personal-brain",
            }),
          );
          expect(plan.candidates.map((candidate) => candidate.name)).toEqual(["pdf"]);
          expect(plan.outcome).toBe("ready");
        }),
    ),
  );

  test.effect("the ssh form is recorded as the transport", () =>
    withImportWorld({ declaration, files, commits }, (world) =>
      Effect.gen(function* () {
        yield* applyImport(
          world.options,
          importRequest({
            location: "git@github.com:acme/skills.git#v1.0.0",
            into: "personal-brain",
          }),
        );
        const [record] = yield* recordsOf(world.root);
        expect(record).toMatchObject({ transport: "ssh", "ref-kind": "tag", ref: "v1.0.0" });
      }),
    ),
  );

  test.effect("the record's tree, digest, files and executable bits match what was written", () =>
    withImportWorld({ declaration, files, commits }, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* applyImport(
          world.options,
          importRequest({ location: "github:acme/skills#v1.0.0", into: "personal-brain" }),
        );
        const [record] = yield* recordsOf(world.root);
        if (record === undefined) throw new Error("no record");
        const bare = `${world.base}/remotes/acme/skills.git`;
        const tree = execFileSync(
          "git",
          ["-C", bare, "rev-parse", `${record.revision}:skills/pdf`],
          {
            encoding: "utf8",
          },
        ).trim();
        expect(record["upstream-tree"]).toBe(tree);
        expect(record["imported-at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(record.files.map((file) => file.path)).toEqual([
          "SKILL.md",
          "assets/logo.bin",
          "scripts/fill.py",
        ]);
        for (const file of record.files) {
          const bytes = yield* fileSystem.readFile(`${world.root}/skills/pdf/${file.path}`);
          expect(sha256Hex(bytes)).toBe(file.sha256);
          const mode = (yield* fileSystem.stat(`${world.root}/skills/pdf/${file.path}`)).mode;
          expect((mode & 0o111) !== 0).toBe(file.executable);
        }
        expect(record.files.find((file) => file.path === "scripts/fill.py")?.executable).toBe(true);
        expect(record.digest).toBe(filesDigest(record.files));
        // Bytes that are not text arrive byte for byte.
        expect([
          ...(yield* fileSystem.readFile(`${world.root}/skills/pdf/assets/logo.bin`)),
        ]).toEqual([...binary]);
        const plan = yield* previewImport(
          world.options,
          importRequest({ location: "github:acme/skills#feature/install", into: "personal-brain" }),
        );
        expect(plan.candidates[0]).toMatchObject({ nonText: 1, executables: 1 });
      }),
    ),
  );

  test.effect("a scoped location keeps its scope and ref in the plan's location", () =>
    withImportWorld({ declaration, files, commits }, (world) =>
      Effect.gen(function* () {
        const plan = yield* previewImport(
          world.options,
          importRequest({
            location: "github:acme/skills/skills/pdf#v1.0.0",
            into: "personal-brain",
          }),
        );
        expect(plan.location).toBe("github:acme/skills/skills/pdf#v1.0.0");
        expect(plan.split).toBeUndefined();
        expect(plan.candidates.map((candidate) => candidate.folder)).toEqual(["skills/pdf"]);
      }),
    ),
  );

  test.effect("a tree URL naming only a slashed branch splits without a scope", () =>
    withImportWorld({ declaration, files, commits }, (world) =>
      Effect.gen(function* () {
        const plan = yield* previewImport(
          world.options,
          importRequest({
            location: "https://github.com/acme/skills/tree/feature/install",
            into: "personal-brain",
          }),
        );
        expect(plan.split).toEqual({
          ref: "feature/install",
          explicit: "github:acme/skills#feature/install",
        });
        expect(plan.location).toBe("github:acme/skills#feature/install");
      }),
    ),
  );
});
