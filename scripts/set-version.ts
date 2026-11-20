#!/usr/bin/env bun

import { join } from "node:path";
import { lockstepProblems, nextVersion, setManifestVersions } from "./version-lockstep.ts";

/**
 * Sets the one repository version by hand: `bun run version:set <0.y.z | patch | minor>`.
 * It edits the four manifests, refreshes `bun.lock`, checks the result, and never commits.
 */
const root = join(import.meta.dirname, "..");
const request = process.argv[2];
if (request === undefined || process.argv.length > 3) {
  console.error("Usage: bun run version:set <0.y.z | patch | minor>");
  process.exit(2);
}

const { version: current }: { readonly version: string } = await Bun.file(
  join(root, "package.json"),
).json();
let version: string;
try {
  version = nextVersion(current, request);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

setManifestVersions(root, version);
const install = Bun.spawnSync([process.execPath, "install", "--lockfile-only"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (install.exitCode !== 0) {
  console.error("bun install --lockfile-only failed; bun.lock was not refreshed.");
  process.exit(1);
}
const problems = lockstepProblems(root);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`Version ${current} -> ${version}. Review the diff and commit it.`);
