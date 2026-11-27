/**
 * Decides which CI jobs a pull request needs, from the files it changes. CI's `changes` job runs it
 * and passes the answers to the other jobs as its `suite` and `gates` outputs.
 *
 * - A pull request that changes guidance documents only skips the suite and the gates: `static`
 *   runs the format check and the repository tests (`test:repo`), which are all that read those
 *   documents.
 * - A pull request that changes only `evals/`, `apps/website/` and guidance documents skips the
 *   release, runtime and package gates: none of them is part of the CLI or its package.
 * - Anything else runs every job, including a change to `packages/harness`, which the website and
 *   the evals use, `LICENSE`, which the package ships, and anything under `.github/workflows/`.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/**
 * The documents only contributors and agents read. In CI, only `format:check` and the repository
 * tests (`test:repo`, `apps/cli/test/*.repo.test.ts`) read them; no build, package, website or
 * workflow does. GitHub never runs `.github/workflows/README.md`, since it is not YAML.
 */
const guidanceFiles = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "CONTEXT.md",
  "README.md",
  "SECURITY.md",
  "STRATEGY.md",
  ".github/pull_request_template.md",
  ".github/workflows/README.md",
] as const;

/** The folders that hold only guidance: the repository's own skills. */
const guidanceFolders = [".ai/"] as const;

/** The folders whose changes cannot affect the CLI, its release build or its package. */
const gateFreeFolders = ["evals/", "apps/website/"] as const;

const isGuidance = (path: string): boolean =>
  guidanceFiles.some((file) => path === file) ||
  guidanceFolders.some((folder) => path.startsWith(folder));

const isGateFree = (path: string): boolean =>
  isGuidance(path) || gateFreeFolders.some((folder) => path.startsWith(folder));

/**
 * Whether the gates must run for a change to `paths`.
 *
 * @param paths - The changed files, relative to the repository root. No file at all runs them.
 */
export const needsGates = (paths: ReadonlyArray<string>): boolean =>
  paths.length === 0 || paths.some((path) => isGateFree(path) === false);

/**
 * Whether the suite must run for a change to `paths`: every `static` step, the test shards and the
 * coverage merge. Without it, `static` runs only the checks that read guidance documents.
 *
 * @param paths - The changed files, relative to the repository root. No file at all runs it.
 */
export const needsSuite = (paths: ReadonlyArray<string>): boolean =>
  paths.length === 0 || paths.some((path) => isGuidance(path) === false);

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
  const suite = paths === undefined || needsSuite(paths);
  const gates = paths === undefined || needsGates(paths);
  console.log(
    paths === undefined
      ? `Event ${event ?? "(none)"} without a pull request merge commit: every job runs.`
      : `The pull request changes ${paths.length} file(s): ${
          suite === false
            ? "only guidance documents, so the suite and the gates are skipped"
            : gates === false
              ? "only evals/, apps/website/ and guidance documents, so the gates are skipped"
              : "every job runs"
        }.`,
  );
  const output = process.env["GITHUB_OUTPUT"];
  if (output !== undefined) appendFileSync(output, `suite=${suite}\ngates=${gates}\n`);
}
