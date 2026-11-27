import { Effect, Match, Path } from "effect";
import { Git } from "../../services/git.ts";
import { isInside } from "../../domain/identity/path-containment.ts";
import { projectLifecycle } from "../../domain/projects/project-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";
import { observeDirectory } from "./project-observation.ts";
import { resolveContainingRoot, TargetSelectionError } from "./project.ts";

/**
 * Where a working directory sits for Tack: in a registered project root, in a Git worktree of a
 * registered project that refresh has not added yet, in a Git repository no project registers, or
 * outside any repository Tack could register.
 */
export type CheckoutObservation =
  | { readonly _tag: "registered-root"; readonly projectName: string; readonly root: string }
  | { readonly _tag: "unregistered-worktree"; readonly projectName: string; readonly root: string }
  | {
      readonly _tag: "unregistered-repository";
      readonly root: string;
      /** A free project name derived from the worktree folder's name. */
      readonly suggestedName: string;
    }
  | { readonly _tag: "outside-repository" };

const outside: CheckoutObservation = { _tag: "outside-repository" };

/**
 * A project name from a folder name: characters a name may not hold become `-`, a name starts
 * with a letter or digit, and a name another project holds gets the first free `-N` suffix.
 */
const freeProjectName = (folder: string, taken: ReadonlySet<string>) => {
  const base = folder.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  const name = base.length === 0 ? "project" : base;
  if (taken.has(name) === false) return name;
  let suffix = 2;
  while (taken.has(`${name}-${suffix}`) === true) suffix += 1;
  return `${name}-${suffix}`;
};

/**
 * Observes where `cwd` sits. A registered root is read from state alone; otherwise Git names the
 * repository's common directory and the worktree that holds `cwd`. Every failure to observe, such
 * as a missing directory or a folder outside any repository, reads as outside a repository: the
 * observation only chooses a hint, so it never fails the command that asked.
 */
export const observeCheckout = Effect.fnUntraced(
  function* (state: State, cwd: string) {
    const { canonicalCwd, containing } = yield* resolveContainingRoot(state, cwd);
    if (containing !== undefined)
      return { _tag: "registered-root", ...containing } satisfies CheckoutObservation;
    const git = yield* Git;
    const path = yield* Path.Path;
    const commonDirectory = yield* observeDirectory(
      yield* git.resolveCommonDirectory(canonicalCwd),
      canonicalCwd,
    );
    const worktrees = yield* git.listWorktrees(canonicalCwd);
    const roots = yield* Effect.forEach(
      worktrees.filter(({ bare }) => bare === false),
      (worktree) => observeDirectory(worktree.path, canonicalCwd),
    );
    // Worktrees that hold the directory are nested prefixes of it; the deepest one holds it.
    const root = roots
      .flatMap((observation) =>
        observation._tag === "directory" && isInside(observation.path, canonicalCwd)
          ? [observation.path]
          : [],
      )
      .sort((left, right) => right.length - left.length)[0];
    if (root === undefined) return outside;
    const project = state.data.projects.find(
      (candidate) =>
        projectLifecycle(candidate) === "active" &&
        commonDirectory._tag === "directory" &&
        candidate.gitCommonDirectory === commonDirectory.path,
    );
    return project === undefined
      ? ({
          _tag: "unregistered-repository",
          root,
          suggestedName: freeProjectName(
            path.basename(root),
            new Set(state.data.projects.map(({ name }) => name)),
          ),
        } satisfies CheckoutObservation)
      : ({
          _tag: "unregistered-worktree",
          projectName: project.name,
          root,
        } satisfies CheckoutObservation);
  },
  Effect.orElseSucceed((): CheckoutObservation => outside),
);

/**
 * Where a directory that no registered root holds sits, and the command that makes it selectable:
 * refresh adds a new worktree of a registered project, and add registers a repository no project
 * holds. A registered root needs neither, and outside a repository there is nothing to register.
 */
export const bareSelectionHint = (
  observation: CheckoutObservation,
): { readonly cause: string; readonly next: ReadonlyArray<string> } | undefined =>
  Match.valueTags(observation, {
    "unregistered-worktree": ({ projectName }) => ({
      cause: `It is a worktree of project ${projectName} that Tack has not registered yet.`,
      next: ["tack", "project", "refresh", "--apply"],
    }),
    "unregistered-repository": ({ suggestedName }) => ({
      cause: "It is in a Git repository that no project registers.",
      next: ["tack", "project", "add", suggestedName],
    }),
    "registered-root": () => undefined,
    "outside-repository": () => undefined,
  });

/**
 * Completes a bare selection that found no registered root with where its directory sits and the
 * command that makes it selectable. Any other failure, and one whose directory no hint fits, is
 * returned as it was: the hint never replaces the selection failure.
 */
export const withCheckoutHint = (state: State, error: TargetSelectionError) => {
  const { path } = error;
  if (
    error.code !== "bare-target-requires-registered-root" ||
    path === undefined ||
    error.next !== undefined
  )
    return Effect.succeed(error);
  return Effect.gen(function* () {
    const hint = bareSelectionHint(yield* observeCheckout(state, path));
    return hint === undefined
      ? error
      : new TargetSelectionError({
          code: error.code,
          message: `${error.message} ${hint.cause}`,
          path,
          ...(error.projectName === undefined ? {} : { projectName: error.projectName }),
          ...(error.root === undefined ? {} : { root: error.root }),
          next: [hint.next],
        });
  });
};

/**
 * Where newly cataloged resources go next: in a Git repository no project registers, register it,
 * as `project add` does from there; with no project registered, register one by name and path;
 * otherwise preview the sync of the project that holds the directory, or of the only project.
 * Several projects and none holding the directory leave the choice to the operator, so the command
 * lists them.
 */
export const linkingNext = Effect.fnUntraced(function* (state: State, cwd: string) {
  const projects = state.data.projects.filter((project) => projectLifecycle(project) === "active");
  const checkout = yield* observeCheckout(state, cwd);
  if (checkout._tag === "unregistered-repository")
    return ["tack", "project", "add", checkout.suggestedName];
  if (projects.length === 0) return ["tack", "project", "add", "NAME", "--repository-cwd", "PATH"];
  const [only] = projects;
  const projectName =
    checkout._tag === "registered-root" || checkout._tag === "unregistered-worktree"
      ? checkout.projectName
      : projects.length === 1
        ? only?.name
        : undefined;
  return projectName === undefined
    ? ["tack", "project"]
    : ["tack", "sync", "--project", projectName];
});
