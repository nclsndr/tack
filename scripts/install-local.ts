#!/usr/bin/env bun
/**
 * Installs this checkout as the global `tack`, for maintainers. It is not part of the published
 * package, which upgrades only through npm.
 *
 * 1. On `main` with a clean working tree, it fetches `origin` and fast-forwards `main`. Otherwise it
 *    says why it skipped that step and installs the checkout as it is.
 * 2. It installs the workspace dependencies from the lockfile.
 * 3. It builds the npm package, packs it with `npm pack`, and installs the tarball with
 *    `npm install --global`, so the global `tack` is exactly what npm users get.
 *
 * The next `tack` run copies its built-ins into `TACK_BUILTINS_DIR` (default `~/.tack/builtins`),
 * and `tack init` relinks agents to them.
 *
 * npm's global prefix decides where `tack` lands, and `npm_config_prefix` overrides it. When npm
 * runs through Volta's shim, Volta installs into its own image instead, replacing the Volta-managed
 * `tack`; a set `npm_config_prefix` then also sets `VOLTA_UNSAFE_GLOBAL=1`, so the prefix holds
 * and Volta is left alone. The install fails when the expected `tack` is missing afterwards, and
 * the report names it and says whether `tack` on PATH reaches it.
 *
 * Usage: bun run install:local
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeInstall, installTarget } from "./install-target.ts";

const checkout = join(import.meta.dirname, "..");

/** Runs one command in the checkout, failing the install with its output when it fails. */
const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd = checkout,
  env: Readonly<Record<string, string>> = {},
) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
};

const npm = Bun.which("npm");
if (npm === null) throw new Error("npm is not on PATH.");
const target = installTarget(realpathSync(npm), process.env);
const npmEnv = target.kind === "npm-prefix" ? target.env : {};
const bin =
  target.kind === "volta"
    ? target.bin
    : join(run("npm", ["prefix", "--global"], checkout, npmEnv), "bin", "tack");

const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const dirty = run("git", ["status", "--porcelain"]) !== "";
if (branch !== "main")
  console.log(`Not on main (on ${branch}): installing this checkout as it is.`);
else if (dirty) console.log("main has local changes: installing it without fast-forwarding.");
else {
  run("git", ["fetch", "--quiet", "origin", "main"]);
  run("git", ["merge", "--ff-only", "--quiet", "origin/main"]);
  console.log(`Fast-forwarded main to ${run("git", ["rev-parse", "--short", "HEAD"])}.`);
}

run("bun", ["install", "--frozen-lockfile"]);
const work = mkdtempSync(join(tmpdir(), "tack-install-"));
const built: { readonly version: string; readonly commit: string } = JSON.parse(
  // The build reports itself as JSON on its last line.
  run("bun", [join(checkout, "scripts/build-package.ts"), join(work, "package")])
    .split("\n")
    .at(-1) ?? "",
);
run("npm", ["pack", "--silent", "--pack-destination", work], join(work, "package"));
const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
if (tarball === undefined) throw new Error(`npm pack wrote no tarball in ${work}.`);
run("npm", ["install", "--global", join(work, tarball)], checkout, npmEnv);
if (existsSync(bin) === false)
  throw new Error(`npm install --global succeeded but wrote no tack at ${bin}.`);
console.log(describeInstall({ ...built, bin, onPath: Bun.which("tack") ?? undefined }));
