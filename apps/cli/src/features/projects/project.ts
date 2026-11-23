import { profileApplicationFor } from "../../domain/profiles/profile-application.ts";
import { Effect, FileSystem, Match, Path, Schema } from "effect";
import { Git, GitCommandError, GitOutputParseError } from "../../services/git.ts";
import type { Destination } from "../../services/destination.ts";
import { sortAndDedupeBy } from "../../domain/identity/ordering.ts";
import { isInside } from "../../domain/identity/path-containment.ts";
import { NextCommandsSchema } from "../../domain/hints/next-commands.ts";
import { HandMadeEntrySchema } from "../../domain/agents/hand-made-entry.ts";
import { observeRootHandMadeEntries } from "../hand-made/hand-made-entries.ts";
import {
  ProjectNameSchema,
  ProjectRecordSchema,
  projectRecordView,
  type ProjectRecord,
  projectLifecycle,
  type TargetSelector,
  type ProjectRootIssueCode,
  ProjectUnhealthyRootIssueCodeSchema,
  type ProjectUnhealthyRootIssueCode,
} from "../../domain/projects/project-schema.ts";
import {
  observeDirectory,
  observeRegisteredDirectory,
  observeRepository,
  ProjectStorageError,
  ProjectValidationError,
  requireDirectory,
  type DirectoryCheck,
} from "./project-observation.ts";
import {
  mutateState,
  StateBusyError,
  StateConfigurationError,
  StateCorruptError,
  StateFormatUnsupportedError,
  StateMutationError,
  StateNotInitializedError,
  StateStorageError,
  StateStore,
  type StateMutation,
  type StateOptions,
} from "../../services/state-store.ts";
import { type State } from "../../domain/state/state-schema.ts";
import type { ManagedLinkTarget } from "../../domain/links/managed-link-schema.ts";

export { ProjectStorageError, ProjectValidationError } from "./project-observation.ts";

/** Reports an exact canonical root already owned by another project. */
export class ProjectRootOwnershipError extends Schema.TaggedError<ProjectRootOwnershipError>()(
  "ProjectRootOwnershipError",
  {
    code: Schema.Literal("root-already-registered"),
    conflictingProjectName: Schema.String,
    canonicalRoot: Schema.String,
    projectName: Schema.String,
  },
) {}

/** The registration a project name already has, and the one the command observed. */
const projectRegistrationConflictFields = {
  existingAnchor: Schema.String,
  existingRoots: Schema.Array(Schema.String),
  observedAnchor: Schema.String,
  observedRoots: Schema.Array(Schema.String),
  projectName: Schema.String,
};

/** Reports an attempted replacement of an existing project registration. */
export class ProjectRegistrationConflictError extends Schema.TaggedError<ProjectRegistrationConflictError>()(
  "ProjectRegistrationConflictError",
  {
    code: Schema.Literal("project-registration-conflict"),
    ...projectRegistrationConflictFields,
  },
) {}

/** The details of a `project-registration-conflict` diagnostic: the error's fields but its code. */
export const ProjectRegistrationConflictDetailsSchema = Schema.Struct(
  projectRegistrationConflictFields,
);

/** Reports an explicit selector for an unknown project namespace. */
export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  {
    code: Schema.Literal("project-not-found"),
    projectName: Schema.String,
  },
) {}

/** Reports that a bare target command cannot select a registered project from its cwd. */
export class TargetSelectionError extends Schema.TaggedError<TargetSelectionError>()(
  "TargetSelectionError",
  {
    code: Schema.Literals([
      "bare-target-requires-registered-root",
      "current-directory-unavailable",
    ]),
    message: Schema.String,
    path: Schema.optionalKey(Schema.String),
    projectName: Schema.optionalKey(Schema.String),
    root: Schema.optionalKey(Schema.String),
    /** The command that makes the directory selectable, when one does. */
    next: Schema.optionalKey(NextCommandsSchema),
  },
) {}

