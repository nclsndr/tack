import { selectTargetsAt } from "../../../test/support/snapshot-helpers.ts";
import { fakeGit } from "../../../test/support/fake-git.ts";
import {
  agentLink,
  managedLinksOf,
  pendingRemovalsOf,
} from "../../domain/links/link-record-schema.ts";
import type { ProfileApplication } from "../../domain/state/profile-application-schema.ts";
import { allChoices } from "../../domain/state/state-intent.ts";
import { mutateStateFixture, projectRecords } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Git, type GitService } from "../../services/git.ts";
import { sortAndDedupeBy, sortAndDedupeStrings } from "../../domain/identity/ordering.ts";
import { diffProjectRoots, type ProjectRootDiffInput } from "./project-refresh-diff.ts";
import { ProjectRefreshEvidenceError, runProjectRefreshCommand } from "./project-refresh.ts";
import type { ProjectRefreshScope } from "./project-refresh-schema.ts";
import { ProjectRecordSchema } from "../../domain/projects/project-schema.ts";
import { ProjectRootOwnershipError } from "../projects/project.ts";
import { projectLifecycle } from "../../domain/projects/project-schema.ts";
import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import { removeProjectRoot, retryPendingRemovals } from "../../../test/support/removal.ts";
import { initializeState, readState, type StateOptions } from "../../services/state-store.ts";
import { docsPendingRemovalsOf } from "../../domain/docs/docs-schema.ts";
import { attachDocs } from "../docs/docs.ts";
import { relocateSource } from "../sources/source.ts";
import {
  docsEvidence,
  docsRequest,
  syncDocsReport,
  withDocsWorld,
} from "../../../test/support/docs-world.ts";

const decodeProject = Schema.decodeUnknownSync(ProjectRecordSchema);

it("derives project lifecycle from active roots", () => {
  expect(
    decodeProject({
      gitCommonDirectory: "/repo/.git",
      name: "project",
      roots: ["/repo/main"],
    }),
  ).toEqual({
    gitCommonDirectory: "/repo/.git",
    name: "project",
    roots: ["/repo/main"],
  });

  expect(
    decodeProject({
      gitCommonDirectory: "/repo/.git",
      name: "project",
      removingRoots: ["/repo/main"],
      roots: [],
    }),
  ).toMatchObject({ removingRoots: ["/repo/main"], roots: [] });
  expect(
    projectLifecycle(
      decodeProject({
        gitCommonDirectory: "/repo/.git",
        name: "project",
        removingRoots: ["/repo/main"],
        roots: [],
      }),
    ),
  ).toBe("removing");
});

it("computes a deterministic root diff with cleanup handoff and final-root intent", () => {
  const input = {
    managedEvidenceRoots: ["/repo/old"],
    observedRoots: ["/repo/new", "/repo/new", "/repo/kept"],
    registeredRoots: ["/repo/kept", "/repo/old"],
    reachableStaleRoots: ["/repo/old"],
  } satisfies ProjectRootDiffInput;

  expect(diffProjectRoots(input)).toEqual({
    additions: ["/repo/new"],
    removals: [
      {
        action: "handoff",
        canonicalRoot: "/repo/old",
        finalProject: false,
        hasManagedEvidence: true,
        rootReachable: true,
      },
    ],
    observedRoots: ["/repo/kept", "/repo/new"],
    reactivations: [],
  });

  expect(
    diffProjectRoots({
      managedEvidenceRoots: [],
      observedRoots: [],
      registeredRoots: ["/repo/only"],
      reachableStaleRoots: [],
    }),
  ).toEqual({
    additions: [],
    removals: [
      {
        action: "deregister",
        canonicalRoot: "/repo/only",
        finalProject: true,
        hasManagedEvidence: false,
        rootReachable: false,
      },
    ],
    observedRoots: [],
    reactivations: [],
  });

  expect(
    diffProjectRoots({
      handoffRoots: ["/repo/returning"],
      managedEvidenceRoots: [],
      observedRoots: ["/repo/returning"],
      registeredRoots: ["/repo/kept", "/repo/old"],
      reachableStaleRoots: [],
    }),
  ).toEqual({
    additions: [],
    observedRoots: ["/repo/returning"],
    reactivations: ["/repo/returning"],
    removals: [
      {
        action: "deregister",
        canonicalRoot: "/repo/kept",
        finalProject: false,
        hasManagedEvidence: false,
        rootReachable: false,
      },
      {
        action: "deregister",
        canonicalRoot: "/repo/old",
        finalProject: false,
        hasManagedEvidence: false,
        rootReachable: false,
      },
    ],
  });

  expect(
    diffProjectRoots({
      managedEvidenceRoots: [],
      observedRoots: [],
      registeredRoots: ["/repo/a", "/repo/b"],
      reachableStaleRoots: [],
    }).removals.every((removal) => removal.finalProject === true),
  ).toBe(true);
});

