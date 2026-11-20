import { Effect } from "effect";
import { GitCommandError, type GitService } from "@tackup/cli/core";
import type { MemoryVolume } from "./memory-volume.ts";

/** The directories from `directory` up to the root, nearest first; the root itself is never a repository. */
const ancestors = (directory: string): ReadonlyArray<string> => {
  if (directory === "/") return [];
  const parent = directory.slice(0, directory.lastIndexOf("/"));
  return [directory, ...ancestors(parent === "" ? "/" : parent)];
};

/**
 * Git discovery over a memory volume: a directory holding a `.git` folder is a repository with one
 * worktree on `main`, and any directory below it belongs to it. Linked worktrees are not modeled.
 */
export const makeMemoryGit = (volume: MemoryVolume): GitService => {
  const repositoryRoot = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const real = volume.exists(cwd) ? volume.realpath(cwd) : undefined;
      const root =
        real === undefined
          ? undefined
          : ancestors(real).find(
              (directory) =>
                volume.exists(`${directory}/.git`) &&
                volume.stat(`${directory}/.git`).type === "directory",
            );
      return root === undefined
        ? Effect.fail(
            new GitCommandError({
              args: [...args],
              code: "git-process-failed",
              command: "git",
              cwd,
              exitCode: 128,
              message: "Git exited with code 128.",
              phase: "exit",
              stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
            }),
          )
        : Effect.succeed(root);
    });

  return {
    resolveCommonDirectory: (cwd) =>
      repositoryRoot(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
        Effect.map((root) => `${root}/.git`),
      ),
    listWorktrees: (cwd) =>
      repositoryRoot(cwd, ["worktree", "list", "--porcelain", "-z"]).pipe(
        Effect.map((root) => [
          { path: root, bare: false, detached: false, branch: "refs/heads/main" },
        ]),
      ),
  };
};