const projectRootsFrom = (state: State) => state.data.projects;

/** Returns the registered projects whose lifecycle is active. */
export const activeProjects = (state: State): ReadonlyArray<ProjectRecord> =>
  projectRootsFrom(state).filter((project) => projectLifecycle(project) === "active");

/** Returns active and retained handoff roots for ownership checks. */
export const projectAllRoots = (project: ProjectRecord): ReadonlyArray<string> => [
  ...project.roots,
  ...(project.removingRoots ?? []),
];

type DirectoryKind = "anchor" | "repository-cwd" | "root";

const directoryChecks: Record<DirectoryKind, DirectoryCheck> = {
  anchor: requireDirectory({
    missing: { code: "git-anchor-missing", message: "The project directory does not exist." },
    notDirectory: {
      code: "git-anchor-not-directory",
      message: "The project path is not a directory.",
    },
    operations: { inspect: "inspect project directory", resolve: "resolve project directory" },
  }),
  "repository-cwd": requireDirectory({
    missing: { code: "repository-cwd-missing", message: "The project directory does not exist." },
    notDirectory: {
      code: "repository-cwd-not-directory",
      message: "The project path is not a directory.",
    },
    operations: { inspect: "inspect project directory", resolve: "resolve project directory" },
  }),
  root: requireDirectory({
    missing: { code: "root-missing", message: "The project directory does not exist." },
    notDirectory: { code: "root-not-directory", message: "The project path is not a directory." },
    operations: { inspect: "inspect project directory", resolve: "resolve project directory" },
  }),
};

const canonicalExistingDirectory = (candidate: string, kind: DirectoryKind) =>
  observeDirectory(candidate).pipe(Effect.flatMap(directoryChecks[kind]));

const validateProjectName = Effect.fnUntraced(function* (name: string) {
  const decoded = yield* Schema.decodeUnknownEffect(ProjectNameSchema)(name).pipe(
    Effect.mapError(
      () =>
        new ProjectValidationError({
          code: "project-name-invalid",
          message: "Project names must be safe identifier labels.",
        }),
    ),
  );

  return decoded;
});

/** The input needed to register one project from a Git worktree. */
export type RegisterProjectOptions = {
  readonly name: string;
  readonly repositoryCwd: string;
};

/**
 * The `project add` payload: the project's registration, whether it already existed, and the
 * hand-made entries in its worktrees' agent folders.
 */
export const ProjectRegistrationPayloadSchema = Schema.Struct({
  kind: Schema.Literal("project-registration"),
  alreadyRegistered: Schema.Boolean,
  project: ProjectRecordSchema,
  handMade: Schema.Array(HandMadeEntrySchema).annotate({
    description:
      "Entries in the skill and command folders of the enabled agents, in every root of the project, that Tack has no record of. project add leaves them untouched.",
  }),
});

/** The result of registering or confirming one project namespace. */
export type RegisterProjectResult = Omit<typeof ProjectRegistrationPayloadSchema.Type, "kind">;

const sameRoots = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((root, index) => root === right[index]);

const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const normalizeRoots = Effect.fnUntraced(function* (
  roots: ReadonlyArray<string>,
): Effect.fn.Return<readonly [string, ...Array<string>], ProjectValidationError> {
  const sorted = [...new Set(roots)].sort(compareStrings);
  const first = sorted[0];

  if (first === undefined) {
    return yield* new ProjectValidationError({
      code: "no-worktree-roots",
      message: "Git did not report any reachable non-bare worktree roots.",
    });
  }

  const result: readonly [string, ...Array<string>] = [first, ...sorted.slice(1)];
  return result;
});

const projectFromRegistration = (
  name: string,
  gitCommonDirectory: string,
  roots: readonly [string, ...Array<string>],
) => ({ name, gitCommonDirectory, roots }) satisfies ProjectRecord;

