/**
 * Decides which CI jobs a pull request needs, from the files it changes. CI's `static` job runs it
 * and passes the answer to the `gates` job's `if:` as the `gates` output.
 *
 * Only the release, runtime and package gates are ever skipped, and only for a pull request whose
 * every changed file sits under `evals/` or `apps/website/`: neither folder is part of the CLI or
 * its package. Anything else runs every job, including a change to `packages/harness`, which the
 * website and the evals use, and root docs, which the guidance tests read.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/** The folders whose changes cannot affect the CLI, its release build or its package. */
const gateFreeFolders = ["evals/", "apps/website/"] as const;

/**
 * Whether the gates must run for a change to `paths`.
 *
 * @param paths - The changed files, relative to the repository root. No file at all runs them.
 */
export const needsGates = (paths: ReadonlyArray<string>): boolean =>
  paths.length === 0 ||
  paths.some((path) => gateFreeFolders.every((folder) => path.startsWith(folder) === false));

/**
 * The files a pull request changes, read from the merge commit CI checks out: its first parent is
 * the base branch, so the diff against it is exactly what the merge brings in. A rename lists both
 * its old and new path.
 *
 * @param cwd - A checkout of the merge commit with its parents fetched (`fetch-depth: 2`).
 * @returns The changed files, or `undefined` when HEAD is not a merge commit.
 */
export const changedPaths = (cwd: string): ReadonlyArray<string> | undefined => {
  const git = (...args: ReadonlyArray<string>): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" });
  const parents = git("rev-list", "--parents", "--max-count=1", "HEAD").trim().split(" ");
  if (parents.length !== 3) return undefined;
  return git("diff", "--name-only", "--no-renames", "HEAD^1", "HEAD")
    .split("\n")
    .filter((path) => path !== "");
};

if (import.meta.main) {
  const event = process.env["GITHUB_EVENT_NAME"];
  const paths = event === "pull_request" ? changedPaths(process.cwd()) : undefined;
  const gates = paths === undefined || needsGates(paths);
  console.log(
    paths === undefined
      ? `Event ${event ?? "(none)"} without a pull request merge commit: every job runs.`
      : `The pull request changes ${paths.length} file(s): ${gates === true ? "every job runs" : "the gates are skipped, every changed file is under evals/ or apps/website/"}.`,
  );
  const output = process.env["GITHUB_OUTPUT"];
  if (output !== undefined) appendFileSync(output, `gates=${gates}\n`);
}
