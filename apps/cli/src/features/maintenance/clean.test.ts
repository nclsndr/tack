import { managedLinksOf, pendingRemovalsOf } from "../../domain/links/link-record-schema.ts";
import { allSkillChoices } from "../../domain/state/state-intent.ts";
import {
  mutateStateFixture,
  projectRecords,
  withStateFixture,
  evidenceFor,
  setupLink,
  targetProject,
  targetUser,
  fixtureSourceId,
} from "../../../test/support/state-fixture.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { cleanManagedLinks, retrySelectedPendingRemovals } from "./selected-removal.ts";
import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import { TargetSelectionError } from "../projects/project.ts";
import { readState } from "../../services/state-store.ts";

const compareCodeUnits = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const setupProject = Effect.fnUntraced(function* (
  root: string,
  name = "project",
  rootNames: ReadonlyArray<string> = ["project-root"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitCommonDirectory = path.join(root, `${name}-git-common`);
  yield* fileSystem.makeDirectory(gitCommonDirectory, { recursive: true });
  const roots = yield* Effect.forEach(rootNames, (rootName) =>
    Effect.gen(function* () {
      const rootPath = path.join(root, rootName);
      yield* fileSystem.makeDirectory(rootPath, { recursive: true });
      return yield* fileSystem.realPath(rootPath);
    }),
  );
  return {
    gitCommonDirectory: yield* fileSystem.realPath(gitCommonDirectory),
    name,
    roots: [...roots].sort(compareCodeUnits),
  };
});

it.layer(LiveTestLayer)("clean managed links", (cleanIt) => {
  cleanIt.effect(
    "defaults to dry run and applies only verified project links without changing configuration",
    () =>
      withStateFixture(({ options, root, stateDirectory }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* setupProject(root, "project", ["root-b", "root-a"]);
          const [firstRoot, secondRoot] = project.roots;
          if (firstRoot === undefined || secondRoot === undefined) {
            throw new Error("Expected two project roots.");
          }
          const userRoot = options.homeDirectory;
          yield* fileSystem.makeDirectory(userRoot, { recursive: true });
          const sourceRoot = path.join(root, "source");
          const sourceMarker = path.join(sourceRoot, "operator-content.txt");
          yield* fileSystem.makeDirectory(sourceRoot, { recursive: true });
          yield* fileSystem.writeFileString(sourceMarker, "keep-source");
          const canonicalSourceRoot = yield* fileSystem.realPath(sourceRoot);
          const firstEvidence = evidenceFor(
            "codex",
            targetProject("project", firstRoot),
            path.join(canonicalSourceRoot, "first"),
            "alpha",
          );
          const disabledAdapterEvidence = evidenceFor(
            "cursor",
            targetProject("project", secondRoot),
            path.join(canonicalSourceRoot, "second"),
            "beta",
          );
          const blockedEvidence = evidenceFor(
            "cursor",
            targetProject("project", firstRoot),
            path.join(canonicalSourceRoot, "blocked"),
            "gamma",
          );
          const userEvidence = evidenceFor(
            "codex",
            targetUser(userRoot),
            path.join(canonicalSourceRoot, "user"),
            "delta",
          );
          const firstDestination = yield* setupLink(firstEvidence);
          const disabledAdapterDestination = yield* setupLink(disabledAdapterEvidence);
          const userDestination = yield* setupLink(userEvidence);
          yield* fileSystem.makeDirectory(blockedEvidence.sourceDirectoryPath, { recursive: true });
          const blockedDestination = managedLinkDestinationPath(blockedEvidence);
          yield* fileSystem.makeDirectory(path.dirname(blockedDestination), { recursive: true });
          yield* fileSystem.writeFileString(blockedDestination, "foreign");
          const choices = [
            {
              address: {
                kind: "skill" as const,
                name: "alpha",
                sourceRegistrationId: fixtureSourceId,
              },
              decision: "include" as const,
              namespace: { _tag: "project" as const, projectName: "project" },
            },
          ];
          const sources = [
            {
              canonicalPath: canonicalSourceRoot,
              id: fixtureSourceId,
            },
          ];
          yield* fileSystem.writeFileString(path.join(stateDirectory, ".env"), "TOKEN=operator\n");
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              choices,
              enabledAdapters: ["codex"],
              agentLinks: [firstEvidence, disabledAdapterEvidence, blockedEvidence, userEvidence],
              projects: [project],
              sources,
            },
          }));

          const before = yield* readState(options);
          const dryRun = yield* cleanManagedLinks(options, {
            cwd: root,
            selector: { _tag: "project", projectName: "project" },
          });

          expect(dryRun.applied).toBeUndefined();
          expect(dryRun.plan).toMatchObject({
            cause: "clean",
            finalizeProject: false,
            scope: { _tag: "selected-targets" },
          });
          expect(dryRun.plan.actions.map((action) => action.destinationPath)).toEqual(
            [firstDestination, disabledAdapterDestination, blockedDestination].sort(
              compareCodeUnits,
            ),
          );
          expect(yield* readState(options)).toEqual(before);
          expect(yield* fileSystem.exists(firstDestination)).toBe(true);
          expect(yield* fileSystem.exists(disabledAdapterDestination)).toBe(true);

          const applied = yield* cleanManagedLinks(options, {
            apply: true,
            cwd: root,
            selector: { _tag: "project", projectName: "project" },
          });
          const after = yield* readState(options);

          expect(applied.plan).toEqual(dryRun.plan);
          expect(applied.applied?.finalizedProject).toBe(false);
          expect(applied.applied?.actions.map((outcome) => outcome._tag)).toEqual([
            "applied",
            "skipped",
            "applied",
          ]);
          expect(after.data.projects).toEqual(before.data.projects);
          expect(allSkillChoices(after)).toEqual(allSkillChoices(before));
          expect(after.data.enabledAdapters).toEqual(before.data.enabledAdapters);
          expect(after.data.sources).toEqual(before.data.sources);
          expect(managedLinksOf(after.data.links)).toEqual([userEvidence, blockedEvidence]);
          expect(pendingRemovalsOf(after.data.links)).toEqual([
            {
              cause: "clean",
              evidence: blockedEvidence,
              lastResult: {
                _tag: "blocked",
                message: "The destination is an existing file.",
              },
            },
          ]);
          expect(yield* fileSystem.exists(firstDestination)).toBe(false);
          expect(yield* fileSystem.exists(disabledAdapterDestination)).toBe(false);
          expect(yield* fileSystem.readFileString(blockedDestination)).toBe("foreign");
          expect(yield* fileSystem.exists(userDestination)).toBe(true);
          expect(yield* fileSystem.exists(path.dirname(firstDestination))).toBe(true);
          expect(yield* fileSystem.exists(path.dirname(disabledAdapterDestination))).toBe(true);
          expect(yield* fileSystem.readFileString(sourceMarker)).toBe("keep-source");
          expect(yield* fileSystem.readFileString(path.join(stateDirectory, ".env"))).toBe(
            "TOKEN=operator\n",
          );
        }),
      ),
  );

  cleanIt.effect("keeps user and project selectors isolated", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = yield* setupProject(root);
        const projectRoot = project.roots[0];
        if (projectRoot === undefined) {
          throw new Error("Expected one project root.");
        }
        yield* fileSystem.makeDirectory(options.homeDirectory, { recursive: true });
        const projectEvidence = evidenceFor(
          "codex",
          targetProject("project", projectRoot),
          path.join(root, "source-project"),
          "alpha",
        );
        const userEvidence = evidenceFor(
          "cursor",
          targetUser(options.homeDirectory),
          path.join(root, "source-user"),
          "beta",
        );
        const projectDestination = yield* setupLink(projectEvidence);
        const userDestination = yield* setupLink(userEvidence);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            agentLinks: [projectEvidence, userEvidence],
            projects: [project],
          },
        }));

        const result = yield* cleanManagedLinks(options, {
          apply: true,
          cwd: root,
          selector: { _tag: "user" },
        });

        expect(result.plan.scope).toEqual({
          _tag: "selected-targets",
          targets: [targetUser(options.homeDirectory)],
        });
        expect(yield* fileSystem.exists(userDestination)).toBe(false);
        expect(yield* fileSystem.exists(projectDestination)).toBe(true);
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([projectEvidence]);
      }),
    ),
  );

  cleanIt.effect("limits a bare clean from one active root to its project", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = yield* setupProject(root);
        const other = yield* setupProject(root, "other", ["other-root"]);
        const projectRoot = project.roots[0];
        const otherRoot = other.roots[0];
        if (projectRoot === undefined) {
          throw new Error("Expected one project root.");
        }
        if (otherRoot === undefined) throw new Error("Expected another project root.");
        yield* fileSystem.makeDirectory(options.homeDirectory, { recursive: true });
        const projectEvidence = evidenceFor(
          "codex",
          targetProject("project", projectRoot),
          path.join(root, "source-project"),
          "alpha",
        );
        const userEvidence = evidenceFor(
          "cursor",
          targetUser(options.homeDirectory),
          path.join(root, "source-user"),
          "beta",
        );
        const otherEvidence = evidenceFor(
          "codex",
          targetProject("other", otherRoot),
          path.join(root, "source-other"),
          "gamma",
        );
        const projectDestination = yield* setupLink(projectEvidence);
        const userDestination = yield* setupLink(userEvidence);
        const otherDestination = yield* setupLink(otherEvidence);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            agentLinks: [projectEvidence, userEvidence, otherEvidence],
            projects: [project, other],
          },
        }));

        const outside = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-clean-outside-",
        });
        const unauthorized = yield* Effect.flip(
          cleanManagedLinks(options, { cwd: outside, selector: { _tag: "bare" } }),
        );
        expect(unauthorized).toBeInstanceOf(TargetSelectionError);
        expect(unauthorized).toMatchObject({ code: "bare-target-requires-registered-root" });

        const nested = path.join(projectRoot, "nested");
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        const barePreview = yield* cleanManagedLinks(options, {
          cwd: nested,
          selector: { _tag: "bare" },
        });
        const namedPreview = yield* cleanManagedLinks(options, {
          cwd: outside,
          selector: { _tag: "project", projectName: "project" },
        });
        const { selection: bareEcho, ...barePlan } = barePreview.plan;
        const { selection: namedEcho, ...namedPlan } = namedPreview.plan;
        expect(bareEcho.containingRoot).toEqual({ projectName: "project", root: projectRoot });
        expect(namedEcho.selector).toEqual({ _tag: "project", projectName: "project" });
        expect(barePlan).toEqual(namedPlan);
        const result = yield* cleanManagedLinks(options, {
          apply: true,
          cwd: nested,
          selector: { _tag: "bare" },
        });

        expect(result.plan.actions).toHaveLength(1);
        expect(yield* fileSystem.exists(projectDestination)).toBe(false);
        expect(yield* fileSystem.exists(userDestination)).toBe(true);
        expect(yield* fileSystem.exists(otherDestination)).toBe(true);
      }),
    ),
  );

  cleanIt.effect(
    "settles a removing project's evidence without finalizing it, and a retry then finalizes it",
    () =>
      withStateFixture(({ options, root }) =>
        Effect.gen(function* () {
          const project = yield* setupProject(root);
          const handoffRoot = project.roots[0];
          if (handoffRoot === undefined) {
            throw new Error("Expected one handoff root.");
          }
          const path = yield* Path.Path;
          const evidence = evidenceFor(
            "codex",
            targetProject("project", handoffRoot),
            path.join(root, "source"),
            "alpha",
          );
          yield* setupLink(evidence);
          const removingProject = {
            ...project,
            removalIntent: "project" as const,
            removingRoots: [handoffRoot],
            roots: [],
          };
          const choices = [
            {
              address: evidence.address,
              decision: "include" as const,
              namespace: { _tag: "project" as const, projectName: "project" },
            },
          ];
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              choices,
              agentLinks: [evidence],
              pendingRemovals: [{ cause: "project-removal" as const, evidence }],
              projects: [removingProject],
            },
          }));
          const selector = { _tag: "project", projectName: "project" } as const;

          const cleaned = yield* cleanManagedLinks(options, { apply: true, cwd: root, selector });
          const state = yield* readState(options);

          expect(cleaned.applied?.finalizedProject).toBe(false);
          expect(projectRecords(state)).toEqual([removingProject]);
          expect(allSkillChoices(state)).toEqual(choices);
          expect(managedLinksOf(state.data.links)).toEqual([]);
          expect(pendingRemovalsOf(state.data.links)).toEqual([]);

          const retried = yield* retrySelectedPendingRemovals(options, {
            apply: true,
            cwd: root,
            selector,
          });
          const settled = yield* readState(options);

          expect(retried.plan.scope).toEqual(selector);
          expect(retried.applied?.finalizedProject).toBe(true);
          expect(settled.data.projects ?? []).toEqual([]);
          expect(allSkillChoices(settled) ?? []).toEqual([]);
        }),
      ),
  );

  cleanIt.effect("deduplicates a selected user target and its pending obligation", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(options.homeDirectory, { recursive: true });
        const evidence = evidenceFor(
          "cursor",
          targetUser(options.homeDirectory),
          path.join(root, "source"),
          "alpha",
        );
        const destinationPath = yield* setupLink(evidence);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            agentLinks: [evidence],
            pendingRemovals: [{ cause: "adapter-disable" as const, evidence }],
          },
        }));

        const result = yield* cleanManagedLinks(options, {
          apply: true,
          cwd: root,
          selector: { _tag: "user" },
        });

        expect(result.plan.scope).toEqual({
          _tag: "selected-targets",
          targets: [targetUser(options.homeDirectory)],
        });
        expect(yield* fileSystem.exists(destinationPath)).toBe(false);
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);
        expect(pendingRemovalsOf((yield* readState(options)).data.links)).toEqual([]);
      }),
    ),
  );
});
