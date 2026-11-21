import { profileFixture as fixture } from "./support/profile-fixture.ts";
import { runManagedRemoval } from "../src/features/removal/removal.ts";
import { agentLink } from "../src/domain/links/link-record-schema.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, PlatformError } from "effect";
import { SecureRandom } from "effect/crypto";
import { provideTestFileSystem } from "./support/live-test-layer.ts";
import { runStatus } from "../src/features/status/status.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { mutateState } from "./support/state-fixture.ts";
import { readState } from "../src/services/state-store.ts";
import { Source, makeSourceService, registerSource } from "../src/features/sources/source.ts";
import { runProfileApply } from "../src/features/profiles/profile-apply.ts";
import { runSyncCommand } from "../src/features/reconciliation/sync-command.ts";
import { withStateCheckpointWriter } from "../src/services/state-store.ts";
import { setSkillChoice } from "../src/features/choices/choice.ts";

it.layer(LiveTestLayer)("exact profile application", (test) => {
  test.effect("retires fixed intent when its project registration is removed", () =>
    Effect.gen(function* () {
      const { options, request, run } = yield* fixture;
      yield* run(runProfileApply(options, request));
      yield* run(
        runManagedRemoval(
          options,
          { cause: "project-removal", scope: { _tag: "project", projectName: "ci" } },
          true,
        ),
      );
      expect((yield* readState(options)).data.profileApplications ?? []).toEqual([]);
    }),
  );

  test.effect(
    "refuses unavailable boundaries, unpublished or invalid profiles without mutation",
    () =>
      Effect.gen(function* () {
        const { options, request, run, root, write } = yield* fixture;
        const before = yield* readState(options);
        expect(
          (yield* run(runProfileApply(options, { ...request, targetRoots: [root + "/missing"] })))
            .plan.findings[0]?.code,
        ).toBe("profile-target-unavailable");
        expect(
          (yield* run(runProfileApply(options, { ...request, reference: "tools:missing" }))).plan
            .findings[0]?.code,
        ).toBe("profile-unpublished");
        yield* write("source/ci.yaml", "version: 9\nname: ci\nmembers: []\n");
        expect((yield* run(runProfileApply(options, request))).plan.refused).toBe(true);
        expect(yield* readState(options)).toEqual(before);
      }),
  );
  test.effect("treats explicit docs intent and target recovery as existing selection", () =>
    Effect.gen(function* () {
      const { options, request, run, sourceId, path, project } = yield* fixture;
      yield* mutateState(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          projects: state.data.projects.map((entry) => ({
            ...entry,
            docs: { attachments: [], destination: "handbook" },
          })),
        },
      }));
      expect((yield* run(runProfileApply(options, request))).plan.existing).toContain(
        "explicit docs settings",
      );
      const evidence = {
        adapter: "codex" as const,
        address: { kind: "skill" as const, name: "review", sourceRegistrationId: sourceId },
        sourceRegistrationId: sourceId,
        sourceDirectoryPath: path.join(project, "source"),
        target: { _tag: "project-root" as const, projectName: "ci", canonicalPath: project },
      };
      yield* mutateState(options, (state) => ({
        ...state,
        data: { ...state.data, journal: [{ _tag: "create", link: agentLink(evidence) }] },
      }));
      expect((yield* run(runProfileApply(options, request))).plan.existing).toContain(
        "target recovery journal",
      );
    }),
  );

  test.effect(
    "keeps ambient release-owned deliveries outside the replacement guard and cleanup",
    () =>
      Effect.gen(function* () {
        const { fs, path, home, project, options, request, run } = yield* fixture;
        const builtins = {
          id: "00000000-0000-4000-8000-0000000000b1",
          canonicalPath: yield* fs.realPath(new URL("../src/builtins", import.meta.url).pathname),
        };
        const sourceService = makeSourceService(yield* SecureRandom.SecureRandom, fs, path, [
          builtins,
        ]);
        yield* Effect.gen(function* () {
          yield* run(
            runSyncCommand(options, {
              apply: true,
              cwd: project,
              includeOptional: false,
              noDocs: false,
              selector: { _tag: "user" },
            }),
          );
          expect(yield* fs.exists(path.join(home, ".agents/skills/use-tack"))).toBe(true);
          const applied = yield* run(
            runProfileApply(options, {
              ...request,
              namespace: { _tag: "user" },
              targetRoots: [],
              targetHome: home,
            }),
          );
          expect(applied.plan.refused).toBe(false);
          expect(yield* fs.exists(path.join(home, ".agents/skills/use-tack"))).toBe(true);
        }).pipe(Effect.provideService(Source, sourceService));
      }),
  );
  test.effect("reports changed complete roots consistently in status and sync", () =>
    Effect.gen(function* () {
      const { fs, path, root, options, request, run } = yield* fixture;
      yield* run(runProfileApply(options, request));
      yield* fs.makeDirectory(path.join(root, "another-root"));
      yield* mutateState(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          projects: state.data.projects.map((project) => ({
            ...project,
            roots: [...project.roots, path.join(root, "another-root")].sort(),
          })),
        },
      }));
      const status = yield* run(runStatus(options, { cwd: root, selector: request.namespace }));
      expect(status.namespaces[0]?.profile?.issues.join(" ")).toContain(
        "complete target boundary changed",
      );
    }),
  );
  test.effect(
    "retains intent after zero successful links and retries the same inventory after an I/O failure",
    () =>
      Effect.gen(function* () {
        const { fs, path, project, options, request, run, write } = yield* fixture;
        const failed = {
          ...fs,
          symlink: () =>
            Effect.fail(PlatformError.badArgument({ module: "profile-test", method: "symlink" })),
        } satisfies FileSystem.FileSystem;
        const result = yield* run(provideTestFileSystem(runProfileApply(options, request), failed));
        expect(
          result.applied?.resources?.units.some((unit) =>
            unit.actions.some((action) => action["_tag"] === "failed"),
          ),
        ).toBe(true);
        expect((yield* readState(options)).data.links).toEqual([]);
        expect((yield* run(runProfileApply(options, request))).plan.refused).toBe(true);
        yield* write(
          "source/skills/new-default/SKILL.md",
          "---\nname: new-default\ndescription: New\n---\n",
        );
        yield* run(
          runSyncCommand(options, {
            apply: true,
            cwd: project,
            includeOptional: true,
            noDocs: false,
            selector: request.namespace,
          }),
        );
        expect((yield* fs.readDirectory(path.join(project, ".agents/skills"))).sort()).toEqual([
          "review",
          "style",
        ]);
        const status = yield* run(
          runStatus(options, { cwd: project, selector: request.namespace }),
        );
        expect(status.namespaces[0]?.profile).toMatchObject({
          application: { profileName: "ci" },
          issues: [],
        });
      }),
  );
  test.effect("previews without writes and refuses changed closure on later sync", () =>
    Effect.gen(function* () {
      const { fs, path, project, options, request, run, write } = yield* fixture;
      const before = yield* readState(options);
      const preview = yield* run(runProfileApply(options, { ...request, apply: false }));
      expect(preview.plan.refused).toBe(false);
      expect(yield* readState(options)).toEqual(before);
      expect(yield* fs.exists(path.join(project, ".agents"))).toBe(false);
      yield* run(runProfileApply(options, request));
      yield* write(
        "source/skills/new-required/SKILL.md",
        "---\nname: new-required\ndescription: New\n---\n",
      );
      yield* write(
        "source/skills/style/SKILL.md",
        "---\nname: style\ndescription: Style\nmetadata:\n  tack: |\n    version: 1\n    dependencies:\n      - kind: skill\n        name: new-required\n---\n",
      );
      const synced = yield* run(
        runSyncCommand(options, {
          apply: true,
          cwd: project,
          includeOptional: false,
          noDocs: false,
          selector: request.namespace,
        }),
      );
      expect(synced.plan.resources?.causes).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "profile-inventory-unresolved" })]),
      );
      expect((yield* fs.readDirectory(path.join(project, ".agents/skills"))).sort()).toEqual([
        "review",
        "style",
      ]);
    }),
  );
  test.effect(
    "owned ordinary defaults trigger replacement authorization, computed defaults alone do not",
    () =>
      Effect.gen(function* () {
        const { fs, path, project, options, request, run } = yield* fixture;
        yield* run(
          runSyncCommand(options, {
            apply: true,
            cwd: project,
            includeOptional: false,
            noDocs: false,
            selector: request.namespace,
          }),
        );
        expect((yield* fs.readDirectory(path.join(project, ".agents/skills"))).sort()).toEqual([
          "notes",
          "style",
        ]);
        const before = yield* readState(options);
        expect((yield* run(runProfileApply(options, request))).plan.refused).toBe(true);
        expect(yield* readState(options)).toEqual(before);
        expect(
          (yield* run(runProfileApply(options, { ...request, force: true }))).plan.refused,
        ).toBe(false);
        expect((yield* fs.readDirectory(path.join(project, ".agents/skills"))).sort()).toEqual([
          "review",
          "style",
        ]);
      }),
  );
  test.effect("refuses physical adapter escapes and shared user state, even with force", () =>
    Effect.gen(function* () {
      const { fs, path, root, home, project, options, request, run } = yield* fixture;
      const outside = path.join(root, "outside");
      yield* fs.makeDirectory(path.join(outside, "skills"), { recursive: true });
      yield* fs.symlink(outside, path.join(project, ".agents"));
      const before = yield* readState(options);
      expect((yield* run(runProfileApply(options, { ...request, force: true }))).plan.refused).toBe(
        true,
      );
      expect(yield* readState(options)).toEqual(before);
      expect(yield* fs.readDirectory(path.join(outside, "skills"))).toEqual([]);
      const otherHome = path.join(root, "other-home");
      yield* fs.makeDirectory(otherHome);
      expect(
        (yield* run(
          runProfileApply(
            { ...options, homeDirectory: otherHome },
            {
              ...request,
              namespace: { _tag: "user" },
              targetRoots: [],
              targetHome: otherHome,
              force: true,
            },
          ),
        )).plan.refused,
      ).toBe(true);
      const user = {
        ...request,
        namespace: { _tag: "user" } as const,
        targetRoots: [],
        targetHome: home,
      };
      expect((yield* run(runProfileApply(options, user))).plan.refused).toBe(false);
      expect((yield* fs.readDirectory(path.join(home, ".agents/skills"))).sort()).toEqual([
        "review",
        "style",
      ]);
      yield* run(
        runSyncCommand(
          { ...options, homeDirectory: otherHome },
          {
            apply: true,
            cwd: root,
            includeOptional: false,
            noDocs: false,
            selector: { _tag: "user" },
          },
        ),
      );
      expect(yield* fs.exists(path.join(otherHome, ".agents"))).toBe(false);
    }),
  );
  test.effect("refuses missing linkage and delivery-name collisions before replacing intent", () =>
    Effect.gen(function* () {
      const { root, path, options, request, run, write } = yield* fixture;
      const before = yield* readState(options);
      yield* write(
        "source/ci.yaml",
        "version: 1\nname: ci\ndepends-on: [absent]\nmembers: [{name: review, source: absent}]\n",
      );
      expect((yield* run(runProfileApply(options, { ...request, force: true }))).plan.refused).toBe(
        true,
      );
      expect(yield* readState(options)).toEqual(before);
      yield* write("team/tack.yaml", "version: 1\nname: team\nskills: [{path: skills}]\n");
      yield* write("team/skills/review/SKILL.md", "---\nname: review\ndescription: Team\n---\n");
      yield* registerSource(options, { sourcePath: path.join(root, "team") });
      yield* write(
        "source/ci.yaml",
        "version: 1\nname: ci\ndepends-on: [team]\nmembers: [review, {name: review, source: team, kind: skill}]\n",
      );
      const registered = yield* readState(options);
      const collision = yield* run(runProfileApply(options, request));
      expect(collision.plan.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "profile-delivery-collision" })]),
      );
      expect(yield* readState(options)).toEqual(registered);
    }),
  );
  test.effect(
    "reports all resource roles, mounts docs and never evaluates a script or reader module",
    () =>
      Effect.gen(function* () {
        const { fs, path, project, options, request, run, write } = yield* fixture;
        yield* write(
          "source/tack.yaml",
          "version: 2\nname: tools\nskills: [{path: skills}]\ncommands: [{path: audit.md}]\ncontext: [{path: guide.md}]\nscripts: [{name: danger, path: danger.ts, description: Never execute}]\ndocs: [{name: handbook, path: docs}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
        );
        yield* write("source/audit.md", "Audit");
        yield* write("source/guide.md", "Guide");
        yield* write("source/danger.ts", "throw new Error('must not execute');");
        yield* write("source/docs/index.md", "# Guide");
        yield* write(
          "source/ci.yaml",
          "version: 1\nname: ci\nmembers: [review, audit, guide.md, danger, handbook]\n",
        );
        const result = yield* run(runProfileApply(options, request));
        expect(result.plan.refused).toBe(false);
        const notes = result.plan.delivery.notes.join("\n");
        expect(notes).toContain("cannot deliver command links");
        expect(notes).toContain("inspectable, no adapter link");
        expect(notes).toContain("explicit script run");
        expect(
          result.plan.sync?.docs
            .flatMap((plan) => plan.actions)
            .some((action) => action.action === "create"),
        ).toBe(true);
        expect(yield* fs.exists(path.join(project, ".tack/docs"))).toBe(true);
        const before = yield* readState(options);
        const refused = yield* run(
          runProfileApply(options, {
            ...request,
            namespace: { _tag: "user" },
            targetRoots: [],
            targetHome: options.homeDirectory,
          }),
        );
        expect(refused.plan.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "profile-docs-require-project" }),
          ]),
        );
        expect(yield* readState(options)).toEqual(before);
      }),
  );
  test.effect(
    "applies unforced to a fresh defaults-only project and sync retains only direct/required membership",
    () =>
      Effect.gen(function* () {
        const { fs, path, project, options, request, run, write } = yield* fixture;
        const result = yield* run(runProfileApply(options, request));
        expect(result.plan.refused).toBe(false);
        expect(result.applied).toBeDefined();
        expect((yield* fs.readDirectory(path.join(project, ".agents/skills"))).sort()).toEqual([
          "review",
          "style",
        ]);
        yield* write("source/skills/later/SKILL.md", "---\nname: later\ndescription: Later\n---\n");
        yield* run(
          runSyncCommand(options, {
            apply: true,
            cwd: project,
            includeOptional: true,
            noDocs: false,
            selector: { _tag: "project", projectName: "ci" },
          }),
        );
        expect((yield* fs.readDirectory(path.join(project, ".agents/skills"))).sort()).toEqual([
          "review",
          "style",
        ]);
        // The fixed application is read back from the one state format.
        const applied = yield* readState(options);
        expect(applied.format).toBe(1);
        expect(applied.data.profileApplications).toHaveLength(1);
        expect((yield* run(runProfileApply(options, request))).plan.refused).toBe(true);
      }),
  );
  test.effect(
    "refuses exclusions and incomplete roots before writes, while force replaces only the complete project",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, project, options, request, run, sourceId } = yield* fixture;
        yield* mutateState(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: state.data.projects.map((entry) => ({
              ...entry,
              choices: [
                {
                  address: { kind: "skill", name: "review", sourceRegistrationId: sourceId },
                  decision: "exclude",
                },
              ],
            })),
          },
        }));
        const before = yield* readState(options);
        expect((yield* run(runProfileApply(options, request))).plan.refused).toBe(true);
        expect(yield* readState(options)).toEqual(before);
        yield* fs.makeDirectory(path.join(root, "second"));
        yield* mutateState(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: state.data.projects.map((entry) => ({
              ...entry,
              roots: [...entry.roots, path.join(root, "second")],
            })),
          },
        }));
        const shared = yield* readState(options);
        expect(
          (yield* run(runProfileApply(options, { ...request, force: true }))).plan.refused,
        ).toBe(true);
        expect(yield* readState(options)).toEqual(shared);
        expect(
          (yield* run(
            runProfileApply(options, {
              ...request,
              force: true,
              targetRoots: [project, path.join(root, "second")],
            }),
          )).plan.refused,
        ).toBe(false);
        expect((yield* readState(options)).data.projects[0]?.choices ?? []).toEqual([]);
      }),
  );
  test.effect(
    "protects foreign files, retains incomplete/empty intent and refuses ignored daily picks",
    () =>
      Effect.gen(function* () {
        const { fs, path, project, options, request, run, sourceId, write } = yield* fixture;
        yield* write("project/.agents/skills/review", "foreign");
        const applied = yield* run(runProfileApply(options, request));
        expect(applied.plan.refused).toBe(false);
        expect(yield* fs.readFileString(path.join(project, ".agents/skills/review"))).toBe(
          "foreign",
        );
        expect((yield* run(runProfileApply(options, request))).plan.refused).toBe(true);
        const before = yield* readState(options);
        const failure = yield* Effect.flip(
          withStateCheckpointWriter(options, (writer) =>
            setSkillChoice(writer, {
              namespace: request.namespace,
              address: { kind: "skill", name: "notes", sourceRegistrationId: sourceId },
              decision: "include",
            }),
          ),
        );
        expect(failure).toMatchObject({ code: "profile-fixed-context" });
        expect(yield* readState(options)).toEqual(before);
        yield* write("source/ci.yaml", "version: 1\nname: ci\nmembers: []\n");
        expect(
          (yield* run(runProfileApply(options, { ...request, force: true }))).plan.refused,
        ).toBe(false);
        expect((yield* run(runProfileApply(options, request))).plan.refused).toBe(true);
      }),
  );
});
