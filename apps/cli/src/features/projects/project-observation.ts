import { Effect, FileSystem, Match, Path, PlatformError, Schema } from "effect";
import {
  Git,
  type GitCommandError,
  type GitOutputParseError,
  type GitWorktree,
} from "../../services/git.ts";
import { sortAndDedupeStrings } from "../../domain/identity/ordering.ts";
import { NextCommandsSchema } from "../../domain/hints/next-commands.ts";

const projectValidationCodes = [
  "project-name-invalid",
  "repository-cwd-missing",
  "repository-cwd-not-directory",
  "repository-cwd-not-in-git",
  "git-anchor-missing",
  "git-anchor-not-directory",
  "git-anchor-location-changed",
  "root-missing",
  "root-not-directory",
  "root-location-changed",
  "no-worktree-roots",
] as const;

/** A stable reason a project name, anchor, or root is not acceptable. */
type ProjectValidationCode = (typeof projectValidationCodes)[number];

/** Reports an invalid project name, anchor, or root discovered during registration. */
export class ProjectValidationError extends Schema.TaggedError<ProjectValidationError>()(
  "ProjectValidationError",
  {
    code: Schema.Literals(projectValidationCodes),
    message: Schema.String,
    path: Schema.optionalKey(Schema.String),
    /** The command that registers the project once the operator supplies what is missing. */
    next: Schema.optionalKey(NextCommandsSchema),
  },
) {}

/** Reports an unexpected filesystem failure while observing a project. */
export class ProjectStorageError extends Schema.TaggedError<ProjectStorageError>()(
  "ProjectStorageError",
  {
    code: Schema.Literal("project-access-failed"),
    message: Schema.String,
    operation: Schema.String,
    path: Schema.String,
  },
) {}

/** Whether a platform failure means the observed path does not exist. */
export const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

/**
 * What one directory path resolved to, before a workflow decides whether that is acceptable.
 * `path` is the canonical location once canonicalization succeeds, and the resolved candidate
 * before that.
 */
export type DirectoryObservation =
  | { readonly _tag: "directory"; readonly path: string }
  | { readonly _tag: "not-directory"; readonly path: string }
  | { readonly _tag: "missing"; readonly path: string }
  | {
      readonly _tag: "access-failed";
      readonly error: PlatformError.PlatformError;
      readonly operation: "inspect" | "resolve";
      readonly path: string;
    };

const failedObservation =
  (operation: "inspect" | "resolve", path: string) =>
  (error: PlatformError.PlatformError): DirectoryObservation =>
    isNotFound(error)
      ? { _tag: "missing", path }
      : { _tag: "access-failed", error, operation, path };

/**
 * Resolves a candidate against `relativeTo` (or the process cwd), canonicalizes it, and reports
 * whether the canonical location is a directory. Filesystem failures become observations.
 */
export const observeDirectory = Effect.fnUntraced(function* (
  candidate: string,
  relativeTo?: string,
): Effect.fn.Return<DirectoryObservation, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved =
    relativeTo === undefined ? path.resolve(candidate) : path.resolve(relativeTo, candidate);
  return yield* fileSystem.realPath(resolved).pipe(
    Effect.flatMap((canonical) =>
      fileSystem.stat(canonical).pipe(
        Effect.map((info): DirectoryObservation =>
          info.type === "Directory"
            ? { _tag: "directory", path: canonical }
            : { _tag: "not-directory", path: canonical },
        ),
        Effect.catch((error) => Effect.succeed(failedObservation("inspect", canonical)(error))),
      ),
    ),
    Effect.catch((error) => Effect.succeed(failedObservation("resolve", resolved)(error))),
  );
});

/** A persisted path's observation, or the fact that it now canonicalizes elsewhere. */
export type RegisteredDirectoryObservation =
  | DirectoryObservation
  | { readonly _tag: "location-changed"; readonly path: string };

/**
 * Observes a persisted canonical path. A path that now canonicalizes elsewhere is reported as
 * moved before its type, so an alias never stands in for the registered directory.
 */
export const observeRegisteredDirectory = (registered: string) =>
  observeDirectory(registered).pipe(
    Effect.map((observation): RegisteredDirectoryObservation =>
      observation.path === registered
        ? observation
        : { _tag: "location-changed", path: registered },
    ),
  );

/** How one workflow reports an observed path that is not an existing directory. */
export type DirectoryRequirement = {
  readonly missing: { readonly code: ProjectValidationCode; readonly message: string };
  readonly notDirectory: { readonly code: ProjectValidationCode; readonly message: string };
  /** Storage operation labels for canonicalization and type-inspection failures. */
  readonly operations: { readonly inspect: string; readonly resolve: string };
};

/** Accepts or rejects one observed directory, returning its canonical path. */
export type DirectoryCheck = (
  observation: DirectoryObservation,
) => Effect.Effect<string, ProjectStorageError | ProjectValidationError>;

/** Builds a check that accepts only an existing directory and reports the requirement's errors. */
export const requireDirectory =
  (requirement: DirectoryRequirement): DirectoryCheck =>
  (observation) =>
    Match.valueTags(observation, {
      directory: ({ path }) => Effect.succeed(path),
      "not-directory": ({ path }) =>
        Effect.fail(new ProjectValidationError({ ...requirement.notDirectory, path })),
      missing: ({ path }) =>
        Effect.fail(new ProjectValidationError({ ...requirement.missing, path })),
      "access-failed": ({ error, operation, path }) =>
        Effect.fail(
          new ProjectStorageError({
            code: "project-access-failed",
            message: error.message,
            operation: requirement.operations[operation],
            path,
          }),
        ),
    });

/** Canonical Git facts observed from one directory inside a repository. */
export type RepositoryObservation = {
  readonly gitCommonDirectory: string;
  /** Unique, code-unit ordered canonical roots of reachable non-bare worktrees. */
  readonly roots: ReadonlyArray<string>;
};

/** How one workflow accepts Git's reported common directory and worktrees. */
export type RepositoryChecks = {
  readonly commonDirectory: DirectoryCheck;
  readonly worktree: DirectoryCheck;
};

const isReachableWorktree = (worktree: GitWorktree) =>
  worktree.bare === false && worktree.prunable === undefined;

/**
 * Observes the repository containing `cwd` through Git: its common directory and every reachable
 * non-bare worktree, each resolved against `cwd`, canonicalized, and accepted by `checks`.
 */
export const observeRepository = Effect.fnUntraced(function* (
  cwd: string,
  checks: RepositoryChecks,
): Effect.fn.Return<
  RepositoryObservation,
  GitCommandError | GitOutputParseError | ProjectStorageError | ProjectValidationError,
  FileSystem.FileSystem | Git | Path.Path
> {
  const git = yield* Git;
  const gitCommonDirectory = yield* checks.commonDirectory(
    yield* observeDirectory(yield* git.resolveCommonDirectory(cwd), cwd),
  );
  const worktrees = yield* git.listWorktrees(cwd);
  const roots = yield* Effect.forEach(worktrees.filter(isReachableWorktree), (worktree) =>
    observeDirectory(worktree.path, cwd).pipe(Effect.flatMap(checks.worktree)),
  );
  return { gitCommonDirectory, roots: sortAndDedupeStrings(roots) };
});
