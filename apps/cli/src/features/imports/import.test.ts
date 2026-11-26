import { declare, skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { withImportWorld } from "../../../test/support/import-world.ts";
import { defaultImportLimits, ImportRemote } from "../../services/import-remote.ts";
import { applyImport, previewImport } from "./import.ts";

const commit = {
  files: {
    "skills/pdf/SKILL.md": skillText("pdf"),
    "skills/pdf/scripts/fill.py": { content: "print('x')\n", executable: true },
    "skills/docx/SKILL.md": skillText("docx"),
    "skills/_wip/draft/SKILL.md": skillText("draft"),
  },
  tag: "v1.0.0",
} as const;

it.layer(LiveTestLayer)("import add", (test) => {
  test.effect("preview lists candidates, resolves the destination and writes nothing", () =>
    withImportWorld(
      {
        declaration: declare("personal-brain", "skills: [{ path: skills }]"),
        files: { "skills/mine/SKILL.md": skillText("mine") },
        commits: [commit],
      },
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const before = yield* fileSystem.readFileString(world.statePath);
          const plan = yield* previewImport(world.options, {
            location: "github:acme/skills",
            into: "personal-brain",
            skills: ["pdf"],
            all: false,
            fullDepth: false,
          });
          expect(plan).toMatchObject({
            outcome: "ready",
            revision: world.revisions[0],
            selected: ["pdf"],
            destination: { source: "personal-brain", folder: "skills", newFolders: [] },
            writes: [{ name: "pdf", path: "skills/pdf", upstreamPath: "skills/pdf", files: 2 }],
          });
          expect(plan.candidates.map((candidate) => candidate.name)).toEqual(["docx", "pdf"]);
          expect(yield* fileSystem.exists(`${world.root}/skills/pdf`)).toBe(false);
          expect(yield* fileSystem.readFileString(world.statePath)).toBe(before);
        }),
    ),
  );

  test.effect("apply writes the folder and one record, and nothing else changes", () =>
    withImportWorld(
      {
        declaration: declare("personal-brain", "# mine", "skills: [{ path: skills }]"),
        files: { "skills/mine/SKILL.md": skillText("mine") },
        commits: [commit],
      },
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const yamlBefore = yield* fileSystem.readFileString(path.join(world.root, "tack.yaml"));
          const stateBefore = yield* fileSystem.readFileString(world.statePath);
          const { applied } = yield* applyImport(world.options, {
            location: "github:acme/skills",
            into: "personal-brain",
            skills: ["pdf"],
            all: false,
            fullDepth: false,
          });
          expect(applied.written).toEqual(["skills/pdf/", "tack.yaml"]);
          const copied = yield* fileSystem.readFileString(
            path.join(world.root, "skills/pdf/SKILL.md"),
          );
          expect(copied).toBe(skillText("pdf"));
          const mode = (yield* fileSystem.stat(path.join(world.root, "skills/pdf/scripts/fill.py")))
            .mode;
          expect(mode & 0o111).not.toBe(0);
          const yamlAfter = yield* fileSystem.readFileString(path.join(world.root, "tack.yaml"));
          expect(yamlAfter.startsWith(yamlBefore)).toBe(true);
          expect(yamlAfter).toContain("imports:");
          expect(yamlAfter).toContain("path: skills/pdf");
          expect(yield* fileSystem.readFileString(world.statePath)).toBe(stateBefore);
          expect(yield* fileSystem.exists(path.join(world.root, ".tack-import-staging"))).toBe(
            false,
          );
        }),
    ),
  );

  test.effect("apply into a skills entry at . writes at its top and records the skill there", () =>
    withImportWorld(
      {
        declaration: declare("personal-brain", "skills:", "  - path: ."),
        files: { "mine/SKILL.md": skillText("mine") },
        commits: [commit],
      },
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const request = {
            location: "github:acme/skills",
            into: "personal-brain",
            skills: ["pdf"],
            all: false,
            fullDepth: false,
          };
          const plan = yield* previewImport(world.options, request);
          expect(plan).toMatchObject({
            outcome: "ready",
            destination: { folder: ".", declaredFolder: ".", newFolders: [] },
            writes: [{ name: "pdf", path: "pdf" }],
          });
          const { applied } = yield* applyImport(world.options, request);
          expect(applied.written).toEqual(["pdf/", "tack.yaml"]);
          expect(yield* fileSystem.readFileString(path.join(world.root, "pdf/SKILL.md"))).toBe(
            skillText("pdf"),
          );
          const yaml = yield* fileSystem.readFileString(path.join(world.root, "tack.yaml"));
          expect(yaml).toContain("  - path: .\n");
          expect(yaml).toContain("path: pdf\n");
        }),
    ),
  );

  test.effect(
    "a location with no provider is refused with the retype before any network call",
    () =>
      withImportWorld(
        {
          declaration: declare("personal-brain", "skills: [{ path: skills }]"),
          files: { "skills/mine/SKILL.md": skillText("mine") },
          commits: [commit],
        },
        (world) =>
          Effect.gen(function* () {
            const calls: string[] = [];
            const spy = ImportRemote.of({
              limits: defaultImportLimits,
              probe: Effect.sync(() => calls.push("probe")).pipe(
                Effect.andThen(Effect.die("network")),
              ),
              listRefs: () =>
                Effect.sync(() => calls.push("listRefs")).pipe(
                  Effect.andThen(Effect.die("network")),
                ),
              open: () =>
                Effect.sync(() => calls.push("open")).pipe(Effect.andThen(Effect.die("network"))),
            });
            const request = {
              into: "personal-brain",
              skills: ["pdf"],
              all: false,
              fullDepth: false,
            };
            const cases: ReadonlyArray<readonly [string, string]> = [
              ["acme/skills", "github:acme/skills"],
              ["acme/skills/skills/pdf", "github:acme/skills/skills/pdf"],
              ["acme/skills#v1.0.0", "github:acme/skills#v1.0.0"],
              ["github.com/acme/skills", "github:acme/skills"],
            ];
            for (const [location, suggestion] of cases) {
              for (const mode of ["preview", "apply"] as const) {
                const attempt = { ...request, location };
                const outcome =
                  mode === "preview"
                    ? previewImport(world.options, attempt).pipe(Effect.asVoid)
                    : applyImport(world.options, attempt).pipe(Effect.asVoid);
                const error = yield* outcome.pipe(
                  Effect.provideService(ImportRemote, spy),
                  Effect.flip,
                );
                expect(error, location).toMatchObject({
                  code: "import-location-invalid",
                  details: {
                    reason: "location-provider-missing",
                    suggestion,
                    next: [
                      "tack",
                      "import",
                      "add",
                      suggestion,
                      "--skill",
                      "pdf",
                      "--into",
                      "personal-brain",
                      ...(mode === "apply" ? ["--apply"] : []),
                    ],
                  },
                });
              }
            }
            expect(calls).toEqual([]);
          }),
      ),
  );

  test.effect("the retyped command keeps every flag the operator typed", () =>
    withImportWorld(
      {
        declaration: declare("personal-brain", "skills: [{ path: skills }]"),
        files: { "skills/mine/SKILL.md": skillText("mine") },
        commits: [commit],
      },
      (world) =>
        Effect.gen(function* () {
          const error = yield* previewImport(world.options, {
            location: "acme/skills@v1",
            skills: ["pdf", "docx"],
            all: true,
            fullDepth: true,
          }).pipe(Effect.flip);
          expect(error).toMatchObject({
            details: {
              reason: "location-at-form",
              suggestion: "github:acme/skills#v1",
              next: [
                "tack",
                "import",
                "add",
                "github:acme/skills#v1",
                "--skill",
                "pdf",
                "--skill",
                "docx",
                "--all",
                "--full-depth",
              ],
            },
          });
          const unfixable = yield* previewImport(world.options, {
            location: "gitlab:acme/skills",
            skills: [],
            all: false,
            fullDepth: false,
          }).pipe(Effect.flip);
          expect(unfixable).toMatchObject({ details: { reason: "location-provider-unknown" } });
          expect(JSON.stringify(unfixable)).not.toContain("suggestion");
        }),
    ),
  );

  test.effect("the plan names the provider, and says when the operator typed a URL", () =>
    withImportWorld(
      {
        declaration: declare("personal-brain", "skills: [{ path: skills }]"),
        files: { "skills/mine/SKILL.md": skillText("mine") },
        commits: [commit],
      },
      (world) =>
        Effect.gen(function* () {
          const request = { skills: ["pdf"], all: false, fullDepth: false, into: "personal-brain" };
          const plans = yield* Effect.forEach(
            [
              "github:acme/skills",
              "https://github.com/acme/skills.git",
              "git@github.com:acme/skills.git",
            ],
            (location) => previewImport(world.options, { ...request, location }),
          );
          expect(
            plans.map((plan) => [plan.location, plan.provider, plan.transport, plan.urlForm]),
          ).toEqual([
            ["github:acme/skills", "github", "https", undefined],
            ["github:acme/skills", "github", "https", "https"],
            ["github:acme/skills", "github", "ssh", "ssh"],
          ]);
        }),
    ),
  );
});