const withRefreshFixture = <A, E, R>(
  use: (fixture: {
    readonly options: StateOptions & { readonly homeDirectory: string };
    readonly root: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-refresh-test-" });
    const options = {
      stateDirectory: path.join(root, "state"),
      homeDirectory: path.join(root, "home"),
    } satisfies StateOptions;
    yield* initializeState(options);
    return yield* use({ options, root });
  });

const previewRefresh = (
  options: StateOptions,
  git: GitService,
  scope: ProjectRefreshScope = { _tag: "all" },
) =>
  runProjectRefreshCommand(options, { apply: false, scope }).pipe(
    Effect.map((execution) => execution.plan.refresh),
    Effect.provideService(Git, git),
  );

const appliedRefresh = (
  options: StateOptions,
  git: GitService,
  scope: ProjectRefreshScope = { _tag: "all" },
) =>
  runProjectRefreshCommand(options, { apply: true, scope }).pipe(
    Effect.flatMap((execution) =>
      execution.applied === undefined
        ? Effect.die("Expected an applied refresh")
        : Effect.succeed(execution.applied.refresh),
    ),
    Effect.provideService(Git, git),
  );

const managedEvidence = (canonicalPath: string) => ({
  adapter: "codex" as const,
  address: {
    kind: "skill" as const,
    name: "example",
    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  },
  sourceDirectoryPath: "/sources/example",
  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  target: { _tag: "project-root" as const, canonicalPath, projectName: "project" },
});

it.layer(LiveTestLayer)("project worktree refresh planning", (refreshIt) => {
  refreshIt.effect(
    "derives canonical roots from the registered anchor and keeps no-op plans stable",
    () =>
      withRefreshFixture(({ options, root }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const anchor = path.join(root, "anchor");
          const kept = path.join(root, "kept");
          const newRoot = path.join(root, "new");
          const alias = path.join(root, "new-alias");
          yield* fileSystem.makeDirectory(anchor, { recursive: true });
          yield* fileSystem.makeDirectory(kept, { recursive: true });
          yield* fileSystem.makeDirectory(newRoot, { recursive: true });
          yield* fileSystem.symlink(newRoot, alias);
          const canonicalAnchor = yield* fileSystem.realPath(anchor);
          const canonicalKept = yield* fileSystem.realPath(kept);
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              projects: [
                { gitCommonDirectory: canonicalAnchor, name: "project", roots: [canonicalKept] },
              ],
            },
          }));
          let listedCwd = "";
          const plan = yield* previewRefresh(
            options,
            fakeGit(
              canonicalAnchor,
              [
                { path: canonicalKept },
                { path: alias },
                { bare: true, path: path.join(root, "bare") },
                { path: path.join(root, "prunable"), prunable: "gone" },
              ],
              (operation, cwd) => {
                if (operation === "list") listedCwd = cwd;
              },
            ),
          );
          const before = yield* readState(options);
          const repeated = yield* previewRefresh(
            options,
            fakeGit(canonicalAnchor, [{ path: canonicalKept }, { path: alias }]),
          );

          expect(listedCwd).toBe(canonicalAnchor);
          expect(plan.projects).toHaveLength(1);
          expect(plan.projects[0]?.observedRoots).toEqual([
            canonicalKept,
            yield* fileSystem.realPath(newRoot),
          ]);
          expect(plan.projects[0]?.additions).toEqual([yield* fileSystem.realPath(newRoot)]);
          expect(plan.projects[0]?.removals).toEqual([]);
          expect(repeated).toEqual(plan);
          expect(yield* readState(options)).toEqual(before);
        }),
      ),
  );

  refreshIt.effect(
    "reports the hand-made entries of the roots it adds, never of the roots it keeps",
    () =>
      withRefreshFixture(({ options, root }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const anchor = path.join(root, "anchor");
          const kept = path.join(root, "kept");
          const newRoot = path.join(root, "new");
          yield* fileSystem.makeDirectory(anchor, { recursive: true });
          yield* fileSystem.makeDirectory(path.join(kept, ".claude", "skills", "old-mine"), {
            recursive: true,
          });
          yield* fileSystem.makeDirectory(path.join(newRoot, ".claude", "skills", "code-review"), {
            recursive: true,
          });
          const canonicalAnchor = yield* fileSystem.realPath(anchor);
          const canonicalKept = yield* fileSystem.realPath(kept);
          const canonicalNew = yield* fileSystem.realPath(newRoot);
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              enabledAdapters: ["claude"],
              projects: [
                { gitCommonDirectory: canonicalAnchor, name: "project", roots: [canonicalKept] },
              ],
            },
          }));
          const git = fakeGit(canonicalAnchor, [{ path: canonicalKept }, { path: canonicalNew }]);
          const expected = [
            {
              adapter: "claude",
              kind: "skill",
              path: path.join(canonicalNew, ".claude", "skills", "code-review"),
              entry: "directory",
            },
          ];

          const preview = yield* runProjectRefreshCommand(options, {
            apply: false,
            scope: { _tag: "all" },
          }).pipe(Effect.provideService(Git, git));
          const applied = yield* runProjectRefreshCommand(options, {
            apply: true,
            scope: { _tag: "all" },
          }).pipe(Effect.provideService(Git, git));
          const repeated = yield* runProjectRefreshCommand(options, {
            apply: false,
            scope: { _tag: "all" },
          }).pipe(Effect.provideService(Git, git));

          expect(preview.plan.handMade).toEqual(expected);
          expect(applied.plan.handMade).toEqual(expected);
          // Once the root is registered, refresh adds nothing, so it reports nothing.
          expect(repeated.plan.handMade).toEqual([]);
          expect(
            yield* fileSystem.exists(path.join(canonicalNew, ".claude", "skills", "code-review")),
          ).toBe(true);
        }),
      ),
  );

  refreshIt.effect("plans direct missing-root deregistration and live-root cleanup handoff", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const reachable = path.join(root, "reachable");
        const missing = path.join(root, "missing");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(reachable, { recursive: true });
        const canonicalAnchor = yield* fileSystem.realPath(anchor);
        const canonicalReachable = yield* fileSystem.realPath(reachable);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            agentLinks: [],
            projects: [
              {
                gitCommonDirectory: canonicalAnchor,
                name: "project",
                roots: sortAndDedupeStrings([missing, canonicalReachable]),
              },
            ],
          },
        }));
        const plan = yield* previewRefresh(options, fakeGit(canonicalAnchor, []));
        expect(plan.projects[0]?.removals).toEqual(
          sortAndDedupeBy(
            [
              {
                action: "handoff",
                canonicalRoot: canonicalReachable,
                finalProject: true,
                hasManagedEvidence: false,
                rootReachable: true,
              },
              {
                action: "deregister",
                canonicalRoot: missing,
                finalProject: true,
                hasManagedEvidence: false,
                rootReachable: false,
              },
            ],
            (removal) => removal.canonicalRoot,
          ),
        );
      }),
    ),
  );

  refreshIt.effect("applies additions and direct missing-root removal under one writer lock", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchorPath = path.join(root, "anchor");
        const keptPath = path.join(root, "kept");
        const newPath = path.join(root, "new");
        const missingPath = path.join(root, "missing");
        yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
        yield* fileSystem.makeDirectory(keptPath, { recursive: true });
        yield* fileSystem.makeDirectory(newPath, { recursive: true });
        const anchor = yield* fileSystem.realPath(anchorPath);
        const kept = yield* fileSystem.realPath(keptPath);
        const newRoot = yield* fileSystem.realPath(newPath);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            choices: [
              {
                address: {
                  kind: "skill",
                  name: "example",
                  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
                },
                decision: "include" as const,
                namespace: { _tag: "project" as const, projectName: "project" },
              },
            ],
            projects: [{ gitCommonDirectory: anchor, name: "project", roots: [kept, missingPath] }],
          },
        }));
        const statePath = path.join(options.stateDirectory ?? "", "state.json");
        const before = yield* fileSystem.readFileString(statePath);
        const result = yield* appliedRefresh(
          options,
          fakeGit(anchor, [{ path: kept }, { path: newRoot }]),
        );
        const after = yield* fileSystem.readFileString(statePath);
        const state = yield* readState(options);

        expect(before).not.toBe(after);
        expect(result.changes).toEqual([
          { action: "added", canonicalRoot: newRoot, projectName: "project" },
          { action: "deregistered", canonicalRoot: missingPath, projectName: "project" },
        ]);
        expect(state.data.projects?.at(0)?.roots).toEqual([kept, newRoot]);
        expect(allChoices(state)).toHaveLength(1);
      }),
    ),
  );

  refreshIt.effect("hands reachable roots to cleanup and keeps blocked obligations", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchorPath = path.join(root, "anchor");
        const keptPath = path.join(root, "kept");
        const stalePath = path.join(root, "stale");
        yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
        yield* fileSystem.makeDirectory(keptPath, { recursive: true });
        yield* fileSystem.makeDirectory(stalePath, { recursive: true });
        const anchor = yield* fileSystem.realPath(anchorPath);
        const kept = yield* fileSystem.realPath(keptPath);
        const stale = yield* fileSystem.realPath(stalePath);
        const evidence = managedEvidence(stale);
        const destination = managedLinkDestinationPath(evidence);
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.writeFileString(destination, "foreign");
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            choices: [
              {
                address: {
                  kind: "skill",
                  name: "example",
                  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
                },
                decision: "include" as const,
                namespace: { _tag: "project" as const, projectName: "project" },
              },
            ],
            agentLinks: [evidence],
            projects: [{ gitCommonDirectory: anchor, name: "project", roots: [kept, stale] }],
          },
        }));
        const git = fakeGit(anchor, [{ path: kept }]);
        const execution = yield* runProjectRefreshCommand(options, {
          apply: true,
          scope: { _tag: "all" },
        }).pipe(Effect.provideService(Git, git));
        const result = execution.applied?.refresh;
        const state = yield* readState(options);
        const selection = yield* selectTargetsAt(options, {
          cwd: root,
          selector: { _tag: "project", projectName: "project" },
          userTarget: options.homeDirectory,
        });

        expect(result?.changes).toEqual([
          { action: "handoff", canonicalRoot: stale, projectName: "project" },
        ]);
        expect(execution.applied?.removals.flatMap((removal) => removal.actions)).toMatchObject([
          { _tag: "skipped" },
        ]);
        expect(projectRecords(state)).toEqual([
          {
            gitCommonDirectory: anchor,
            name: "project",
            removingRoots: [stale],
            roots: [kept],
          },
        ]);
        expect(allChoices(state)).toHaveLength(1);
        expect(managedLinksOf(state.data.links)).toEqual([evidence]);
        expect(pendingRemovalsOf(state.data.links)).toMatchObject([
          { cause: "root-removal", evidence },
        ]);
        expect(selection.targets).toEqual([
          { _tag: "project-root", canonicalPath: kept, projectName: "project" },
          {
            _tag: "pending-removal",
            canonicalPath: stale,
            pending: { _tag: "project", canonicalPath: stale, projectName: "project" },
          },
        ]);
        expect(selection.targets.filter((target) => target._tag === "project-root")).toEqual([
          { _tag: "project-root", canonicalPath: kept, projectName: "project" },
        ]);

        yield* fileSystem.remove(destination);
        const retry = yield* retryPendingRemovals(options, { apply: true });
        expect(retry.applied?.actions[0]?._tag).toBe("applied");
        expect(projectRecords(yield* readState(options))).toEqual([
          { gitCommonDirectory: anchor, name: "project", roots: [kept] },
        ]);
        expect(pendingRemovalsOf((yield* readState(options)).data.links)).toEqual([]);
      }),
    ),
  );

  refreshIt.effect("encodes and applies one explicit project scope without widening it", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const firstAnchorPath = path.join(root, "first-anchor");
        const firstRootPath = path.join(root, "first-root");
        const firstAddedPath = path.join(root, "first-added");
        const secondAnchorPath = path.join(root, "second-anchor");
        const secondRootPath = path.join(root, "second-root");
        const secondAddedPath = path.join(root, "second-added");
        yield* Effect.forEach(
          [
            firstAnchorPath,
            firstRootPath,
            firstAddedPath,
            secondAnchorPath,
            secondRootPath,
            secondAddedPath,
          ],
          (directory) => fileSystem.makeDirectory(directory, { recursive: true }),
        );
        const firstAnchor = yield* fileSystem.realPath(firstAnchorPath);
        const firstRoot = yield* fileSystem.realPath(firstRootPath);
        const firstAdded = yield* fileSystem.realPath(firstAddedPath);
        const secondAnchor = yield* fileSystem.realPath(secondAnchorPath);
        const secondRoot = yield* fileSystem.realPath(secondRootPath);
        const secondAdded = yield* fileSystem.realPath(secondAddedPath);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              { gitCommonDirectory: firstAnchor, name: "first", roots: [firstRoot] },
              { gitCommonDirectory: secondAnchor, name: "second", roots: [secondRoot] },
            ],
          },
        }));
        const git: GitService = {
          listWorktrees: (cwd) =>
            Effect.succeed(
              cwd === firstAnchor
                ? [
                    { bare: false, detached: false, path: firstRoot },
                    { bare: false, detached: false, path: firstAdded },
                  ]
                : [
                    { bare: false, detached: false, path: secondRoot },
                    { bare: false, detached: false, path: secondAdded },
                  ],
            ),
          resolveCommonDirectory: (cwd) => Effect.succeed(cwd),
        };

        const scope = { _tag: "project", projectName: "first" } as const;
        const dryRun = yield* runProjectRefreshCommand(options, { apply: false, scope }).pipe(
          Effect.provideService(Git, git),
        );
        const applied = yield* runProjectRefreshCommand(options, { apply: true, scope }).pipe(
          Effect.provideService(Git, git),
        );
        const state = yield* readState(options);

        expect(dryRun.plan.refresh.scope).toEqual({ _tag: "project", projectName: "first" });
        expect(dryRun.plan.refresh.projects.map((entry) => entry.expectedProject.name)).toEqual([
          "first",
        ]);
        expect(applied.plan).toEqual(dryRun.plan);
        expect(applied.applied?.refresh.changes).toEqual([
          { action: "added", canonicalRoot: firstAdded, projectName: "first" },
        ]);
        expect(projectRecords(state)).toEqual([
          { gitCommonDirectory: firstAnchor, name: "first", roots: [firstAdded, firstRoot] },
          { gitCommonDirectory: secondAnchor, name: "second", roots: [secondRoot] },
        ]);
      }),
    ),
  );

  refreshIt.effect("observes Git once per project for preview and for apply", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directories = ["first-anchor", "first-root", "second-anchor", "second-root"];
        yield* Effect.forEach(directories, (directory) =>
          fileSystem.makeDirectory(path.join(root, directory), { recursive: true }),
        );
        const [firstAnchor, firstRoot, secondAnchor, secondRoot] = yield* Effect.forEach(
          directories,
          (directory) => fileSystem.realPath(path.join(root, directory)),
        );
        const added = path.join(root, "first-added");
        yield* fileSystem.makeDirectory(added);
        const firstAdded = yield* fileSystem.realPath(added);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              { gitCommonDirectory: firstAnchor ?? "", name: "first", roots: [firstRoot ?? ""] },
              { gitCommonDirectory: secondAnchor ?? "", name: "second", roots: [secondRoot ?? ""] },
            ],
          },
        }));
        const calls: Array<string> = [];
        const git: GitService = {
          listWorktrees: (cwd) => {
            calls.push(`worktree list ${cwd}`);
            return Effect.succeed(
              (cwd === firstAnchor ? [firstRoot, firstAdded] : [secondRoot]).map((entry) => ({
                bare: false,
                detached: false,
                path: entry ?? "",
              })),
            );
          },
          resolveCommonDirectory: (cwd) => {
            calls.push(`rev-parse ${cwd}`);
            return Effect.succeed(cwd);
          },
        };
        const perProject = [
          `rev-parse ${firstAnchor}`,
          `worktree list ${firstAnchor}`,
          `rev-parse ${secondAnchor}`,
          `worktree list ${secondAnchor}`,
        ];

        yield* runProjectRefreshCommand(options, { apply: false, scope: { _tag: "all" } }).pipe(
          Effect.provideService(Git, git),
        );
        expect(calls).toEqual(perProject);
        calls.length = 0;
        const applied = yield* runProjectRefreshCommand(options, {
          apply: true,
          scope: { _tag: "all" },
        }).pipe(Effect.provideService(Git, git));

        expect(calls).toEqual(perProject);
        expect(applied.applied?.refresh.changes).toEqual([
          { action: "added", canonicalRoot: firstAdded, projectName: "first" },
        ]);
      }),
    ),
  );

  refreshIt.effect("keeps dry-run read-only and applies the same fresh plan", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchorPath = path.join(root, "anchor");
        const existingPath = path.join(root, "existing");
        const newPath = path.join(root, "new");
        yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
        yield* fileSystem.makeDirectory(existingPath, { recursive: true });
        yield* fileSystem.makeDirectory(newPath, { recursive: true });
        const anchor = yield* fileSystem.realPath(anchorPath);
        const existing = yield* fileSystem.realPath(existingPath);
        const newRoot = yield* fileSystem.realPath(newPath);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [{ gitCommonDirectory: anchor, name: "project", roots: [existing] }],
          },
        }));
        const git = fakeGit(anchor, [{ path: existing }, { path: newRoot }]);
        const statePath = path.join(options.stateDirectory ?? "", "state.json");
        const before = yield* fileSystem.readFileString(statePath);
        const dryRun = yield* runProjectRefreshCommand(options, {
          apply: false,
          scope: { _tag: "all" },
        }).pipe(Effect.provideService(Git, git));
        const afterDryRun = yield* fileSystem.readFileString(statePath);
        const applied = yield* runProjectRefreshCommand(options, {
          apply: true,
          scope: { _tag: "all" },
        }).pipe(Effect.provideService(Git, git));

        expect(afterDryRun).toBe(before);
        expect(dryRun.applied).toBeUndefined();
        expect(applied.plan).toEqual(dryRun.plan);
        expect(applied.applied?.refresh.changes).toEqual([
          { action: "added", canonicalRoot: newRoot, projectName: "project" },
        ]);
      }),
    ),
  );

  refreshIt.effect("retires evidence when a final missing root leaves the project", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchorPath = path.join(root, "anchor");
        const missingPath = path.join(root, "missing");
        yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
        const anchor = yield* fileSystem.realPath(anchorPath);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            choices: [
              {
                address: {
                  kind: "skill",
                  name: "example",
                  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
                },
                decision: "include" as const,
                namespace: { _tag: "project" as const, projectName: "project" },
              },
            ],
            agentLinks: [managedEvidence(missingPath)],
            projects: [{ gitCommonDirectory: anchor, name: "project", roots: [missingPath] }],
          },
        }));
        const plan = yield* previewRefresh(options, fakeGit(anchor, []));
        const removal = plan.projects.at(0)?.removals.at(0);
        expect(removal).toMatchObject({
          action: "deregister",
          finalProject: true,
          hasManagedEvidence: true,
          rootReachable: false,
        });
        const result = yield* appliedRefresh(options, fakeGit(anchor, []));
        const state = yield* readState(options);

        expect(result.removedProjects).toEqual(["project"]);
        expect(state.data.projects ?? []).toEqual([]);
        expect(allChoices(state) ?? []).toEqual([]);
        expect(managedLinksOf(state.data.links)).toEqual([]);
      }),
    ),
  );

  refreshIt.effect("retires pending-only evidence with its final missing root", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchorPath = path.join(root, "anchor");
        const missingPath = path.join(root, "missing");
        yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
        const anchor = yield* fileSystem.realPath(anchorPath);
        const evidence = managedEvidence(missingPath);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            choices: [
              {
                address: evidence.address,
                decision: "include" as const,
                namespace: { _tag: "project" as const, projectName: "project" },
              },
            ],
            pendingRemovals: [
              {
                cause: "project-removal" as const,
                evidence,
              },
            ],
            projects: [{ gitCommonDirectory: anchor, name: "project", roots: [missingPath] }],
          },
        }));
        const git = fakeGit(anchor, []);
        const result = yield* appliedRefresh(options, git);
        const state = yield* readState(options);

        expect(result.removedProjects).toEqual(["project"]);
        expect(state.data.projects ?? []).toEqual([]);
        expect(allChoices(state) ?? []).toEqual([]);
        expect(pendingRemovalsOf(state.data.links)).toEqual([]);
      }),
    ),
  );

  refreshIt.effect("drops the fixed profile application of a project it forgets", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchorPath = path.join(root, "anchor");
        yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
        const anchor = yield* fileSystem.realPath(anchorPath);
        const application = (namespace: ProfileApplication["namespace"]): ProfileApplication => ({
          direct: [],
          inventory: [],
          namespace,
          profileName: "team",
          sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
          targets: [],
        });
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            profileApplications: [
              application({ _tag: "user" }),
              application({ _tag: "project", projectName: "project" }),
            ],
            projects: [
              { gitCommonDirectory: anchor, name: "project", roots: [path.join(root, "missing")] },
            ],
          },
        }));
        const result = yield* appliedRefresh(options, fakeGit(anchor, []));
        const state = yield* readState(options);

        expect(result.removedProjects).toEqual(["project"]);
        expect(state.data.profileApplications).toEqual([application({ _tag: "user" })]);
      }),
    ),
  );

  refreshIt.effect("fails closed when final deletion would orphan evidence for another root", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchorPath = path.join(root, "anchor");
        const missingPath = path.join(root, "missing");
        const unregisteredPath = path.join(root, "unregistered");
        yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
        yield* fileSystem.makeDirectory(unregisteredPath, { recursive: true });
        const anchor = yield* fileSystem.realPath(anchorPath);
        const unregisteredRoot = yield* fileSystem.realPath(unregisteredPath);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            agentLinks: [managedEvidence(missingPath), managedEvidence(unregisteredRoot)],
            projects: [{ gitCommonDirectory: anchor, name: "project", roots: [missingPath] }],
          },
        }));
        const statePath = path.join(options.stateDirectory ?? "", "state.json");
        const before = yield* fileSystem.readFileString(statePath);

        const error = yield* Effect.flip(previewRefresh(options, fakeGit(anchor, [])));

        expect(error).toBeInstanceOf(ProjectRefreshEvidenceError);
        expect(error).toMatchObject({
          code: "project-refresh-evidence-unaccounted",
          projectName: "project",
          roots: [unregisteredRoot],
        });
        expect(yield* fileSystem.readFileString(statePath)).toBe(before);
      }),
    ),
  );

  refreshIt.effect("fails closed when final deletion would orphan pending-only evidence", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchorPath = path.join(root, "anchor");
        const missingPath = path.join(root, "missing");
        const unregisteredPath = path.join(root, "unregistered");
        yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
        yield* fileSystem.makeDirectory(unregisteredPath, { recursive: true });
        const anchor = yield* fileSystem.realPath(anchorPath);
        const unregisteredRoot = yield* fileSystem.realPath(unregisteredPath);
        const evidence = managedEvidence(unregisteredRoot);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            pendingRemovals: [
              {
                cause: "project-removal" as const,
                evidence,
              },
            ],
            projects: [{ gitCommonDirectory: anchor, name: "project", roots: [missingPath] }],
          },
        }));

        const error = yield* Effect.flip(previewRefresh(options, fakeGit(anchor, [])));

        expect(error).toBeInstanceOf(ProjectRefreshEvidenceError);
        expect(error).toMatchObject({
          code: "project-refresh-evidence-unaccounted",
          projectName: "project",
          roots: [unregisteredRoot],
        });
      }),
    ),
  );

  refreshIt.effect("reactivates a returning root from a removing project", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchorPath = path.join(root, "anchor");
        const returningPath = path.join(root, "returning");
        const newPath = path.join(root, "new");
        const retainedHandoff = path.join(root, "retained-handoff");
        yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
        yield* fileSystem.makeDirectory(returningPath, { recursive: true });
        yield* fileSystem.makeDirectory(newPath, { recursive: true });
        const anchor = yield* fileSystem.realPath(anchorPath);
        const returning = yield* fileSystem.realPath(returningPath);
        const newRoot = yield* fileSystem.realPath(newPath);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              {
                gitCommonDirectory: anchor,
                name: "project",
                removingRoots: sortAndDedupeStrings([returning, retainedHandoff]),
                roots: [],
              },
            ],
          },
        }));
        const git = fakeGit(anchor, [{ path: returning }, { path: newRoot }]);
        const plan = yield* previewRefresh(options, git);
        const applied = yield* appliedRefresh(options, git);
        const state = yield* readState(options);

        expect(plan.projects.at(0)?.reactivations).toEqual([returning]);
        expect(plan.projects.at(0)?.additions).toEqual([newRoot]);
        expect(plan.projects.at(0)?.removals).toEqual([]);
        expect(applied.changes).toEqual([
          { action: "added", canonicalRoot: newRoot, projectName: "project" },
          { action: "reactivated", canonicalRoot: returning, projectName: "project" },
        ]);
        expect(state.data.projects?.at(0)).toEqual({
          gitCommonDirectory: anchor,
          name: "project",
          removingRoots: [retainedHandoff],
          roots: [newRoot, returning],
        });
      }),
    ),
  );

  refreshIt.effect(
    "does not let Git re-observation undo explicit project removal after evidence retirement",
    () =>
      withRefreshFixture(({ options, root }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const anchorPath = path.join(root, "anchor");
          const newPath = path.join(root, "new-root");
          const returningPath = path.join(root, "returning");
          yield* fileSystem.makeDirectory(anchorPath, { recursive: true });
          yield* fileSystem.makeDirectory(newPath, { recursive: true });
          yield* fileSystem.makeDirectory(returningPath, { recursive: true });
          const anchor = yield* fileSystem.realPath(anchorPath);
          const newRoot = yield* fileSystem.realPath(newPath);
          const returning = yield* fileSystem.realPath(returningPath);
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              projects: [
                {
                  gitCommonDirectory: anchor,
                  name: "project",
                  removalIntent: "project" as const,
                  removingRoots: [returning],
                  roots: [],
                },
              ],
            },
          }));
          const git = fakeGit(anchor, [{ path: returning }, { path: newRoot }]);
          const before = yield* readState(options);
          const plan = yield* previewRefresh(options, git);
          const applied = yield* appliedRefresh(options, git);

          expect(plan.projects.at(0)?.additions).toEqual([]);
          expect(plan.projects.at(0)?.reactivations).toEqual([]);
          expect(applied.changes).toEqual([]);
          expect(yield* readState(options)).toEqual(before);
        }),
      ),
  );

  refreshIt.effect("does not reactivate a blocked explicit final-root removal", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchorPath = path.join(root, "anchor");
        const foreignPath = path.join(root, "foreign");
        const newPath = path.join(root, "new-root");
        const projectPath = path.join(root, "project-root");
        yield* Effect.forEach([anchorPath, foreignPath, newPath, projectPath], (directory) =>
          fileSystem.makeDirectory(directory, { recursive: true }),
        );
        const anchor = yield* fileSystem.realPath(anchorPath);
        const newRoot = yield* fileSystem.realPath(newPath);
        const projectRoot = yield* fileSystem.realPath(projectPath);
        const evidence = managedEvidence(projectRoot);
        const destination = managedLinkDestinationPath(evidence);
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.symlink(
          path.relative(path.dirname(destination), foreignPath),
          destination,
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            agentLinks: [evidence],
            projects: [{ gitCommonDirectory: anchor, name: "project", roots: [projectRoot] }],
          },
        }));

        const removal = yield* removeProjectRoot(options, {
          apply: true,
          canonicalRoot: projectRoot,
          projectName: "project",
        });
        expect(removal.applied?.actions.at(0)?._tag).toBe("skipped");
        expect((yield* readState(options)).data.projects?.at(0)).toMatchObject({
          removalIntent: "project",
          removingRoots: [projectRoot],
          roots: [],
        });

        const git = fakeGit(anchor, [{ path: projectRoot }, { path: newRoot }]);
        const before = yield* readState(options);
        const plan = yield* previewRefresh(options, git);
        const applied = yield* appliedRefresh(options, git);

        expect(plan.projects.at(0)?.additions).toEqual([]);
        expect(plan.projects.at(0)?.reactivations).toEqual([]);
        expect(applied.changes).toEqual([]);
        expect(yield* readState(options)).toEqual(before);
      }),
    ),
  );

  refreshIt.effect("rejects duplicate new-root ownership across refresh entries", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchorOnePath = path.join(root, "anchor-one");
        const anchorTwoPath = path.join(root, "anchor-two");
        const rootOnePath = path.join(root, "root-one");
        const rootTwoPath = path.join(root, "root-two");
        const sharedPath = path.join(root, "shared");
        yield* fileSystem.makeDirectory(anchorOnePath, { recursive: true });
        yield* fileSystem.makeDirectory(anchorTwoPath, { recursive: true });
        yield* fileSystem.makeDirectory(rootOnePath, { recursive: true });
        yield* fileSystem.makeDirectory(rootTwoPath, { recursive: true });
        yield* fileSystem.makeDirectory(sharedPath, { recursive: true });
        const anchorOne = yield* fileSystem.realPath(anchorOnePath);
        const anchorTwo = yield* fileSystem.realPath(anchorTwoPath);
        const rootOne = yield* fileSystem.realPath(rootOnePath);
        const rootTwo = yield* fileSystem.realPath(rootTwoPath);
        const shared = yield* fileSystem.realPath(sharedPath);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              { gitCommonDirectory: anchorOne, name: "first", roots: [rootOne] },
              { gitCommonDirectory: anchorTwo, name: "second", roots: [rootTwo] },
            ],
          },
        }));
        const git: GitService = {
          listWorktrees: (cwd) =>
            Effect.succeed(
              cwd === anchorOne
                ? [{ bare: false, detached: false, path: shared }]
                : [{ bare: false, detached: false, path: shared }],
            ),
          resolveCommonDirectory: (cwd) => Effect.succeed(cwd),
        };
        const error = yield* Effect.flip(previewRefresh(options, git));

        expect(error).toBeInstanceOf(ProjectRootOwnershipError);
      }),
    ),
  );

  refreshIt.effect("refuses to add a worktree that another project already registered", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const [anchor = "", own = "", taken = ""] = yield* Effect.forEach(
          ["anchor", "own", "taken"],
          (name) =>
            fileSystem
              .makeDirectory(path.join(root, name), { recursive: true })
              .pipe(Effect.andThen(fileSystem.realPath(path.join(root, name)))),
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              { gitCommonDirectory: anchor, name: "project", roots: [own] },
              {
                gitCommonDirectory: path.join(root, "other-anchor"),
                name: "other",
                roots: [taken],
              },
            ],
          },
        }));
        const error = yield* Effect.flip(
          previewRefresh(options, fakeGit(anchor, [{ path: own }, { path: taken }]), {
            _tag: "project",
            projectName: "project",
          }),
        );

        expect(error).toBeInstanceOf(ProjectRootOwnershipError);
        expect(error).toMatchObject({
          code: "root-already-registered",
          conflictingProjectName: "other",
          canonicalRoot: taken,
          projectName: "project",
        });
      }),
    ),
  );

  refreshIt.effect("cancels the removals a returning root owed and forgets owed-only links", () =>
    withRefreshFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(root, "anchor"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(root, "returning"), { recursive: true });
        const anchor = yield* fileSystem.realPath(path.join(root, "anchor"));
        const returning = yield* fileSystem.realPath(path.join(root, "returning"));
        const kept = managedEvidence(returning);
        const owedOnly = {
          ...kept,
          address: { ...kept.address, name: "owed-only" },
          sourceDirectoryPath: "/sources/owed-only",
        };
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            agentLinks: [kept],
            pendingRemovals: [
              { cause: "root-removal" as const, evidence: kept },
              { cause: "root-removal" as const, evidence: owedOnly },
            ],
            projects: [
              {
                gitCommonDirectory: anchor,
                name: "project",
                removingRoots: [returning],
                roots: [],
              },
            ],
          },
        }));
        const applied = yield* appliedRefresh(options, fakeGit(anchor, [{ path: returning }]));
        const state = yield* readState(options);

        expect(applied.changes).toEqual([
          { action: "reactivated", canonicalRoot: returning, projectName: "project" },
        ]);
        expect(managedLinksOf(state.data.links)).toEqual([kept]);
        expect(pendingRemovalsOf(state.data.links)).toEqual([]);
        expect(state.data.links).toHaveLength(1);
      }),
    ),
  );

  refreshIt.effect(
    "refreshes worktrees and source relocation while another project shares the checkout",
    () =>
      withDocsWorld(({ options, sourceId, source, roots, root }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const resource = {
            sourceRegistrationId: sourceId,

            name: "handbook",
          };
          const newRoot = path.join(root, "project-c");
          const otherRoot = path.join(root, "other-project");
          const common = path.join(root, "git");
          yield* fs.makeDirectory(newRoot);
          yield* fs.makeDirectory(otherRoot);
          yield* fs.makeDirectory(common);
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              projects: [
                ...(state.data.projects ?? []),
                {
                  name: "other",
                  gitCommonDirectory: path.join(root, "git-other"),
                  roots: [otherRoot],
                },
              ],
            },
          }));
          yield* attachDocs(options, { projectName: "demo" }, docsRequest(resource));
          yield* attachDocs(options, { projectName: "other" }, docsRequest(resource));
          for (const projectName of ["demo", "other"])
            yield* syncDocsReport(options, { projectName, apply: true });
          const git = fakeGit(common, [{ path: roots[0] ?? "" }, { path: newRoot }]);
          const refresh = {
            scope: { _tag: "project" as const, projectName: "demo" },
            apply: true,
          };
          yield* runProjectRefreshCommand(options, refresh).pipe(Effect.provideService(Git, git));
          expect(
            (yield* readState(options)).data.projects?.find((entry) => entry.name === "demo")
              ?.roots,
          ).toEqual([roots[0], newRoot]);
          expect(docsEvidence(yield* readState(options))).toHaveLength(3);
          const retired = path.join(roots[1] ?? "", ".tack/docs", sourceId, "handbook");
          expect(yield* fs.exists(retired)).toBe(false);
          const moved = path.join(root, "moved-source");
          yield* fs.rename(source, moved);
          yield* relocateSource(options, { registrationId: sourceId, sourcePath: moved });
          for (const projectName of ["demo", "other"])
            expect((yield* syncDocsReport(options, { projectName, apply: true })).complete).toBe(
              true,
            );
          const mounts = docsEvidence(yield* readState(options));
          for (const link of mounts)
            expect(yield* fs.realPath(link.destinationPath)).toBe(path.join(moved, "knowledge"));
          yield* fs.writeFileString(
            path.join(otherRoot, ".tack/docs", sourceId, "handbook/from-other.md"),
            "# Shared\n",
          );
          expect(
            yield* fs.readFileString(
              path.join(newRoot, ".tack/docs", sourceId, "handbook/from-other.md"),
            ),
          ).toBe("# Shared\n");
        }),
      ),
  );

  refreshIt.effect("previews and reports the docs mounts a project refresh applies", () =>
    withDocsWorld(({ options, sourceId, roots, root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* attachDocs(
          options,
          { projectName: "demo" },
          docsRequest({
            sourceRegistrationId: sourceId,

            name: "handbook",
          }),
        );
        yield* syncDocsReport(options, { projectName: "demo", apply: true });
        const newRoot = path.join(root, "project-c");
        yield* fs.makeDirectory(newRoot);
        yield* fs.makeDirectory(path.join(root, "git"), { recursive: true });
        const git = fakeGit(
          path.join(root, "git"),
          [...roots, newRoot].map((worktree) => ({ path: worktree })),
        );
        const mount = path.join(newRoot, ".tack/docs", sourceId, "handbook");
        const scope = { _tag: "project" as const, projectName: "demo" };

        const preview = yield* runProjectRefreshCommand(options, { apply: false, scope }).pipe(
          Effect.provideService(Git, git),
        );
        expect(yield* fs.exists(mount)).toBe(false);
        expect(
          preview.plan.docs.actions.map((action) => [action.action, action.evidence.root]),
        ).toEqual([
          ["keep", roots[0]],
          ["keep", roots[1]],
          ["create", newRoot],
        ]);
        expect(preview.plan.docs.complete).toBe(true);

        const applied = yield* runProjectRefreshCommand(options, { apply: true, scope }).pipe(
          Effect.provideService(Git, git),
        );
        expect(applied.plan).toEqual(preview.plan);
        expect(applied.applied?.docs.actions.map((outcome) => outcome.action)).toEqual(
          preview.plan.docs.actions,
        );
        expect(applied.applied?.docs.actions.every((outcome) => outcome._tag === "applied")).toBe(
          true,
        );
        expect(yield* fs.realPath(mount)).toBe(path.join(root, "source", "knowledge"));
      }),
    ),
  );

  refreshIt.effect(
    "keeps a committed refresh and its agent cleanup when docs conflict afterwards",
    () =>
      withDocsWorld(({ options, sourceId, roots, root }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* attachDocs(
            options,
            { projectName: "demo" },
            docsRequest({
              sourceRegistrationId: sourceId,

              name: "handbook",
            }),
          );
          yield* syncDocsReport(options, { projectName: "demo", apply: true });
          const [kept = "", handedOff = ""] = roots;
          const evidence = {
            adapter: "codex" as const,
            address: { kind: "skill" as const, name: "example", sourceRegistrationId: sourceId },
            sourceDirectoryPath: path.join(root, "source", "skills", "example"),
            sourceRegistrationId: sourceId,
            target: {
              _tag: "project-root" as const,
              canonicalPath: handedOff,
              projectName: "demo",
            },
          };
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: { ...state.data, links: [...state.data.links, agentLink(evidence)] },
          }));
          const newRoot = path.join(root, "project-c");
          const conflict = path.join(newRoot, ".tack/docs", sourceId, "handbook");
          yield* fs.makeDirectory(conflict, { recursive: true });
          yield* fs.makeDirectory(path.join(root, "git"), { recursive: true });
          const git = fakeGit(path.join(root, "git"), [{ path: kept }, { path: newRoot }]);

          const execution = yield* runProjectRefreshCommand(options, {
            apply: true,
            scope: { _tag: "all" },
          }).pipe(Effect.provideService(Git, git));
          const state = yield* readState(options);

          expect(execution.applied?.refresh.changes).toEqual([
            { action: "added", canonicalRoot: newRoot, projectName: "demo" },
            { action: "handoff", canonicalRoot: handedOff, projectName: "demo" },
          ]);
          expect(
            execution.applied?.removals.flatMap((removal) =>
              removal.actions.map((outcome) => outcome["_tag"]),
            ),
          ).toEqual(["applied"]);
          expect(execution.applied?.docs.complete).toBe(false);
          expect(
            execution.applied?.docs.actions.find((outcome) => outcome._tag === "blocked")?.action
              .evidence.root,
          ).toBe(newRoot);
          expect(state.data.projects?.find((project) => project.name === "demo")?.roots).toEqual([
            kept,
            newRoot,
          ]);
          expect(managedLinksOf(state.data.links)).toEqual([]);
          expect(
            docsEvidence(state)
              .map((link) => link.root)
              .sort(),
          ).toEqual([kept]);
        }),
      ),
  );

  refreshIt.effect(
    "reports blocked docs cleanup of a handed-off root without failing refresh",
    () =>
      withDocsWorld(({ options, sourceId, roots, root }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* attachDocs(
            options,
            { projectName: "demo" },
            docsRequest({
              sourceRegistrationId: sourceId,

              name: "handbook",
            }),
          );
          yield* syncDocsReport(options, { projectName: "demo", apply: true });
          const [kept = "", handedOff = ""] = roots;
          const replaced = path.join(handedOff, ".tack/docs", sourceId, "handbook");
          yield* fs.remove(replaced);
          yield* fs.makeDirectory(replaced);
          yield* fs.makeDirectory(path.join(root, "git"), { recursive: true });
          const git = fakeGit(path.join(root, "git"), [{ path: kept }]);

          const execution = yield* runProjectRefreshCommand(options, {
            apply: true,
            scope: { _tag: "project", projectName: "demo" },
          }).pipe(Effect.provideService(Git, git));
          const state = yield* readState(options);

          expect(execution.applied?.refresh.changes).toEqual([
            { action: "handoff", canonicalRoot: handedOff, projectName: "demo" },
          ]);
          // The blocked mount stays on disk as an obligation instead of failing the refresh.
          expect(execution.applied?.removals[0]?.docsActions).toMatchObject([
            { _tag: "blocked", code: "docs-destination-modified" },
          ]);
          expect(execution.applied?.removals[0]?.docsPendingRemovals).toMatchObject([
            { cause: "root-removal", lastResult: { _tag: "blocked" } },
          ]);
          expect(state.data.projects?.at(0)).toMatchObject({ removingRoots: [], roots: [kept] });
          expect(
            docsPendingRemovalsOf(state.data.links).map((pending) => pending.evidence.root),
          ).toEqual([handedOff]);
          expect(
            docsEvidence(state)
              .map((link) => link.root)
              .sort(),
          ).toEqual([kept, handedOff].sort());
        }),
      ),
  );

  refreshIt.effect("retires a missing root's docs evidence through the refresh removal plan", () =>
    withDocsWorld(({ options, sourceId, roots, root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* attachDocs(
          options,
          { projectName: "demo" },
          docsRequest({
            sourceRegistrationId: sourceId,

            name: "handbook",
          }),
        );
        yield* syncDocsReport(options, { projectName: "demo", apply: true });
        const [kept = "", missing = ""] = roots;
        yield* fs.remove(missing, { recursive: true });
        yield* fs.makeDirectory(path.join(root, "git"), { recursive: true });
        const git = fakeGit(path.join(root, "git"), [{ path: kept }]);
        const scope = { _tag: "project" as const, projectName: "demo" };

        const preview = yield* runProjectRefreshCommand(options, { apply: false, scope }).pipe(
          Effect.provideService(Git, git),
        );
        expect(
          preview.plan.removals.flatMap((removal) =>
            (removal.docsActions ?? []).map((action) => action.evidence.root),
          ),
        ).toEqual([missing]);
        expect(preview.plan.docs.actions.map((action) => action.action)).toEqual(["keep"]);

        const applied = yield* runProjectRefreshCommand(options, { apply: true, scope }).pipe(
          Effect.provideService(Git, git),
        );
        expect(applied.applied?.docs.complete).toBe(true);
        expect(docsEvidence(yield* readState(options)).map((link) => link.root)).toEqual([kept]);
      }),
    ),
  );
});