const rootConflict = (projects: ReadonlyArray<ProjectRecord>, project: ProjectRecord) =>
  projectAllRoots(project).flatMap((root) =>
    projects.flatMap((candidate) =>
      candidate.name !== project.name && projectAllRoots(candidate).includes(root)
        ? [{ canonicalRoot: root, projectName: candidate.name }]
        : [],
    ),
  )[0];

/**
 * Whether Git refused to name a common directory because the directory is in no repository. Git
 * exits 128 for every fatal error, such as a repository it does not trust, so the message decides.
 */
const isOutsideRepository = (error: GitCommandError) =>
  error.exitCode === 128 &&
  error.args.includes("--git-common-dir") &&
  /not a git repository/i.test(error.stderr);

const notInRepository = (name: string, repositoryCwd: string) =>
  new ProjectValidationError({
    code: "repository-cwd-not-in-git",
    message: "This directory is not inside a Git repository.",
    path: repositoryCwd,
    next: [["tack", "project", "add", name, "--repository-cwd", "PATH"]],
  });

/**
 * Registers a project from Git's current reachable non-bare worktrees, and reports the hand-made
 * entries in their agent folders without touching them.
 */
export const registerProject = Effect.fn("projects.registerProject")(function* (
  stateOptions: StateOptions,
  options: RegisterProjectOptions,
): Effect.fn.Return<
  RegisterProjectResult,
  | GitCommandError
  | GitOutputParseError
  | ProjectRegistrationConflictError
  | ProjectRootOwnershipError
  | ProjectStorageError
  | ProjectValidationError
  | StateBusyError
  | StateConfigurationError
  | StateCorruptError
  | StateFormatUnsupportedError
  | StateMutationError
  | StateNotInitializedError
  | StateStorageError,
  Destination | FileSystem.FileSystem | Git | Path.Path | StateStore
> {
  return yield* mutateState(stateOptions, (state) =>
    Effect.gen(function* (): Effect.fn.Return<
      StateMutation<RegisterProjectResult>,
      | GitCommandError
      | GitOutputParseError
      | ProjectRegistrationConflictError
      | ProjectRootOwnershipError
      | ProjectStorageError
      | ProjectValidationError,
      Destination | FileSystem.FileSystem | Git | Path.Path
    > {
      const name = yield* validateProjectName(options.name);
      const repositoryCwd = yield* canonicalExistingDirectory(
        options.repositoryCwd,
        "repository-cwd",
      );
      const { gitCommonDirectory, roots } = yield* observeRepository(repositoryCwd, {
        commonDirectory: directoryChecks.anchor,
        worktree: directoryChecks.root,
      }).pipe(
        Effect.catchTag("GitCommandError", (error) =>
          Effect.fail(isOutsideRepository(error) ? notInRepository(name, repositoryCwd) : error),
        ),
      );
      const normalizedRoots = yield* normalizeRoots(roots);
      const observedProject = projectFromRegistration(name, gitCommonDirectory, normalizedRoots);
      const projects = projectRootsFrom(state);
      const existing = projects.find((project) => project.name === name);

      if (existing !== undefined) {
        if (
          existing.gitCommonDirectory === observedProject.gitCommonDirectory &&
          sameRoots(existing.roots, observedProject.roots) &&
          projectLifecycle(existing) === "active" &&
          existing.removingRoots.length === 0
        ) {
          return {
            state,
            value: {
              alreadyRegistered: true,
              project: projectRecordView(existing),
              handMade: yield* observeRootHandMadeEntries(state, existing.roots),
            },
          } satisfies StateMutation<RegisterProjectResult>;
        }

        return yield* new ProjectRegistrationConflictError({
          code: "project-registration-conflict",
          existingAnchor: existing.gitCommonDirectory,
          existingRoots: [...existing.roots],
          observedAnchor: observedProject.gitCommonDirectory,
          observedRoots: [...observedProject.roots],
          projectName: name,
        });
      }

      const conflict = rootConflict(projects, observedProject);
      if (conflict !== undefined) {
        return yield* new ProjectRootOwnershipError({
          code: "root-already-registered",
          conflictingProjectName: conflict.projectName,
          canonicalRoot: conflict.canonicalRoot,
          projectName: name,
        });
      }

      const nextProjects = [...projects, { ...observedProject, removingRoots: [] }].sort(
        (left, right) => compareStrings(left.name, right.name),
      );

      return {
        state: {
          ...state,
          data: {
            ...state.data,
            projects: nextProjects,
          },
        },
        value: {
          alreadyRegistered: false,
          project: observedProject,
          handMade: yield* observeRootHandMadeEntries(state, observedProject.roots),
        },
      } satisfies StateMutation<RegisterProjectResult>;
    }),
  );
});

