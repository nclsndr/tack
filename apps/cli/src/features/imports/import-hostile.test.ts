import { declare, skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vitest";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import {
  importRequest,
  snapshotTree,
  changedPaths,
  withImportWorld,
  type ImportWorld,
} from "../../../test/support/import-world.ts";
import {
  defaultImportLimits,
  ImportRemote,
  type ImportLimits,
} from "../../services/import-remote.ts";
import { makeImportRemote } from "../../platform/git/import-remote.ts";
import { applyImport, previewImport } from "./import.ts";

const declaration = declare("skills: [{ path: skills }]");
const files = { "skills/a/SKILL.md": skillText("a") };

/** A remote over the world's fixture repositories with tightened safety limits. */
const withLimits = (world: ImportWorld, limits: Partial<ImportLimits>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return makeImportRemote(spawner, fileSystem, path, {
      fixtureRoot: `${world.base}/remotes`,
      limits: { ...defaultImportLimits, ...limits },
    });
  });

it.layer(LiveTestLayer)("import safety", (test) => {
  test.effect("symlinks and submodules are counted and never copied", () =>
    withImportWorld(
      {
        declaration,
        files,
        commits: [
          {
            files: {
              "skills/pdf/SKILL.md": skillText("pdf"),
              "skills/pdf/link": { symlink: "SKILL.md" },
              "skills/pdf/escape": { symlink: "../../../etc/passwd" },
              "skills/pdf/vendored": { submodule: "1".repeat(40) },
              "skills/pdf/real.txt": "real\n",
            },
          },
        ],
      },
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          );
          expect(plan.candidates[0]).toMatchObject({ files: 2, symlinks: 2, submodules: 1 });
          yield* applyImport(world.options, importRequest({ into: "personal-brain" }));
          expect((yield* fileSystem.readDirectory(`${world.root}/skills/pdf`)).sort()).toEqual([
            "SKILL.md",
            "real.txt",
          ]);
          const tree = yield* snapshotTree(world.root);
          expect([...tree.values()].some((entry) => entry.startsWith("link "))).toBe(false);
        }),
    ),
  );

  test.effect("a path with a backslash or a control character is refused for that skill", () =>
    withImportWorld(
      {
        declaration,
        files,
        commits: [
          {
            files: {
              "skills/slash/SKILL.md": skillText("slash"),
              "skills/slash/we\\ird.md": "x\n",
              "skills/ctl/SKILL.md": skillText("ctl"),
              "skills/ctl/bell\u0007.md": "x\n",
              "skills/fine/SKILL.md": skillText("fine"),
            },
          },
        ],
      },
      (world) =>
        Effect.gen(function* () {
          const before = yield* snapshotTree(world.root);
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          );
          const verdicts = Object.fromEntries(
            plan.candidates.map((candidate) => [
              candidate.name,
              candidate.verdict.importable ? "ok" : candidate.verdict.code,
            ]),
          );
          expect(verdicts).toEqual({
            ctl: "import-path-unsafe",
            fine: "ok",
            slash: "import-path-unsafe",
          });
          const { applied } = yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain", all: true }),
          );
          expect(applied.imported.map((write) => write.name)).toEqual(["fine"]);
          expect(applied.rejected.map((entry) => entry.code)).toEqual([
            "import-path-unsafe",
            "import-path-unsafe",
          ]);
          expect(
            changedPaths(before, yield* snapshotTree(world.root)).every(
              (path) => path === "tack.yaml" || path.startsWith("skills/fine"),
            ),
          ).toBe(true);
        }),
    ),
  );

  test.effect("over-limit files, file counts and skill sizes are refused with a reason", () =>
    withImportWorld(
      {
        declaration,
        files,
        commits: [
          {
            files: {
              "skills/bigfile/SKILL.md": skillText("bigfile"),
              "skills/bigfile/data.txt": "x".repeat(300),
              "skills/many/SKILL.md": skillText("many"),
              "skills/many/1.txt": "1",
              "skills/many/2.txt": "2",
              "skills/many/3.txt": "3",
              "skills/heavy/SKILL.md": skillText("heavy"),
              "skills/heavy/a.txt": "a".repeat(120),
              "skills/heavy/b.txt": "b".repeat(120),
              "skills/ok/SKILL.md": skillText("ok"),
            },
          },
        ],
      },
      (world) =>
        Effect.gen(function* () {
          const remote = yield* withLimits(world, {
            maxFileBytes: 200,
            maxFilesPerSkill: 3,
            maxBytesPerSkill: 400,
          });
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          ).pipe(Effect.provideService(ImportRemote, remote));
          const verdicts = Object.fromEntries(
            plan.candidates.map((candidate) => [
              candidate.name,
              candidate.verdict.importable ? "ok" : candidate.verdict.code,
            ]),
          );
          expect(verdicts).toEqual({
            bigfile: "import-file-too-large",
            heavy: "ok",
            many: "import-too-many-files",
            ok: "ok",
          });
          // `heavy` is 240 bytes of files plus SKILL.md: under 400. Tighten and look again.
          const tight = yield* withLimits(world, { maxBytesPerSkill: 100, maxFileBytes: 200 });
          const second = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          ).pipe(Effect.provideService(ImportRemote, tight));
          expect(
            second.candidates.find((candidate) => candidate.name === "heavy")?.verdict,
          ).toMatchObject({ code: "import-skill-too-large" });
        }),
    ),
  );

  test.effect("terminal control characters in text are stripped from the plan", () =>
    withImportWorld(
      {
        declaration,
        files,
        commits: [
          {
            files: {
              "skills/pdf/SKILL.md":
                '---\nname: pdf\ndescription: "red \\x1b[31mtext\\x07 done"\n---\n# pdf\n',
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
          const json = JSON.stringify(plan);
          // oxlint-disable-next-line eslint/no-control-regex -- The test looks for control text.
          expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(json)).toBe(false);
          expect(plan.candidates[0]?.description).toBe("red [31mtext done");
        }),
    ),
  );

  test.effect("no credential appears in any result, record or refusal", () =>
    withImportWorld(
      { declaration, files, commits: [{ files: { "skills/pdf/SKILL.md": skillText("pdf") } }] },
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          vi.stubEnv("GITHUB_TOKEN", "ghp_supersecretvalue");
          vi.stubEnv("GH_TOKEN", "ghp_supersecretvalue");
          const result = yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          );
          const rejected = yield* previewImport(
            world.options,
            importRequest({
              location: "https://user:ghp_supersecretvalue@github.com/acme/skills",
              into: "personal-brain",
            }),
          ).pipe(Effect.flip);
          expect(rejected).toMatchObject({ code: "import-location-invalid" });
          const everything = [
            JSON.stringify(result),
            JSON.stringify(rejected),
            yield* fileSystem.readFileString(`${world.root}/tack.yaml`),
            yield* fileSystem.readFileString(world.statePath),
          ].join("\n");
          expect(everything).not.toContain("ghp_supersecretvalue");
          expect(everything).not.toContain("user:");
        }),
    ),
  );
});
