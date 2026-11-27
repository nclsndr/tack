import { inspectProjectsAt, selectTargetsAt } from "../../../test/support/snapshot-helpers.ts";
import {
  fakeGit,
  notARepositoryError,
  outsideRepositoryGit,
} from "../../../test/support/fake-git.ts";
import { faultyFileSystem, platformTestError } from "../../../test/support/faults.ts";
import { mutateStateFixture, withStateFixture } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { Git } from "../../services/git.ts";
import {
  bareSelectionRefusal,
  ProjectRegistrationConflictError,
  ProjectValidationError,
  ProjectRootOwnershipError,
  registerProject,
  resolveContainingRoot,
  TargetSelectionError,
} from "./project.ts";
import type { ManagedLinkTarget } from "../../domain/links/managed-link-schema.ts";
import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { readState, type StateOptions } from "../../services/state-store.ts";

/** Persists cleanup obligations at the given destinations, as earlier maintenance would. */
const persistPendingRemovals = (options: StateOptions, targets: ReadonlyArray<ManagedLinkTarget>) =>
  mutateStateFixture(options, (state) => ({
    ...state,
    data: {
      ...state.data,
      pendingRemovals: targets
        .map((target) => {
          const evidence = {
            adapter: "codex" as const,
            address: {
              kind: "skill" as const,
              name: "pending",
              sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
            },
            sourceDirectoryPath: "/source/skills/pending",
            sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
            target,
          };
          return {
            cause: "clean" as const,
            evidence,
          };
        })
        .sort((left, right) =>
          compareCodeUnits(
            managedLinkDestinationPath(left.evidence),
            managedLinkDestinationPath(right.evidence),
          ),
        ),
    },
  }));

