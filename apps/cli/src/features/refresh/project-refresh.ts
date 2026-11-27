import {
  agentLink,
  applyLinkChanges,
  linkEvidenceEqual,
  linkEvidenceOf,
  type LinkChange,
  type LinkRecord,
} from "../../domain/links/link-record-schema.ts";
import { managedDocsLinksOf } from "../../domain/docs/docs-schema.ts";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Git, type GitCommandError, type GitOutputParseError } from "../../services/git.ts";
import { compareCodeUnits, sortAndDedupeBy } from "../../domain/identity/ordering.ts";
import { applyDocsPlan, planDocsLinks, type DocsLinkScope } from "../docs/docs-links.ts";
import { observeRootHandMadeEntries } from "../hand-made/hand-made-entries.ts";
import { previewOrApply } from "../writer/recovered-writer.ts";
import type { CommandSnapshot } from "../snapshot/command-snapshot.ts";
import {
  managedLinkTargetIdentity,
  type ManagedLinkTarget,
} from "../../domain/links/managed-link-schema.ts";
import { applyRemovalWithWriter } from "../removal/removal-apply.ts";
import { planRemoval } from "../removal/removal-plan.ts";
import type { RemovalResult } from "../../domain/reconciliation/removal-schema.ts";
import {
  isNotFound,
  observeDirectory,
  observeRegisteredDirectory,
  observeRepository,
  ProjectStorageError,
  ProjectValidationError,
  requireDirectory,
  type DirectoryObservation,
} from "../projects/project-observation.ts";
import {
  ProjectNotFoundError,
  ProjectRootOwnershipError,
  resolveContainingRoot,
  removingContainingRoot,
  TargetSelectionError,
  projectAllRoots,
} from "../projects/project.ts";
import { type TargetSelector, projectLifecycle } from "../../domain/projects/project-schema.ts";
import {
  ProjectNameSchema,
  reportProjectRecord,
  type ProjectRecord,
} from "../../domain/projects/project-schema.ts";
import {
  diffProjectRoots,
  finalDirectRemoval,
  projectManagedLinks,
  unaccountedProjectEvidenceRoots,
} from "./project-refresh-diff.ts";
import {
  projectRefreshCommandVersion,
  projectRefreshPlanVersion,
  type ProjectRefreshChange,
  type ProjectRefreshCommandPlan,
  type ProjectRefreshCommandResult,
  type ProjectRefreshPlan,
  type ProjectRefreshProject,
  type ProjectRefreshResult,
  type ProjectRefreshScope,
  ProjectRefreshSelectionSchema,
} from "./project-refresh-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";
import type { StateCheckpointWriter, StateOptions } from "../../services/state-store.ts";
import type { StateProject } from "../../domain/state/state-schema.ts";
import { moveProjectRoots, type ProjectRootMoves } from "../../domain/state/project-lifecycle.ts";

// Observation

/** Canonical Git facts observed for one retained project registration. */
export type ProjectRefreshObservation = {
  readonly gitCommonDirectory: string;
  readonly roots: ReadonlyArray<string>;
};

/** Typed failures exposed to project-refresh planning. */
export type ProjectRefreshObservationError =
  | GitCommandError
  | GitOutputParseError
  | ProjectStorageError
  | ProjectValidationError;

const registeredAnchor = requireDirectory({
  missing: { code: "git-anchor-missing", message: "The registered Git anchor is missing." },
  notDirectory: {
    code: "git-anchor-not-directory",
    message: "The registered Git anchor is not a directory.",
  },
  operations: { inspect: "inspect Git anchor", resolve: "resolve Git anchor" },
});

const gitWorktree = requireDirectory({
  missing: { code: "root-missing", message: "A Git-reported worktree is missing." },
  notDirectory: {
    code: "root-not-directory",
    message: "A Git-reported worktree is not a directory.",
  },
  operations: { inspect: "inspect Git worktree", resolve: "resolve Git worktree" },
});

const validateAnchor = (anchor: string) =>
  observeRegisteredDirectory(anchor).pipe(
    Effect.flatMap((observation) =>
      observation._tag === "location-changed"
        ? Effect.fail(
            new ProjectValidationError({
              code: "git-anchor-location-changed",
              message: "The registered Git anchor is no longer canonical.",
              path: anchor,
            }),
          )
        : registeredAnchor(observation),
    ),
  );

