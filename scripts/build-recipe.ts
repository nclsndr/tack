import { spawnSync } from "node:child_process";

/*
 * What the release build and the package build agree on: the commit they stamp, the files they
 * leave behind and the workspaces whose dependencies they ship.
 */

/** The workspaces whose code ships. The package pins their npm dependencies in this order. */
export const shippedWorkspaces = ["apps/cli", "packages/reader", "packages/core"] as const;

/** Whether a copied file ships: tests, and the test helpers beside production source, stay behind. */
export const isShippedFile = (path: string): boolean =>
  /\.test\.[cm]?[jt]sx?$|\.test-support\.[cm]?[jt]sx?$/.test(path) === false;

/**
 * The commit a build stamps: `TACK_BUILD_COMMIT` when set, otherwise the checkout's `HEAD`
 * abbreviated to `length` characters. Anything but a 7 to 40 character hexadecimal hash fails the
 * build, so a checkout without Git history or a mistyped override never ships an empty stamp.
 */
export const buildCommit = (
  checkout: string,
  length: number,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const commit = environment["TACK_BUILD_COMMIT"] ?? headCommit(checkout, length);
  if (commit === undefined || /^[0-9a-f]{7,40}$/.test(commit) === false)
    throw new Error("Set TACK_BUILD_COMMIT to the exported commit's 7–40 character hash.");
  return commit;
};

const headCommit = (checkout: string, length: number) => {
  const git = spawnSync("git", ["-C", checkout, "rev-parse", `--short=${length}`, "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return git.status === 0 ? git.stdout.trim() : undefined;
};