const projectAnchorIssueCodes = [
  "anchor-access-failed",
  "anchor-location-changed",
  "anchor-missing",
  "anchor-not-directory",
] as const;
type ProjectAnchorIssueCode = (typeof projectAnchorIssueCodes)[number];

/** An observed problem of an anchor or root, with the given codes. */
const inspectionIssue = <Code extends Schema.Top>(code: Code) =>
  Schema.Struct({ code, message: Schema.String });

/** A root's observed health without changing its persisted registration. */
const ProjectRootInspectionSchema = Schema.Union([
  Schema.Struct({
    issue: Schema.optionalKey(Schema.Never),
    root: Schema.String,
    status: Schema.Literal("active"),
  }),
  Schema.Struct({
    issue: inspectionIssue(Schema.Literal("root-missing")),
    root: Schema.String,
    status: Schema.Literal("stale"),
  }),
  Schema.Struct({
    issue: inspectionIssue(ProjectUnhealthyRootIssueCodeSchema),
    root: Schema.String,
    status: Schema.Literal("unhealthy"),
  }),
]);

/** A root's observed health without changing its persisted registration. */
export type ProjectRootInspection = typeof ProjectRootInspectionSchema.Type;

/** The observed health of a project's git common directory. */
const ProjectAnchorInspectionSchema = Schema.Union([
  Schema.Struct({
    issue: Schema.optionalKey(Schema.Never),
    path: Schema.String,
    status: Schema.Literal("healthy"),
  }),
  Schema.Struct({
    issue: inspectionIssue(Schema.Literals(projectAnchorIssueCodes)),
    path: Schema.String,
    status: Schema.Literal("unhealthy"),
  }),
]);

type CanonicalDirectoryInspection<IssueCode extends string> =
  | { readonly status: "healthy" }
  | {
      readonly issue: { readonly code: IssueCode; readonly message: string };
      readonly status: "unhealthy";
    };

/** The read-only observed health of one registered project. */
const ProjectInspectionSchema = Schema.Struct({
  anchor: ProjectAnchorInspectionSchema,
  project: ProjectRecordSchema,
  roots: Schema.Array(ProjectRootInspectionSchema),
});

/** The read-only observed health of one registered project. */
export type ProjectInspection = typeof ProjectInspectionSchema.Type;

/** The `project` payload: the observed health of every registered project. */
export const ProjectInspectionsPayloadSchema = Schema.Struct({
  kind: Schema.Literal("project-inspections"),
  projects: Schema.Array(ProjectInspectionSchema),
});

const inspectCanonicalDirectory = <IssueCode extends string>(
  registeredPath: string,
  codes: {
    readonly accessFailed: IssueCode;
    readonly locationChanged: IssueCode;
    readonly missing: IssueCode;
    readonly notDirectory: IssueCode;
  },
) =>
  observeRegisteredDirectory(registeredPath).pipe(
    Effect.map((observation): CanonicalDirectoryInspection<IssueCode> => {
      const issue = (code: IssueCode, message: string) => ({
        issue: { code, message },
        status: "unhealthy" as const,
      });
      return Match.valueTags(observation, {
        directory: () => ({ status: "healthy" as const }),
        "not-directory": () =>
          issue(codes.notDirectory, "The registered project path is no longer a directory."),
        "location-changed": () =>
          issue(codes.locationChanged, "The registered path resolves elsewhere."),
        missing: () => issue(codes.missing, "The registered project path is missing."),
        "access-failed": ({ error }) => issue(codes.accessFailed, error.message),
      });
    }),
  );