/** Git may spell the common directory through a symlink, so compare canonical locations. */
const sameCommonDirectory = (anchor: string) => (observation: DirectoryObservation) =>
  observation._tag === "directory" && observation.path === anchor
    ? Effect.succeed(anchor)
    : Effect.fail(
        new ProjectValidationError({
          code: "git-anchor-location-changed",
          message: "Git resolved a different common directory for the registered anchor.",
          path: anchor,
        }),
      );

/** Observes one registered project's canonical Git anchor and retained worktree roots. */
export const observeProjectRefresh = Effect.fnUntraced(function* (
  project: ProjectRecord,
): Effect.fn.Return<
  ProjectRefreshObservation,
  ProjectRefreshObservationError,
  FileSystem.FileSystem | Git | Path.Path
> {
  const anchor = yield* validateAnchor(project.gitCommonDirectory);
  const { roots } = yield* observeRepository(anchor, {
    commonDirectory: sameCommonDirectory(anchor),
    worktree: gitWorktree,
  });
  return { gitCommonDirectory: anchor, roots };
});

/** Observes whether a project root still exists, without requiring it to be a directory. */
export const projectRootIsReachable = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.stat(root).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      isNotFound(error)
        ? Effect.succeed(false)
        : Effect.fail(
            new ProjectStorageError({
              code: "project-access-failed",
              message: error.message,
              operation: "inspect stale project root",
              path: root,
            }),
          ),
    ),
  );
});

// Planning

/** Reports ownership evidence that prevents safe final project deregistration. */
export class ProjectRefreshEvidenceError extends Schema.TaggedError<ProjectRefreshEvidenceError>()(
  "ProjectRefreshEvidenceError",
  {
    code: Schema.Literal("project-refresh-evidence-unaccounted"),
    projectName: ProjectNameSchema,
    roots: Schema.Array(Schema.String),
  },
) {}

const planProject = Effect.fnUntraced(function* (state: State, project: StateProject) {
  const observation = yield* observeProjectRefresh(project);
  const observedRoots = observation.roots;
  const activeRoots = projectLifecycle(project) === "removing" ? [] : project.roots;
  const staleRoots = activeRoots.filter((root) => observedRoots.includes(root) === false);
  const reachableStaleRoots = yield* Effect.filter(staleRoots, (root) =>
    projectRootIsReachable(root),
  );
  const managedEvidence = projectManagedLinks(state, project.name, staleRoots);
  const diff = diffProjectRoots({
    allowHandoffReactivation:
      projectLifecycle(project) !== "removing" || project.removalIntent !== "project",
    allowNewRoots: project.removalIntent !== "project",
    handoffRoots: project.removingRoots,
    managedEvidenceRoots: managedEvidence.map((evidence) => evidence.target.canonicalPath),
    observedRoots,
    reachableStaleRoots,
    registeredRoots: activeRoots,
  });

  if (finalDirectRemoval(diff.removals)) {
    const unaccountedRoots = unaccountedProjectEvidenceRoots(state, project.name, staleRoots);
    if (unaccountedRoots.length > 0) {
      return yield* new ProjectRefreshEvidenceError({
        code: "project-refresh-evidence-unaccounted",
        projectName: project.name,
        roots: unaccountedRoots,
      });
    }
  }

  for (const root of [...diff.additions, ...diff.reactivations]) {
    const conflictingProject = state.data.projects.find(
      (candidate) => candidate.name !== project.name && projectAllRoots(candidate).includes(root),
    );
    if (conflictingProject !== undefined) {
      return yield* new ProjectRootOwnershipError({
        code: "root-already-registered",
        conflictingProjectName: conflictingProject.name,
        canonicalRoot: root,
        projectName: project.name,
      });
    }
  }

  return {
    additions: diff.additions,
    expectedManagedLinks: managedEvidence,
    expectedProject: reportProjectRecord(project),
    observedRoots: diff.observedRoots,
    reactivations: diff.reactivations,
    removals: diff.removals,
  } satisfies ProjectRefreshProject;
});

