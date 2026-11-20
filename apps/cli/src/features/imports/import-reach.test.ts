import { declare, skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { addSource, importRequest, withImportWorld } from "../../../test/support/import-world.ts";
import { mutateState } from "../../../test/support/state-fixture.ts";
import { readState } from "../../services/state-store.ts";
import { previewImport } from "./import.ts";

const declaration = declare("skills: [{ path: skills }]");

it.layer(LiveTestLayer)("import reach", (test) => {
  test.effect(
    "each project and the user get the sync decision, with its reason and same-name collisions",
    () =>
      withImportWorld(
        {
          declaration,
          files: { "skills/a/SKILL.md": skillText("a") },
          commits: [
            {
              files: {
                "skills/pdf/SKILL.md": skillText("pdf", { tack: ["user-activation: default"] }),
                "skills/docx/SKILL.md": skillText("docx", { tack: ["activation: opt-in"] }),
                "skills/xlsx/SKILL.md": skillText("xlsx", { tack: ["projects: [zeta]"] }),
              },
            },
          ],
        },
        (world) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            yield* addSource(world, "other", declaration, {
              "skills/pdf/SKILL.md": skillText("pdf", { tack: ["user-activation: default"] }),
            });
            const sources = (yield* readState(world.options)).data.sources;
            const id = (path: string) =>
              sources.find((source) => source.canonicalPath === path)?.id ?? "";
            const brain = id(world.root);
            const other = id(`${world.base}/other`);
            const pdf = (sourceRegistrationId: string) =>
              ({ kind: "skill", name: "pdf", sourceRegistrationId }) as const;
            const roots = ["beta", "alpha", "gamma"].map((name) => `${world.base}/${name}`);
            yield* Effect.forEach(roots, (root) => fileSystem.makeDirectory(root));
            yield* mutateState(world.options, (state) => ({
              data: {
                ...state.data,
                enabledAdapters: ["claude"],
                projects: ["beta", "alpha", "gamma"].map((name) => ({
                  name,
                  gitCommonDirectory: `${world.base}/${name}`,
                  roots: [`${world.base}/${name}`],
                })),
                choices: [
                  {
                    namespace: { _tag: "project", projectName: "beta" },
                    address: pdf(brain),
                    decision: "exclude",
                  },
                  {
                    namespace: { _tag: "project", projectName: "gamma" },
                    address: pdf(other),
                    decision: "include",
                  },
                ],
              },
            }));
            const plan = yield* previewImport(
              world.options,
              importRequest({ into: "personal-brain", skills: ["pdf", "docx", "xlsx"] }),
            );
            expect(plan.reach).toEqual([
              {
                name: "pdf",
                projects: [
                  { project: "alpha", receives: true },
                  { project: "beta", receives: false, reason: "pick exclude" },
                  {
                    project: "gamma",
                    receives: false,
                    reason: "another source's skill of this name is included",
                  },
                ],
                user: { receives: true, reason: "selected by default" },
                collisions: [
                  { namespace: "project alpha", with: "other:pdf" },
                  { namespace: "user", with: "other:pdf" },
                ],
                undeclaredDependencies: [],
              },
              {
                name: "docx",
                projects: ["alpha", "beta", "gamma"].map((project) => ({
                  project,
                  receives: false,
                  reason: "activation is opt-in",
                })),
                user: { receives: false, reason: "user activation is opt-in" },
                collisions: [],
                undeclaredDependencies: [],
              },
              {
                name: "xlsx",
                projects: ["alpha", "beta", "gamma"].map((project) => ({
                  project,
                  receives: false,
                  reason: "metadata.tack.projects does not name this project",
                })),
                user: { receives: false, reason: "user activation is opt-in" },
                collisions: [],
                undeclaredDependencies: [],
              },
            ]);
          }),
      ),
  );

  test.effect("a selected skill reaches nothing while no agent adapter is enabled", () =>
    withImportWorld(
      {
        declaration,
        files: { "skills/a/SKILL.md": skillText("a") },
        commits: [
          {
            files: {
              "skills/pdf/SKILL.md": skillText("pdf", { tack: ["user-activation: default"] }),
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
          expect(plan.reach[0]?.user).toEqual({
            receives: false,
            reason: "no agent adapter is enabled",
          });
        }),
    ),
  );
});