it.layer(LiveTestLayer)("project registration and targeting", (projectIt) => {
  projectIt.effect("canonicalizes roots and rejects cross-project ownership", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const projectRoot = path.join(root, "project-root");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(projectRoot, { recursive: true });
        const git = fakeGit(anchor, [{ path: projectRoot }]);

        const first = yield* registerProject(options, {
          name: "first",
          repositoryCwd: projectRoot,
        }).pipe(Effect.provideService(Git, git));
        const stateBeforeConflict = yield* readState(options);
        const conflict = yield* Effect.flip(
          registerProject(options, { name: "second", repositoryCwd: projectRoot }).pipe(
            Effect.provideService(Git, git),
          ),
        );
        const stateAfterConflict = yield* readState(options);

        expect(first.alreadyRegistered).toBe(false);
        expect(first.project.roots).toEqual([yield* fileSystem.realPath(projectRoot)]);
        expect(conflict).toBeInstanceOf(ProjectRootOwnershipError);
        expect(stateAfterConflict).toEqual(stateBeforeConflict);

        const alternateRoot = path.join(root, "alternate-root");
        yield* fileSystem.makeDirectory(alternateRoot, { recursive: true });
        const sameNameConflict = yield* Effect.flip(
          registerProject(options, { name: "first", repositoryCwd: projectRoot }).pipe(
            Effect.provideService(Git, fakeGit(anchor, [{ path: alternateRoot }])),
          ),
        );

        expect(sameNameConflict).toBeInstanceOf(ProjectRegistrationConflictError);
      }),
    ),
  );

  projectIt.effect("collapses symlink aliases and skips no-op state rewrites", () =>
    withStateFixture(({ options, root, stateDirectory }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const projectRoot = path.join(root, "project-root");
        const anchorAlias = path.join(root, "anchor-alias");
        const rootAlias = path.join(root, "root-alias");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(projectRoot, { recursive: true });
        yield* fileSystem.symlink(anchor, anchorAlias);
        yield* fileSystem.symlink(projectRoot, rootAlias);

        const first = yield* registerProject(options, {
          name: "project",
          repositoryCwd: projectRoot,
        }).pipe(Effect.provideService(Git, fakeGit(anchor, [{ path: projectRoot }])));
        const statePath = path.join(stateDirectory, "state.json");
        const stateBeforeRepeat = yield* fileSystem.readFileString(statePath);
        const repeated = yield* registerProject(options, {
          name: "project",
          repositoryCwd: rootAlias,
        }).pipe(Effect.provideService(Git, fakeGit(anchorAlias, [{ path: rootAlias }])));
        const stateAfterRepeat = yield* fileSystem.readFileString(statePath);

        expect(repeated).toEqual({ alreadyRegistered: true, project: first.project, handMade: [] });
        expect(stateAfterRepeat).toBe(stateBeforeRepeat);
      }),
    ),
  );

  projectIt.effect(
    "reports the hand-made entries in every root's agent folders and leaves them in place",
    () =>
      withStateFixture(({ options, root }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const anchor = path.join(root, "anchor");
          const main = path.join(root, "main");
          const feature = path.join(root, "feature");
          const handMade = path.join(main, ".claude", "skills", "code-review");
          yield* fileSystem.makeDirectory(anchor, { recursive: true });
          yield* fileSystem.makeDirectory(handMade, { recursive: true });
          yield* fileSystem.makeDirectory(path.join(feature, ".claude", "skills"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(path.join(handMade, "SKILL.md"), "mine\n");
          yield* fileSystem.writeFileString(
            path.join(feature, ".claude", "skills", "notes.md"),
            "notes\n",
          );
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: { ...state.data, enabledAdapters: ["claude"] },
          }));
          const git = fakeGit(anchor, [{ path: main }, { path: feature }]);

          const first = yield* registerProject(options, {
            name: "app",
            repositoryCwd: main,
          }).pipe(Effect.provideService(Git, git));
          const repeated = yield* registerProject(options, {
            name: "app",
            repositoryCwd: main,
          }).pipe(Effect.provideService(Git, git));

          const expected = [
            {
              adapter: "claude",
              kind: "skill",
              path: yield* fileSystem.realPath(path.join(feature, ".claude", "skills", "notes.md")),
              entry: "file",
            },
            {
              adapter: "claude",
              kind: "skill",
              path: yield* fileSystem.realPath(handMade),
              entry: "directory",
            },
          ];
          expect(first.handMade).toEqual(expected);
          expect(repeated.alreadyRegistered).toBe(true);
          expect(repeated.handMade).toEqual(expected);
          expect(yield* fileSystem.readFileString(path.join(handMade, "SKILL.md"))).toBe("mine\n");
        }),
      ),
  );

  projectIt.effect("reports no hand-made entry when no adapter is enabled", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRoot = path.join(root, "project-root");
        yield* fileSystem.makeDirectory(path.join(projectRoot, ".claude", "skills", "mine"), {
          recursive: true,
        });

        const registered = yield* registerProject(options, {
          name: "project",
          repositoryCwd: projectRoot,
        }).pipe(Effect.provideService(Git, fakeGit(root, [{ path: projectRoot }])));

        expect(registered.handMade).toEqual([]);
      }),
    ),
  );

  projectIt.effect("keeps nested intent out of registration and inspection results", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRoot = path.join(root, "project-root");
        yield* fileSystem.makeDirectory(projectRoot, { recursive: true });
        const git = fakeGit(root, [{ path: projectRoot }]);
        yield* registerProject(options, { name: "project", repositoryCwd: projectRoot }).pipe(
          Effect.provideService(Git, git),
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: (state.data.projects ?? []).map((project) => ({
              ...project,
              choices: [
                {
                  address: {
                    kind: "skill" as const,
                    name: "guide",
                    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
                  },
                  decision: "exclude" as const,
                },
              ],
              docs: { attachments: [] },
            })),
          },
        }));
        const repeated = yield* registerProject(options, {
          name: "project",
          repositoryCwd: projectRoot,
        }).pipe(Effect.provideService(Git, git));
        const inspections = yield* inspectProjectsAt(options);
        expect((yield* readState(options)).data.projects?.[0]).toHaveProperty("choices");
        expect(repeated.project).not.toHaveProperty("choices");
        expect(repeated.project).not.toHaveProperty("docs");
        expect(inspections[0]?.project).not.toHaveProperty("choices");
        expect(inspections[0]?.project).not.toHaveProperty("docs");
      }),
    ),
  );

  projectIt.effect("rejects invalid names and projects without reachable roots", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const projectRoot = path.join(root, "project-root");
        const fileRoot = path.join(root, "file-root");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(projectRoot, { recursive: true });
        yield* fileSystem.writeFileString(fileRoot, "not a directory");

        const invalidName = yield* Effect.flip(
          registerProject(options, {
            name: "not a project",
            repositoryCwd: projectRoot,
          }).pipe(Effect.provideService(Git, fakeGit(anchor, [{ path: projectRoot }]))),
        );
        const noRoots = yield* Effect.flip(
          registerProject(options, { name: "empty", repositoryCwd: projectRoot }).pipe(
            Effect.provideService(Git, fakeGit(anchor, [])),
          ),
        );
        const fileRootError = yield* Effect.flip(
          registerProject(options, { name: "file-root", repositoryCwd: projectRoot }).pipe(
            Effect.provideService(Git, fakeGit(anchor, [{ path: fileRoot }])),
          ),
        );

        expect(invalidName).toBeInstanceOf(ProjectValidationError);
        expect(noRoots).toMatchObject({ code: "no-worktree-roots" });
        expect(fileRootError).toMatchObject({ code: "root-not-directory" });
      }),
    ),
  );

  projectIt.effect("distinguishes missing and non-directory registration paths", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const repositoryRoot = path.join(root, "repository");
        const filePath = path.join(root, "file");
        const missingRepository = path.join(root, "missing-repository");
        const missingAnchor = path.join(root, "missing-anchor");
        const fileAnchor = path.join(root, "file-anchor");
        const missingRoot = path.join(root, "missing-root");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(repositoryRoot, { recursive: true });
        yield* fileSystem.writeFileString(filePath, "file");
        yield* fileSystem.writeFileString(fileAnchor, "file");

        const repositoryMissing = yield* Effect.flip(
          registerProject(options, {
            name: "repository-missing",
            repositoryCwd: missingRepository,
          }).pipe(Effect.provideService(Git, fakeGit(anchor, [{ path: repositoryRoot }]))),
        );
        const repositoryNotDirectory = yield* Effect.flip(
          registerProject(options, { name: "repository-file", repositoryCwd: filePath }).pipe(
            Effect.provideService(Git, fakeGit(anchor, [{ path: repositoryRoot }])),
          ),
        );
        const anchorMissing = yield* Effect.flip(
          registerProject(options, { name: "anchor-missing", repositoryCwd: repositoryRoot }).pipe(
            Effect.provideService(Git, fakeGit(missingAnchor, [{ path: repositoryRoot }])),
          ),
        );
        const anchorNotDirectory = yield* Effect.flip(
          registerProject(options, { name: "anchor-file", repositoryCwd: repositoryRoot }).pipe(
            Effect.provideService(Git, fakeGit(fileAnchor, [{ path: repositoryRoot }])),
          ),
        );
        const rootMissing = yield* Effect.flip(
          registerProject(options, { name: "root-missing", repositoryCwd: repositoryRoot }).pipe(
            Effect.provideService(Git, fakeGit(anchor, [{ path: missingRoot }])),
          ),
        );

        expect(repositoryMissing).toMatchObject({ code: "repository-cwd-missing" });
        expect(repositoryNotDirectory).toMatchObject({ code: "repository-cwd-not-directory" });
        expect(anchorMissing).toMatchObject({ code: "git-anchor-missing" });
        expect(anchorNotDirectory).toMatchObject({ code: "git-anchor-not-directory" });
        expect(rootMissing).toMatchObject({ code: "root-missing" });
      }),
    ),
  );

  projectIt.effect("maps unexpected filesystem failures during registration", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const projectRoot = path.join(root, "project-root");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(projectRoot, { recursive: true });
        const canonicalAnchor = yield* fileSystem.realPath(anchor);

        const failingRealPath = yield* faultyFileSystem({
          realPath: (candidate) =>
            candidate === projectRoot ? platformTestError("realPath", candidate) : undefined,
        });
        const realPathError = yield* Effect.flip(
          provideTestFileSystem(
            registerProject(options, { name: "real-path", repositoryCwd: projectRoot }),
            failingRealPath,
          ).pipe(Effect.provideService(Git, fakeGit(anchor, [{ path: projectRoot }]))),
        );

        const failingStat = yield* faultyFileSystem({
          stat: (candidate) =>
            candidate === canonicalAnchor ? platformTestError("stat", candidate) : undefined,
        });
        const statError = yield* Effect.flip(
          provideTestFileSystem(
            registerProject(options, { name: "stat", repositoryCwd: projectRoot }),
            failingStat,
          ).pipe(Effect.provideService(Git, fakeGit(anchor, [{ path: projectRoot }]))),
        );

        expect(realPathError).toMatchObject({
          code: "project-access-failed",
          operation: "resolve project directory",
          path: projectRoot,
        });
        expect(statError).toMatchObject({
          code: "project-access-failed",
          operation: "inspect project directory",
          path: canonicalAnchor,
        });
      }),
    ),
  );

  projectIt.effect("orders distinct project namespaces by code unit", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const firstRoot = path.join(root, "first");
        const secondRoot = path.join(root, "second");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(firstRoot, { recursive: true });
        yield* fileSystem.makeDirectory(secondRoot, { recursive: true });

        yield* registerProject(options, { name: "zeta", repositoryCwd: firstRoot }).pipe(
          Effect.provideService(Git, fakeGit(anchor, [{ path: firstRoot }])),
        );
        yield* registerProject(options, { name: "alpha", repositoryCwd: secondRoot }).pipe(
          Effect.provideService(Git, fakeGit(anchor, [{ path: secondRoot }])),
        );
        const state = yield* readState(options);

        expect(state.data.projects?.map((project) => project.name)).toEqual(["alpha", "zeta"]);
      }),
    ),
  );

  projectIt.effect("retains missing roots and selects the broad or narrow target set", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const firstRoot = path.join(root, "first");
        const secondRoot = path.join(root, "second");
        const outside = path.join(root, "outside");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(firstRoot, { recursive: true });
        yield* fileSystem.makeDirectory(secondRoot, { recursive: true });
        yield* fileSystem.makeDirectory(outside, { recursive: true });
        const canonicalSecondRoot = yield* fileSystem.realPath(secondRoot);
        const git = fakeGit(anchor, [{ path: firstRoot }, { path: secondRoot }]);
        yield* registerProject(options, {
          name: "project",
          repositoryCwd: firstRoot,
        }).pipe(Effect.provideService(Git, git));
        yield* fileSystem.remove(secondRoot, { recursive: true });

        const inspection = yield* inspectProjectsAt(options);
        const projectSelection = yield* selectTargetsAt(options, {
          cwd: outside,
          selector: { _tag: "project", projectName: "project" },
          userTarget: path.join(root, "user-home"),
        });
        yield* persistPendingRemovals(options, [
          { _tag: "user", canonicalPath: path.join(root, "pending-user") },
        ]);
        const bareSelection = yield* selectTargetsAt(options, {
          cwd: firstRoot,
          selector: { _tag: "bare" },
          userTarget: path.join(root, "user-home"),
        });
        const allSelection = yield* selectTargetsAt(options, {
          cwd: outside,
          selector: { _tag: "all" },
          userTarget: path.join(root, "user-home"),
        });

        expect(inspection[0]?.roots).toMatchObject([
          { root: yield* fileSystem.realPath(firstRoot), status: "active" },
          { root: canonicalSecondRoot, status: "stale" },
        ]);
        expect(projectSelection.targets).toEqual([
          {
            _tag: "project-root",
            canonicalPath: yield* fileSystem.realPath(firstRoot),
            projectName: "project",
          },
        ]);
        expect(projectSelection.staleRoots).toHaveLength(1);
        expect(bareSelection.targets.map((target) => target._tag)).toEqual(["project-root"]);
        expect(allSelection.targets.map((target) => target._tag)).toEqual([
          "project-root",
          "user",
          "pending-removal",
        ]);
      }),
    ),
  );

  projectIt.effect("isolates user selectors and rejects bare selection outside roots", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const projectRoot = path.join(root, "project");
        const outside = path.join(root, "outside");
        const userHome = path.join(root, "user-home");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(projectRoot, { recursive: true });
        yield* fileSystem.makeDirectory(outside, { recursive: true });
        const git = fakeGit(anchor, [{ path: projectRoot }]);
        yield* registerProject(options, {
          name: "project",
          repositoryCwd: projectRoot,
        }).pipe(Effect.provideService(Git, git));

        yield* persistPendingRemovals(options, [
          {
            _tag: "project-root",
            canonicalPath: path.join(root, "pending-project"),
            projectName: "project",
          },
          {
            _tag: "project-root",
            canonicalPath: path.join(root, "pending-other"),
            projectName: "other",
          },
          { _tag: "user", canonicalPath: path.join(root, "pending-user") },
        ]);
        const project = yield* selectTargetsAt(options, {
          cwd: outside,
          selector: { _tag: "project", projectName: "project" },
          userTarget: userHome,
        });
        const user = yield* selectTargetsAt(options, {
          cwd: outside,
          selector: { _tag: "user" },
          userTarget: userHome,
        });
        const pendingOnly = yield* selectTargetsAt(options, {
          cwd: outside,
          selector: { _tag: "project", projectName: "other" },
          userTarget: userHome,
        });
        const bareError = yield* Effect.flip(
          selectTargetsAt(options, {
            cwd: outside,
            selector: { _tag: "bare" },
            userTarget: userHome,
          }),
        );
        const missingProject = yield* Effect.flip(
          selectTargetsAt(options, {
            cwd: outside,
            selector: { _tag: "project", projectName: "missing" },
            userTarget: userHome,
          }),
        );

        expect(project.targets.map((target) => target._tag)).toEqual([
          "project-root",
          "pending-removal",
        ]);
        expect(project.targets[1]).toMatchObject({
          canonicalPath: path.join(root, "pending-project"),
        });
        expect(user.targets).toEqual([
          { _tag: "user", canonicalPath: userHome },
          expect.objectContaining({
            _tag: "pending-removal",
            canonicalPath: path.join(root, "pending-user"),
          }),
        ]);
        expect(pendingOnly.targets).toEqual([
          expect.objectContaining({
            _tag: "pending-removal",
            canonicalPath: path.join(root, "pending-other"),
          }),
        ]);
        expect([project.resolved, user.resolved]).toEqual([
          { _tag: "project", projectName: "project" },
          { _tag: "user" },
        ]);
        expect(bareError).toBeInstanceOf(TargetSelectionError);
        expect(bareError).toMatchObject({ code: "bare-target-requires-registered-root" });
        expect(missingProject).toMatchObject({ code: "project-not-found", projectName: "missing" });
      }),
    ),
  );

  projectIt.effect("distinguishes missing anchors from unhealthy roots", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const activeRoot = path.join(root, "active");
        const fileRoot = path.join(root, "file-root");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(activeRoot, { recursive: true });
        yield* fileSystem.makeDirectory(fileRoot, { recursive: true });
        const git = fakeGit(anchor, [{ path: activeRoot }, { path: fileRoot }]);
        yield* registerProject(options, {
          name: "project",
          repositoryCwd: activeRoot,
        }).pipe(Effect.provideService(Git, git));
        yield* fileSystem.remove(anchor, { recursive: true });
        yield* fileSystem.remove(fileRoot, { recursive: true });
        yield* fileSystem.writeFileString(fileRoot, "replacement");

        const inspection = yield* inspectProjectsAt(options);
        const selection = yield* selectTargetsAt(options, {
          cwd: activeRoot,
          selector: { _tag: "bare" },
          userTarget: path.join(root, "user-home"),
        });
        const projectSelection = yield* selectTargetsAt(options, {
          cwd: path.join(root, "outside"),
          selector: { _tag: "project", projectName: "project" },
          userTarget: path.join(root, "user-home"),
        });

        expect(inspection[0]?.anchor).toMatchObject({
          issue: { code: "anchor-missing" },
          status: "unhealthy",
        });
        expect(inspection[0]?.roots).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              issue: expect.objectContaining({ code: "root-not-directory" }),
              root: yield* fileSystem.realPath(fileRoot),
              status: "unhealthy",
            }),
          ]),
        );
        expect(selection.unhealthyRoots).toContainEqual({
          canonicalPath: yield* fileSystem.realPath(fileRoot),
          code: "root-not-directory",
          message: "The registered project path is no longer a directory.",
          projectName: "project",
        });
        expect(projectSelection.unhealthyRoots).toEqual(selection.unhealthyRoots);
        expect(selection.targets).toContainEqual({
          _tag: "project-root",
          canonicalPath: yield* fileSystem.realPath(activeRoot),
          projectName: "project",
        });
      }),
    ),
  );

  projectIt.effect("avoids unrelated observations for narrow selectors", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const selectedAnchor = path.join(root, "selected-anchor");
        const selectedRoot = path.join(root, "selected-root");
        const unrelatedAnchor = path.join(root, "unrelated-anchor");
        const unrelatedRoot = path.join(root, "unrelated-root");
        yield* Effect.forEach(
          [selectedAnchor, selectedRoot, unrelatedAnchor, unrelatedRoot],
          (directory) => fileSystem.makeDirectory(directory, { recursive: true }),
        );
        const canonicalSelectedAnchor = yield* fileSystem.realPath(selectedAnchor);
        const canonicalSelectedRoot = yield* fileSystem.realPath(selectedRoot);
        const canonicalUnrelatedAnchor = yield* fileSystem.realPath(unrelatedAnchor);
        const canonicalUnrelatedRoot = yield* fileSystem.realPath(unrelatedRoot);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              {
                gitCommonDirectory: canonicalSelectedAnchor,
                name: "selected",
                roots: [canonicalSelectedRoot],
              },
              {
                gitCommonDirectory: canonicalUnrelatedAnchor,
                name: "unrelated",
                roots: [canonicalUnrelatedRoot],
              },
            ],
          },
        }));
        const failUnrelatedObservation = FileSystem.makeNoop({
          ...fileSystem,
          realPath: (candidate) =>
            candidate === canonicalUnrelatedAnchor || candidate === canonicalUnrelatedRoot
              ? Effect.die("unrelated project observation")
              : fileSystem.realPath(candidate),
        });
        const project = yield* selectTargetsAt(options, {
          cwd: root,
          selector: { _tag: "project", projectName: "selected" },
        }).pipe(Effect.provideService(FileSystem.FileSystem, failUnrelatedObservation));
        const user = yield* selectTargetsAt(options, {
          cwd: root,
          selector: { _tag: "user" },
          userTarget: path.join(root, "user"),
        }).pipe(Effect.provideService(FileSystem.FileSystem, failUnrelatedObservation));

        expect(project.targets).toEqual([
          {
            _tag: "project-root",
            canonicalPath: canonicalSelectedRoot,
            projectName: "selected",
          },
        ]);
        expect(user.targets).toEqual([{ _tag: "user", canonicalPath: path.join(root, "user") }]);
      }),
    ),
  );

  projectIt.effect("retains canonical-location health diagnostics and maps cwd failures", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const projectRoot = path.join(root, "project-root");
        const anchorAlias = path.join(root, "anchor-alias");
        const rootAlias = path.join(root, "root-alias");
        const missingCwd = path.join(root, "missing-cwd");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(projectRoot, { recursive: true });
        yield* fileSystem.symlink(anchor, anchorAlias);
        yield* fileSystem.symlink(projectRoot, rootAlias);

        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              {
                gitCommonDirectory: anchorAlias,
                name: "aliased",
                roots: [rootAlias],
              },
            ],
          },
        }));

        const inspection = yield* inspectProjectsAt(options);
        const missingCwdError = yield* Effect.flip(
          selectTargetsAt(options, {
            cwd: missingCwd,
            selector: { _tag: "bare" },
          }),
        );
        const failingFileSystem = yield* faultyFileSystem({
          realPath: (candidate) =>
            candidate === path.resolve(root, "storage-cwd")
              ? platformTestError("realPath", candidate)
              : undefined,
        });
        const storageCwd = path.join(root, "storage-cwd");
        yield* fileSystem.makeDirectory(storageCwd, { recursive: true });
        const storageError = yield* Effect.flip(
          provideTestFileSystem(
            selectTargetsAt(options, {
              cwd: storageCwd,
              selector: { _tag: "bare" },
            }),
            failingFileSystem,
          ),
        );

        expect(inspection[0]).toMatchObject({
          anchor: { issue: { code: "anchor-location-changed" }, status: "unhealthy" },
          roots: [
            {
              issue: { code: "root-location-changed" },
              status: "unhealthy",
            },
          ],
        });
        const inaccessibleRoot = yield* provideTestFileSystem(
          inspectProjectsAt(options),
          yield* faultyFileSystem({
            realPath: (candidate) =>
              candidate === rootAlias ? platformTestError("realPath", candidate) : undefined,
          }),
        );

        expect(inaccessibleRoot[0]?.roots).toMatchObject([
          { issue: { code: "root-access-failed" }, root: rootAlias, status: "unhealthy" },
        ]);
        expect(missingCwdError).toMatchObject({
          code: "current-directory-unavailable",
          path: missingCwd,
        });
        expect(storageError).toMatchObject({
          code: "project-access-failed",
          operation: "resolve project directory",
          path: storageCwd,
        });
      }),
    ),
  );

  projectIt.effect("chooses the deepest nested active root for bare authorization", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const outer = path.join(root, "outer");
        const inner = path.join(outer, "inner");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(inner, { recursive: true });
        const git = fakeGit(anchor, [{ path: outer }, { path: inner }]);
        yield* registerProject(options, {
          name: "nested",
          repositoryCwd: outer,
        }).pipe(Effect.provideService(Git, git));

        const selection = yield* selectTargetsAt(options, {
          cwd: inner,
          selector: { _tag: "bare" },
          userTarget: path.join(root, "user-home"),
        });

        expect(selection.containingRoot).toEqual({
          projectName: "nested",
          root: yield* fileSystem.realPath(inner),
        });
        // The requested selector stays bare; the resolved one names the project it chose.
        expect(selection.selector).toEqual({ _tag: "bare" });
        expect(selection.resolved).toEqual({ _tag: "project", projectName: "nested" });
        expect(selection.targets).toHaveLength(2);
      }),
    ),
  );

  projectIt.effect("resolves a cwd to the deepest root of an active project", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const canonicalRoot = yield* fileSystem.realPath(root);
        const outer = path.join(canonicalRoot, "outer");
        const inner = path.join(outer, "inner");
        const deeper = path.join(inner, "deeper");
        const retired = path.join(deeper, "retired");
        const outside = path.join(canonicalRoot, "outside");
        const alias = path.join(canonicalRoot, "alias");
        yield* fileSystem.makeDirectory(retired, { recursive: true });
        yield* fileSystem.makeDirectory(outside, { recursive: true });
        yield* fileSystem.symlink(deeper, alias);
        // "a-outer" sorts first by name, so a first-match scan would claim the inner root.
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              { gitCommonDirectory: path.join(outer, ".git"), name: "a-outer", roots: [outer] },
              { gitCommonDirectory: path.join(inner, ".git"), name: "b-inner", roots: [inner] },
              {
                gitCommonDirectory: path.join(retired, ".git"),
                name: "c-retired",
                removingRoots: [retired],
                roots: [],
              },
            ],
          },
        }));
        const state = yield* readState(options);

        expect(yield* resolveContainingRoot(state, outer)).toEqual({
          canonicalCwd: outer,
          containing: { projectName: "a-outer", root: outer },
        });
        expect(yield* resolveContainingRoot(state, alias)).toEqual({
          canonicalCwd: deeper,
          containing: { projectName: "b-inner", root: inner },
        });
        expect(yield* resolveContainingRoot(state, retired)).toEqual({
          canonicalCwd: retired,
          containing: { projectName: "b-inner", root: inner },
        });
        expect(yield* resolveContainingRoot(state, deeper, { projectName: "a-outer" })).toEqual({
          canonicalCwd: deeper,
          containing: { projectName: "a-outer", root: outer },
        });
        expect(yield* resolveContainingRoot(state, outside)).toEqual({ canonicalCwd: outside });
        expect(
          yield* Effect.flip(resolveContainingRoot(state, path.join(canonicalRoot, "missing"))),
        ).toMatchObject({ _tag: "TargetSelectionError", code: "current-directory-unavailable" });
      }),
    ),
  );
});

