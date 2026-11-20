import { Effect } from "effect";
import { GitCommandError, type GitService, type GitWorktree } from "../../src/services/git.ts";

/** A worktree Git reports; flags left out read as not bare and not detached. */
type FakeWorktree = Pick<GitWorktree, "path"> & Partial<Omit<GitWorktree, "path">>;

/**
 * A Git that answers every cwd with one common directory and one worktree list.
 *
 * `onCall` sees each question before it is answered, for tests that assert which directory asked.
 */
export const fakeGit = (
  anchor: string,
  worktrees: ReadonlyArray<FakeWorktree>,
  onCall?: (operation: "list" | "resolve", cwd: string) => void,
) =>
  ({
    listWorktrees: (cwd) => {
      onCall?.("list", cwd);
      return Effect.succeed(
        worktrees.map((worktree) => ({ bare: false, detached: false, ...worktree })),
      );
    },
    resolveCommonDirectory: (cwd) => {
      onCall?.("resolve", cwd);
      return Effect.succeed(anchor);
    },
  }) satisfies GitService;

/**
 * The failure Git ends with when asked about a directory outside every repository. Git exits 128
 * for every fatal error, so `stderr` can name another one.
 */
export const notARepositoryError = (
  cwd: string,
  args: ReadonlyArray<string>,
  stderr = "fatal: not a git repository (or any of the parent directories): .git\n",
) =>
  new GitCommandError({
    args: [...args],
    code: "git-process-failed",
    command: "git",
    cwd,
    exitCode: 128,
    message: "Git exited with code 128.",
    phase: "exit",
    stderr,
  });

/** A Git for a directory outside every repository: each question fails as Git does there. */
export const outsideRepositoryGit = {
  listWorktrees: (cwd) =>
    Effect.fail(notARepositoryError(cwd, ["worktree", "list", "--porcelain", "-z"])),
  resolveCommonDirectory: (cwd) =>
    Effect.fail(
      notARepositoryError(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ),
} satisfies GitService;