/** Builds a deterministic refresh plan, observing Git once per eligible project. */
const planProjectRefreshFromState = Effect.fnUntraced(function* (
  state: State,
  scope: ProjectRefreshScope = { _tag: "all" },
) {
  const eligibleProjects = state.data.projects
    .filter((project) => projectLifecycle(project) === "active" || project.removingRoots.length > 0)
    .filter((project) => scope._tag === "all" || project.name === scope.projectName)
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  if (scope._tag === "project" && eligibleProjects.length === 0) {
    return yield* new ProjectNotFoundError({
      code: "project-not-found",
      projectName: scope.projectName,
    });
  }
  const plannedProjects = yield* Effect.forEach(eligibleProjects, (project) =>
    planProject(state, project),
  );

  const plannedRoots = new Map<string, string>();
  for (const entry of plannedProjects) {
    for (const root of [...entry.additions, ...entry.reactivations]) {
      const prior = plannedRoots.get(root);
      if (prior !== undefined && prior !== entry.expectedProject.name) {
        return yield* new ProjectRootOwnershipError({
          code: "root-already-registered",
          conflictingProjectName: prior,
          canonicalRoot: root,
          projectName: entry.expectedProject.name,
        });
      }
      plannedRoots.set(root, entry.expectedProject.name);
    }
  }

  return {
    kind: "project-refresh-plan",
    projects: plannedProjects,
    scope,
    version: projectRefreshPlanVersion,
  } satisfies ProjectRefreshPlan;
});

// Projection

/** The root moves one refresh entry applies to its project. */
const rootMovesOf = (entry: ProjectRefreshProject): ProjectRootMoves => ({
  additions: entry.additions,
  deregistrations: entry.removals.flatMap((removal) =>
    removal.action === "deregister" ? [removal.canonicalRoot] : [],
  ),
  handoffs: entry.removals.flatMap((removal) =>
    removal.action === "handoff" ? [removal.canonicalRoot] : [],
  ),
  reactivations: entry.reactivations,
});

const rootKey = (projectName: string, root: string) => `${projectName}\u0000${root}`;

const sameLinkRecord = (left: LinkRecord, right: LinkRecord) =>
  left.pendingOnly === right.pendingOnly &&
  left.removal?.cause === right.removal?.cause &&
  JSON.stringify(left.removal?.lastResult) === JSON.stringify(right.removal?.lastResult) &&
  linkEvidenceEqual(left, right);

/** Projects the state and public result produced by one refresh plan. */
const projectRefreshStateProjection = (
  state: State,
  plan: ProjectRefreshPlan,
): { readonly result: ProjectRefreshResult; readonly state: State } => {
  const directRemovalKeys = new Set(
    plan.projects.flatMap((entry) =>
      entry.removals
        .filter((removal) => removal.action === "deregister")
        .map((removal) => rootKey(entry.expectedProject.name, removal.canonicalRoot)),
    ),
  );
  const reactivatedRootKeys = new Set(
    plan.projects.flatMap((entry) =>
      entry.reactivations.map((root) => rootKey(entry.expectedProject.name, root)),
    ),
  );
  const targetKey = (target: ManagedLinkTarget) =>
    target._tag === "project-root" ? rootKey(target.projectName, target.canonicalPath) : undefined;

  // A removed root settles its records outright. A reactivated root cancels the removal its handoff
  // owed, and a record that was only pending then has nothing left to record.
  const kept = state.data.links.flatMap((record): LinkRecord[] => {
    // Docs mounts of a removed root retire with the removal plan, which needs their records.
    if (record.delivery._tag !== "agent") return [record];
    const key = targetKey(record.target);
    if (key !== undefined && directRemovalKeys.has(key)) return [];
    if (
      key !== undefined &&
      reactivatedRootKeys.has(key) &&
      record.removal?.cause === "root-removal"
    ) {
      return record.pendingOnly === true ? [] : [linkEvidenceOf(record)];
    }
    return [record];
  });
  // A root handed off owes the removal of every link it is expected to hold.
  const owed = plan.projects.flatMap((entry) =>
    entry.expectedManagedLinks.flatMap((evidence): LinkChange[] => {
      if (evidence.target._tag !== "project-root") return [];
      const canonicalPath = evidence.target.canonicalPath;
      const removal = entry.removals.find((candidate) => candidate.canonicalRoot === canonicalPath);
      return removal?.action === "handoff"
        ? [{ _tag: "owe", link: agentLink(evidence), cause: "root-removal" }]
        : [];
    }),
  );
  const links = applyLinkChanges(kept, owed);
  const previousLinks = state.data.links;
  const linksChanged =
    links.length !== previousLinks.length ||
    links.some((record, index) => {
      const previous = previousLinks[index];
      return previous === undefined || sameLinkRecord(previous, record) === false;
    });

  const registered = new Set(state.data.projects.map((project) => project.name));
  const entries = plan.projects.filter((entry) => registered.has(entry.expectedProject.name));
  const moved = entries.reduce(
    (current, entry) => moveProjectRoots(current, entry.expectedProject.name, rootMovesOf(entry)),
    state,
  );
  const remaining = new Set(moved.data.projects.map((project) => project.name));
  const changes = entries.flatMap((entry) => {
    const projectName = entry.expectedProject.name;
    return [
      ...entry.additions.map((canonicalRoot): ProjectRefreshChange => ({
        action: "added",
        canonicalRoot,
        projectName,
      })),
      ...entry.reactivations.map((canonicalRoot): ProjectRefreshChange => ({
        action: "reactivated",
        canonicalRoot,
        projectName,
      })),
      ...entry.removals.map((removal): ProjectRefreshChange => ({
        action: removal.action === "handoff" ? "handoff" : "deregistered",
        canonicalRoot: removal.canonicalRoot,
        projectName,
      })),
    ];
  });
  const removedProjects = [...registered].filter((name) => remaining.has(name) === false);
  const projectsChanged = moved !== state;

  const result = {
    changes: sortAndDedupeBy(
      changes,
      (change) => `${change.projectName}\u0000${change.action}\u0000${change.canonicalRoot}`,
    ),
    removedProjects: removedProjects.sort(compareCodeUnits),
    version: projectRefreshPlanVersion,
  } satisfies ProjectRefreshResult;
  const changed = projectsChanged || linksChanged;
  if (changed === false) return { result, state };

  return {
    result,
    state: {
      ...moved,
      data: {
        ...moved.data,
        links,
        projects: [...moved.data.projects].sort((left, right) =>
          compareCodeUnits(left.name, right.name),
        ),
      },
    },
  };
};