const anchorDirectoryCodes = {
  accessFailed: "anchor-access-failed",
  locationChanged: "anchor-location-changed",
  missing: "anchor-missing",
  notDirectory: "anchor-not-directory",
} as const satisfies Record<
  keyof {
    readonly accessFailed: unknown;
    readonly locationChanged: unknown;
    readonly missing: unknown;
    readonly notDirectory: unknown;
  },
  ProjectAnchorIssueCode
>;

const rootDirectoryCodes = {
  accessFailed: "root-access-failed",
  locationChanged: "root-location-changed",
  missing: "root-missing",
  notDirectory: "root-not-directory",
} as const satisfies Record<
  keyof {
    readonly accessFailed: unknown;
    readonly locationChanged: unknown;
    readonly missing: unknown;
    readonly notDirectory: unknown;
  },
  ProjectRootIssueCode
>;

/** Observes one registered project root, active or retained for removal, without changing it. */
export const inspectProjectRoot = (root: string) =>
  inspectCanonicalDirectory(root, rootDirectoryCodes).pipe(
    Effect.map((result): ProjectRootInspection => {
      if (result.status === "healthy") {
        return { root, status: "active" };
      }
      const { code, message } = result.issue;
      if (code === "root-missing") {
        return { issue: { code, message }, root, status: "stale" };
      }
      return { issue: { code, message }, root, status: "unhealthy" };
    }),
  );

const inspectProject = Effect.fnUntraced(function* (
  project: ProjectRecord,
): Effect.fn.Return<ProjectInspection, never, FileSystem.FileSystem | Path.Path> {
  const anchor = yield* inspectCanonicalDirectory(project.gitCommonDirectory, anchorDirectoryCodes);
  const roots = yield* Effect.forEach(project.roots, inspectProjectRoot);

  return {
    anchor:
      anchor.status === "healthy"
        ? { path: project.gitCommonDirectory, status: "healthy" }
        : {
            issue: anchor.issue,
            path: project.gitCommonDirectory,
            status: "unhealthy",
          },
    project: projectRecordView(project),
    roots,
  };
});

/** Inspects registered projects and roots from one validated state snapshot. */
export const inspectProjects = Effect.fnUntraced(function* (state: State) {
  return yield* Effect.forEach(projectRootsFrom(state), (project) => inspectProject(project));
});

/** A durable cleanup destination that can be included by later maintenance phases. */
export type PendingRemoval =
  | { readonly _tag: "project"; readonly canonicalPath: string; readonly projectName: string }
  | { readonly _tag: "user"; readonly canonicalPath: string };

/** One selected managed destination. */
export type ManagedTarget =
  | { readonly _tag: "project-root"; readonly canonicalPath: string; readonly projectName: string }
  | { readonly _tag: "user"; readonly canonicalPath: string }
  | {
      readonly _tag: "pending-removal";
      readonly canonicalPath: string;
      readonly pending: PendingRemoval;
    };

/** Inputs to target selection. */
export type SelectTargetsOptions = {
  readonly cwd: string;
  readonly selector: TargetSelector;
  readonly userTarget?: string;
};

/** The selected targets and retained stale-root diagnostics. */
export type TargetSelection = {
  readonly containingRoot?: ContainingRoot;
  readonly selector: TargetSelector;
  readonly staleRoots: ReadonlyArray<{
    readonly canonicalPath: string;
    readonly code: "root-missing";
    readonly projectName: string;
  }>;
  readonly unhealthyRoots: ReadonlyArray<{
    readonly canonicalPath: string;
    readonly code: ProjectUnhealthyRootIssueCode;
    readonly message: string;
    readonly projectName: string;
  }>;
  readonly targets: ReadonlyArray<ManagedTarget>;
};