it.layer(LiveTestLayer)("project registration outside a repository", (outsideIt) => {
  outsideIt.effect.each([
    {
      case: "outside any repository",
      stderr: "fatal: not a git repository\n",
      tag: "ProjectValidationError",
    },
    {
      case: "a repository Git refuses",
      stderr: "fatal: detected dubious ownership in repository at '/x'\n",
      tag: "GitCommandError",
    },
  ])("reports $case as $tag", ({ stderr, tag }) =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const git = {
          ...outsideRepositoryGit,
          resolveCommonDirectory: (cwd: string) =>
            Effect.fail(notARepositoryError(cwd, ["rev-parse", "--git-common-dir"], stderr)),
        };
        const error = yield* Effect.flip(
          registerProject(options, { name: "loose", repositoryCwd: root }).pipe(
            Effect.provideService(Git, git),
          ),
        );
        expect(error._tag).toBe(tag);
        if (error._tag === "ProjectValidationError")
          expect(error).toMatchObject({
            code: "repository-cwd-not-in-git",
            path: root,
            next: [["tack", "project", "add", "loose", "--repository-cwd", "PATH"]],
          });
      }),
    ),
  );
});

it.each([
  {
    accepts: ["project", "user", "all"] as const,
    choose: "Choose --project NAME, --user or --all.",
  },
  { accepts: ["project", "all"] as const, choose: "Choose --project NAME or --all." },
  { accepts: ["project"] as const, choose: "Choose --project NAME." },
])("refuses a bare selector by naming exactly the flags $accepts", ({ accepts, choose }) => {
  expect(bareSelectionRefusal(accepts, "/outside")).toEqual(
    new TargetSelectionError({
      code: "bare-target-requires-registered-root",
      message: `This directory is not inside a registered project. ${choose}`,
      path: "/outside",
    }),
  );
});

it("names the root being removed that contains the refused directory", () => {
  expect(
    bareSelectionRefusal(["project"], "/old/nested", { projectName: "gone", root: "/old" }),
  ).toMatchObject({ path: "/old/nested", projectName: "gone", root: "/old" });
});