// Command

/** One scoped project-refresh command request; the `all` scope covers every registered project. */
export type ProjectRefreshCommandOptions = {
  readonly apply: boolean;
  readonly scope?: ProjectRefreshScope;
  readonly selector?: Extract<TargetSelector, { readonly _tag: "bare" | "project" | "all" }>;
  readonly cwd?: string;
};

/** A composite refresh plan and its optional application outcome. */
type ProjectRefreshCommandExecution = {
  readonly applied?: ProjectRefreshCommandResult;
  readonly plan: ProjectRefreshCommandPlan;
};

/**
 * Roots whose retained evidence the refresh cleanup must settle: every handed-off root, plus a
 * deregistered root that still owns docs links, so its docs evidence retires with the removal
 * plan even though the root itself is gone.
 */
const cleanupTargets = (plan: ProjectRefreshPlan, projected: State) =>
  sortAndDedupeBy(
    plan.projects.flatMap((project) =>
      project.removals.flatMap((removal): ReadonlyArray<ManagedLinkTarget> => {
        const projectName = project.expectedProject.name;
        const ownsDocs = managedDocsLinksOf(projected.data.links).some(
          (link) => link.projectName === projectName && link.root === removal.canonicalRoot,
        );
        return removal.action === "handoff" || ownsDocs
          ? [{ _tag: "project-root", canonicalPath: removal.canonicalRoot, projectName }]
          : [];
      }),
    ),
    managedLinkTargetIdentity,
  );

const docsScope = (scope: ProjectRefreshScope): DocsLinkScope =>
  scope._tag === "project" ? { projectName: scope.projectName } : {};

const planCommand = Effect.fnUntraced(function* (
  snapshot: CommandSnapshot,
  scope: ProjectRefreshScope,
  selection: typeof ProjectRefreshSelectionSchema.Type,
) {
  const { state } = snapshot;
  const refresh = yield* planProjectRefreshFromState(state, scope);
  const projected = projectRefreshStateProjection(state, refresh).state;
  const targets = cleanupTargets(refresh, projected);
  const removals =
    targets.length === 0
      ? []
      : [yield* planRemoval(projected, { scope: { _tag: "retry-targets", targets } })];
  // Docs reconcile runs after the removals, so it plans against the docs evidence they leave.
  const removedDocs = new Set(
    removals.flatMap((removal) =>
      (removal.docsActions ?? []).map((action) => action.evidence.destinationPath),
    ),
  );
  const docs = yield* planDocsLinks(
    {
      ...projected,
      data: {
        ...projected.data,
        links: projected.data.links.filter(
          (record) =>
            record.delivery._tag !== "docs" || removedDocs.has(record.destinationPath) === false,
        ),
      },
    },
    yield* snapshot.catalog,
    docsScope(scope),
  );
  // Only the roots refresh adds or brings back are new here; the kept ones were reported before.
  const handMade = yield* observeRootHandMadeEntries(
    state,
    refresh.projects.flatMap((project) => [...project.additions, ...project.reactivations]),
  );
  return {
    docs,
    handMade,
    kind: "project-refresh-command-plan",
    refresh,
    removals,
    selection,
    version: projectRefreshCommandVersion,
  } satisfies ProjectRefreshCommandPlan;
});