/** What a command was asked to select and what it resolved. */
export type SelectionEcho = Pick<TargetSelection, "containingRoot" | "selector" | "targets">;

/** The public echo of a target selection, without its root-health observations. */
export const selectionEcho = (selection: TargetSelection): SelectionEcho => ({
  ...(selection.containingRoot === undefined ? {} : { containingRoot: selection.containingRoot }),
  selector: selection.selector,
  targets: selection.targets,
});

const pathDepth = (path: Path.Path, value: string) =>
  value.split(path.sep).filter((segment) => segment.length > 0).length;

/** One registered active root and the project namespace that owns it. */
export type ContainingRoot = { readonly projectName: string; readonly root: string };

/** A canonical working directory and the deepest active registered root containing it. */
export type ContainingRootResolution = {
  readonly canonicalCwd: string;
  /** Absent when no matching active registered root contains the canonical directory. */
  readonly containing?: ContainingRoot;
};

/**
 * Resolves a working directory to the deepest active registered root containing it, so a
 * repository nested inside another registered repository resolves to the inner project. Every
 * prefix of a canonical directory is itself canonical, so lexical containment over registered
 * canonical roots needs no further root observation. `projectName` limits the candidates to one
 * project, for callers that already chose the project and only need its containing root.
 */
export const resolveContainingRoot = Effect.fnUntraced(function* (
  state: State,
  cwd: string,
  options: { readonly projectName?: string } = {},
): Effect.fn.Return<
  ContainingRootResolution,
  ProjectStorageError | TargetSelectionError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const canonicalCwd = yield* canonicalExistingDirectory(cwd, "repository-cwd").pipe(
    Effect.mapError((error) =>
      error._tag === "ProjectValidationError"
        ? new TargetSelectionError({
            code: "current-directory-unavailable",
            message: error.message,
            ...(error.path === undefined ? {} : { path: error.path }),
          })
        : error,
    ),
  );
  const containing = activeProjects(state)
    .filter((project) => options.projectName === undefined || project.name === options.projectName)
    .flatMap((project) =>
      project.roots.flatMap((root) =>
        isInside(root, canonicalCwd) ? [{ projectName: project.name, root }] : [],
      ),
    )
    // Containing roots are distinct prefixes of one canonical path, so their depths differ.
    .reduce<ContainingRoot | undefined>(
      (deepest, candidate) =>
        deepest === undefined || pathDepth(path, candidate.root) > pathDepth(path, deepest.root)
          ? candidate
          : deepest,
      undefined,
    );
  return containing === undefined ? { canonicalCwd } : { canonicalCwd, containing };
});

/** Finds the deepest retained root being removed, for a bare-selection failure detail. */
export const removingContainingRoot = (state: State, canonicalCwd: string, path: Path.Path) =>
  projectRootsFrom(state)
    .flatMap((project) =>
      project.removingRoots.flatMap((root) =>
        isInside(root, canonicalCwd) ? [{ projectName: project.name, root }] : [],
      ),
    )
    .sort((left, right) => pathDepth(path, right.root) - pathDepth(path, left.root))[0];

const staleRootsFrom = (projects: ReadonlyArray<ProjectInspection>) =>
  projects.flatMap((inspection) =>
    inspection.roots.flatMap((root) =>
      root.status === "stale"
        ? [
            {
              canonicalPath: root.root,
              code: root.issue.code,
              projectName: inspection.project.name,
            },
          ]
        : [],
    ),
  );

const unhealthyRootsFrom = (projects: ReadonlyArray<ProjectInspection>) =>
  projects.flatMap((inspection) =>
    inspection.roots.flatMap((root) =>
      root.status === "unhealthy"
        ? [
            {
              canonicalPath: root.root,
              code: root.issue.code,
              message: root.issue.message,
              projectName: inspection.project.name,
            },
          ]
        : [],
    ),
  );

