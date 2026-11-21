import { declare, skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { importRequest, withImportWorld } from "../../../test/support/import-world.ts";
import { defaultImportLimits, ImportRemote } from "../../services/import-remote.ts";
import { makeImportRemote } from "../../platform/git/import-remote.ts";
import { previewImport } from "./import.ts";

const declaration = declare("skills: [{ path: skills }]");
const files = { "skills/a/SKILL.md": skillText("a") };

it.layer(LiveTestLayer)("import candidates", (test) => {
  test.effect(
    "a SKILL.md without usable frontmatter is named after its folder and refused by the catalog",
    () =>
      withImportWorld(
        {
          declaration,
          files,
          commits: [
            {
              files: {
                "skills/plain/SKILL.md": "# plain\n",
                "skills/open/SKILL.md": "---\nname: open\n# never closed\n",
                "skills/broken/SKILL.md": "---\nname: [unclosed\n---\n",
                "skills/scalar/SKILL.md": "---\njust text\n---\n",
                "skills/numeric/SKILL.md": "---\nname: 42\ndescription: numeric\n---\n",
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
            expect(
              plan.candidates.map((candidate) => ({
                name: candidate.name,
                description: candidate.description,
                importable: candidate.verdict.importable,
              })),
            ).toEqual([
              { name: "broken", description: undefined, importable: false },
              { name: "numeric", description: "numeric", importable: false },
              { name: "open", description: undefined, importable: false },
              { name: "plain", description: undefined, importable: false },
              { name: "scalar", description: undefined, importable: false },
            ]);
            expect(plan.outcome).toBe("nothing-importable");
          }),
      ),
  );

  test.effect("a skill at the repository root is read from the whole tree", () =>
    withImportWorld(
      { declaration, files, commits: [{ files: { "SKILL.md": "# root\n" } }] },
      (world) =>
        Effect.gen(function* () {
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          );
          expect(plan.candidates).toMatchObject([
            { folder: "", name: "(unnamed)", files: 1, verdict: { importable: false } },
          ]);
        }),
    ),
  );

  test.effect("a refused skill at the repository root is shown as (root)", () =>
    withImportWorld(
      { declaration, files, commits: [{ files: { "SKILL.md": skillText("whole") } }] },
      (world) =>
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const remote = makeImportRemote(spawner, fileSystem, path, {
            fixtureRoot: `${world.base}/remotes`,
            limits: { ...defaultImportLimits, maxFileBytes: 4 },
          });
          const plan = yield* previewImport(
            world.options,
            importRequest({ into: "personal-brain" }),
          ).pipe(Effect.provideService(ImportRemote, remote));
          expect(plan.candidates).toMatchObject([
            {
              folder: "",
              name: "(root)",
              verdict: { importable: false, code: "import-file-too-large" },
            },
          ]);
        }),
    ),
  );
});