/**
 * Commits the root transition, settles its cleanup, then reconciles docs. Once the transition is
 * committed, a docs conflict is reported in `docs` rather than failing the command, so the
 * result still accounts for the work already applied.
 */
const applyCommand = Effect.fnUntraced(function* (
  writer: StateCheckpointWriter,
  plan: ProjectRefreshCommandPlan,
) {
  const refresh = yield* writer.checkpoint((state) => {
    const transition = projectRefreshStateProjection(state, plan.refresh);
    return Effect.succeed({ state: transition.state, value: transition.result });
  });
  const removals: Array<RemovalResult> = [];
  for (const removal of plan.removals)
    removals.push(yield* applyRemovalWithWriter(writer, removal));
  const docs = yield* applyDocsPlan(writer, plan.docs);
  return {
    docs,
    kind: "project-refresh-command-application",
    refresh,
    removals,
    version: projectRefreshCommandVersion,
  } satisfies ProjectRefreshCommandResult;
});

/** Plans, and optionally applies, one scoped refresh and its cleanup under one state-writer lock. */
export const runProjectRefreshCommand = Effect.fn("refresh.runProjectRefreshCommand")(function* (
  stateOptions: StateOptions,
  options: ProjectRefreshCommandOptions,
) {
  const execution: ProjectRefreshCommandExecution = yield* previewOrApply(stateOptions, {
    apply: options.apply,
    plan: (snapshot) =>
      Effect.gen(function* () {
        const { state } = snapshot;
        const selector =
          options.selector ??
          (options.scope?._tag === "project"
            ? { _tag: "project" as const, projectName: options.scope.projectName }
            : { _tag: "all" as const });
        if (selector._tag === "all")
          return yield* planCommand(snapshot, { _tag: "all" }, { selector });
        if (selector._tag === "project")
          return yield* planCommand(snapshot, selector, {
            selector,
            projectName: selector.projectName,
          });
        const cwd = options.cwd ?? (yield* Path.Path).resolve(".");
        const { canonicalCwd, containing } = yield* resolveContainingRoot(state, cwd);
        const requestedCwd = options.cwd === undefined ? {} : { cwd: canonicalCwd };
        const git = yield* Git;
        const gitDirectory = yield* git.resolveCommonDirectory(canonicalCwd).pipe(
          Effect.flatMap((directory) => observeDirectory(directory, canonicalCwd)),
          Effect.map((observation) =>
            observation._tag === "directory" ? observation.path : undefined,
          ),
          Effect.catch(() => Effect.succeed(undefined)),
        );
        const gitProject = state.data.projects.find(
          (project) => project.gitCommonDirectory === gitDirectory,
        );
        if (gitProject !== undefined) {
          return yield* planCommand(
            snapshot,
            { _tag: "project", projectName: gitProject.name },
            {
              ...requestedCwd,
              selector,
              projectName: gitProject.name,
              matchedBy: {
                _tag: "git-directory",
                gitCommonDirectory: gitProject.gitCommonDirectory,
              },
            },
          );
        }
        if (containing !== undefined) {
          return yield* planCommand(
            snapshot,
            { _tag: "project", projectName: containing.projectName },
            {
              ...requestedCwd,
              selector,
              projectName: containing.projectName,
              matchedBy: { _tag: "containing-root", root: containing.root },
            },
          );
        }
        const removing = removingContainingRoot(state, canonicalCwd, yield* Path.Path);
        return yield* new TargetSelectionError({
          code: "bare-target-requires-registered-root",
          message:
            "This directory is not inside a registered project. Choose --project NAME or --all.",
          path: canonicalCwd,
          ...(removing === undefined ? {} : removing),
        });
      }),
    applyPlan: applyCommand,
  });
  return execution;
});