const activeProjectTargets = (projects: ReadonlyArray<ProjectInspection>) =>
  projects.flatMap((inspection) =>
    inspection.roots.flatMap((root) =>
      projectLifecycle(inspection.project) === "active" && root.status === "active"
        ? [
            {
              _tag: "project-root" as const,
              canonicalPath: root.root,
              projectName: inspection.project.name,
            },
          ]
        : [],
    ),
  );

const pendingTargets = (
  pendingRemovals: ReadonlyArray<PendingRemoval>,
  predicate: (pending: PendingRemoval) => boolean,
) =>
  pendingRemovals
    .filter((pending) => predicate(pending))
    .map((pending) => ({
      _tag: "pending-removal" as const,
      canonicalPath: pending.canonicalPath,
      pending,
    }));

/** The targets of every owed removal, agent link or docs mount, one derivation for both. */
const pendingTargetsFromState = (state: State): ReadonlyArray<PendingRemoval> =>
  state.data.links.flatMap((record): ReadonlyArray<PendingRemoval> =>
    record.removal === undefined
      ? []
      : [
          record.target._tag === "project-root"
            ? {
                _tag: "project" as const,
                canonicalPath: record.target.canonicalPath,
                projectName: record.target.projectName,
              }
            : { _tag: "user" as const, canonicalPath: record.target.canonicalPath },
        ],
  );

const pendingRemovalIdentity = (pending: PendingRemoval) => {
  if (pending._tag === "project") {
    return `project\u0000${pending.projectName}\u0000${pending.canonicalPath}`;
  }
  return `user\u0000${pending.canonicalPath}`;
};

/** Returns the stable identity and ordering key for one selected target. */
const managedTargetIdentity = (target: ManagedTarget) => {
  if (target._tag === "project-root") {
    return `0-project-root\u0000${target.projectName}\u0000${target.canonicalPath}`;
  }
  if (target._tag === "user") {
    return `1-user\u0000${target.canonicalPath}`;
  }
  return `2-pending-removal\u0000${pendingRemovalIdentity(target.pending)}`;
};

/** The user and project-root targets of a selection: the ones reconciliation plans links for. */
export const linkTargetsOf = (selection: TargetSelection): ReadonlyArray<ManagedLinkTarget> =>
  selection.targets.flatMap((target) => (target._tag === "pending-removal" ? [] : [target]));

const staleRootIdentity = (root: TargetSelection["staleRoots"][number]) =>
  `${root.projectName}\u0000${root.canonicalPath}\u0000${root.code}`;

const unhealthyRootIdentity = (root: TargetSelection["unhealthyRoots"][number]) =>
  `${root.projectName}\u0000${root.canonicalPath}\u0000${root.code}\u0000${root.message}`;

const normalizeTargetSelection = (selection: TargetSelection): TargetSelection => ({
  ...(selection.containingRoot === undefined ? {} : { containingRoot: selection.containingRoot }),
  selector: selection.selector,
  staleRoots: sortAndDedupeBy(selection.staleRoots, staleRootIdentity),
  unhealthyRoots: sortAndDedupeBy(selection.unhealthyRoots, unhealthyRootIdentity),
  targets: sortAndDedupeBy(selection.targets, managedTargetIdentity),
});

const canonicalManagedPath = Effect.fnUntraced(function* (candidate: string) {
  const path = yield* Path.Path;
  // Pending-removal evidence can name an unavailable destination. It was canonicalized when
  // persisted, so selection only normalizes its lexical absolute spelling and never re-observes it.
  return path.resolve(candidate);
});

const targetUser = (canonicalPath: string): ManagedTarget => ({
  _tag: "user",
  canonicalPath,
});

