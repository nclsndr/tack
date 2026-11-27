import { declare, skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { addSource, importRequest, withImportWorld } from "../../../test/support/import-world.ts";
import { mutateStateFixture } from "../../../test/support/state-fixture.ts";
import { readState } from "../../services/state-store.ts";
import { previewImport } from "./import.ts";
import type { Namespace } from "../../domain/choices/choice-schema.ts";

const declaration = declare("personal-brain", "skills: [{ path: skills }]");

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
            yield* addSource(world, "other", declare("other", "skills: [{ path: skills }]"), {
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
            yield* mutateStateFixture(world.options, (state) => ({
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
                fixedProfileProjects: [],
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
                fixedProfileProjects: [],
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
                fixedProfileProjects: [],
              },
            ]);
          }),
      ),
  );

  test.effect(
    "lists a project a fixed profile holds apart, with the profile and the re-apply command",
    () =>
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
            const fileSystem = yield* FileSystem.FileSystem;
            const brain =
              (yield* readState(world.options)).data.sources.find(
                (source) => source.canonicalPath === world.root,
              )?.id ?? "";
            const root = (name: string) => `${world.base}/${name}`;
            yield* Effect.forEach(["alpha", "ci", "kept"], (name) =>
              fileSystem.makeDirectory(root(name)),
            );
            const pdf = { kind: "skill", name: "pdf", sourceRegistrationId: brain } as const;
            const fixed = (namespace: Namespace, inventory: ReadonlyArray<typeof pdf>) => ({
              namespace,
              profileName: "ci",
              sourceRegistrationId: brain,
              direct: inventory,
              inventory,
              targets: namespace._tag === "project" ? [root(namespace.projectName)] : [],
            });
            yield* mutateStateFixture(world.options, (state) => ({
              data: {
                ...state.data,
                enabledAdapters: ["claude"],
                projects: ["alpha", "ci", "kept"].map((name) => ({
                  name,
                  gitCommonDirectory: root(name),
                  roots: [root(name)],
                })),
                profileApplications: [
                  fixed({ _tag: "project", projectName: "ci" }, []),
                  // A retained member that the import restores is delivered by the profile.
                  fixed({ _tag: "project", projectName: "kept" }, [pdf]),
                  fixed({ _tag: "user" }, []),
                ],
              },
            }));
            const plan = yield* previewImport(
              world.options,
              importRequest({ into: "personal-brain", skills: ["pdf"] }),
            );
            expect(plan.reach[0]).toMatchObject({
              projects: [
                { project: "alpha", receives: true },
                { project: "kept", receives: true },
              ],
              fixedProfileProjects: [
                {
                  project: "ci",
                  profile: "personal-brain:ci",
                  deliver: [
                    ...["tack", "profile", "apply", "personal-brain:ci", "--project", "ci"],
                    ...["--target-root", root("ci"), "--force"],
                  ],
                },
              ],
              user: { receives: false, reason: "fixed by profile personal-brain:ci" },
            });
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