/** Resolves bare, project, user, and all target selectors against one state snapshot. */
export const selectTargets = Effect.fnUntraced(function* (
  state: State,
  stateOptions: StateOptions,
  options: SelectTargetsOptions,
): Effect.fn.Return<
  TargetSelection,
  | ProjectNotFoundError
  | ProjectStorageError
  | ProjectValidationError
  | StateConfigurationError
  | TargetSelectionError,
  FileSystem.FileSystem | Path.Path
> {
  const pendingRemovals = sortAndDedupeBy(
    yield* Effect.forEach(pendingTargetsFromState(state), (pending) =>
      canonicalManagedPath(pending.canonicalPath).pipe(
        Effect.map((canonicalPath) => ({ ...pending, canonicalPath })),
      ),
    ),
    pendingRemovalIdentity,
  );
  // Only selectors that reach the user target need the operator home.
  const userTarget = Effect.suspend(() => {
    const home = options.userTarget ?? stateOptions.homeDirectory;
    return home === undefined
      ? Effect.fail(
          new StateConfigurationError({ message: "The operator home directory is unavailable." }),
        )
      : profileApplicationFor(state, { _tag: "user" }) === undefined
        ? canonicalManagedPath(home)
        : Effect.flatMap(FileSystem.FileSystem, (fs) => fs.realPath(home)).pipe(
            Effect.catch(() => canonicalManagedPath(home)),
          );
  });

  if (options.selector._tag === "user") {
    return normalizeTargetSelection({
      selector: options.selector,
      staleRoots: [],
      unhealthyRoots: [],
      targets: [
        targetUser(yield* userTarget),
        ...pendingTargets(pendingRemovals, (pending) => pending._tag === "user"),
      ],
    });
  }

  if (options.selector._tag === "project") {
    const projectName = options.selector.projectName;
    const retainedPendingTargets = pendingTargets(
      pendingRemovals,
      (pending) => pending._tag === "project" && pending.projectName === projectName,
    );
    const registeredProject = projectRootsFrom(state).find(
      (project) => project.name === projectName,
    );
    if (registeredProject === undefined) {
      return retainedPendingTargets.length === 0
        ? yield* new ProjectNotFoundError({
            code: "project-not-found",
            projectName,
          })
        : normalizeTargetSelection({
            selector: options.selector,
            staleRoots: [],
            targets: retainedPendingTargets,
            unhealthyRoots: [],
          });
    }
    const project = yield* inspectProject(registeredProject);
    const staleRoots = staleRootsFrom([project]);
    const unhealthyRoots = unhealthyRootsFrom([project]);

    return normalizeTargetSelection({
      selector: options.selector,
      staleRoots: staleRoots.filter((root) => root.projectName === project.project.name),
      unhealthyRoots: unhealthyRoots.filter((root) => root.projectName === project.project.name),
      targets: [...activeProjectTargets([project]), ...retainedPendingTargets],
    });
  }

  if (options.selector._tag === "bare") {
    const { canonicalCwd, containing } = yield* resolveContainingRoot(state, options.cwd);
    if (containing === undefined) {
      const path = yield* Path.Path;
      const removing = removingContainingRoot(state, canonicalCwd, path);
      return yield* new TargetSelectionError({
        code: "bare-target-requires-registered-root",
        message:
          "This directory is not inside a registered project. Choose --project NAME, --user or --all.",
        path: canonicalCwd,
        ...(removing === undefined ? {} : removing),
      });
    }
    const selected = yield* selectTargets(state, stateOptions, {
      ...options,
      selector: { _tag: "project", projectName: containing.projectName },
    });
    return normalizeTargetSelection({
      ...selected,
      containingRoot: containing,
      selector: options.selector,
    });
  }

  const projects = yield* Effect.forEach(projectRootsFrom(state), (project) =>
    inspectProject(project),
  );
  return normalizeTargetSelection({
    selector: options.selector,
    staleRoots: staleRootsFrom(projects),
    unhealthyRoots: unhealthyRootsFrom(projects),
    targets: [
      ...activeProjectTargets(projects),
      targetUser(yield* userTarget),
      ...pendingTargets(pendingRemovals, () => true),
    ],
  });
});
