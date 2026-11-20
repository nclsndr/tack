import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { stateFormat } from "../apps/cli/src/domain/state/state-format.ts";

const root = resolve(import.meta.dirname, "..");
const destination = process.argv[2];
if (destination === undefined || !isAbsolute(destination))
  throw new Error("Pass an absolute, empty release directory as the first argument.");
const release = resolve(destination);
if (release === root || release.startsWith(`${root}${sep}`))
  throw new Error("Build the release outside the checkout.");
await mkdir(release, { recursive: true });
if ((await readdir(release)).length !== 0) throw new Error("The release directory must be empty.");

const manifest: { readonly packageManager: string } = await Bun.file(
  join(root, "package.json"),
).json();
if (manifest.packageManager !== `bun@${Bun.version}`)
  throw new Error(`Release requires ${manifest.packageManager}; running bun@${Bun.version}.`);
const git = Bun.spawnSync({
  cmd: ["git", "-C", root, "rev-parse", "--short=7", "HEAD"],
  stdout: "pipe",
  stderr: "ignore",
});
const commit =
  process.env["TACK_BUILD_COMMIT"] ??
  (git.exitCode === 0 ? new TextDecoder().decode(git.stdout).trim() : undefined);
if (commit === undefined || !/^[0-9a-f]{7,40}$/.test(commit))
  throw new Error("Set TACK_BUILD_COMMIT to the exported commit's 7–40 character hash.");
const ahead = Number(process.env["TACK_BUILD_AHEAD"] ?? "0");
if (!Number.isSafeInteger(ahead) || ahead < 0)
  throw new Error("TACK_BUILD_AHEAD must be a nonnegative integer.");

const copy = async (source: string, target = source) => {
  await mkdir(dirname(join(release, target)), { recursive: true });
  await cp(join(root, source), join(release, target), {
    recursive: true,
    filter: (path) => !/\.test\.[cm]?[jt]sx?$/.test(path),
  });
};
const run = (args: string[], cwd: string) => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`Release command failed: bun ${args.join(" ")}`);
};

await mkdir(join(release, "bin"), { recursive: true });
run(
  [
    "build",
    "--compile",
    "--bytecode",
    "--format=esm",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--define",
    `__TACK_BUILD_INFO__=${JSON.stringify({ commit, ahead })}`,
    "./apps/cli/src/main.ts",
    "--outfile",
    join(release, "bin/tack"),
  ],
  root,
);
run(
  [
    "build",
    "./apps/cli/src/platform/execution/worker.ts",
    "--outfile",
    join(release, "worker.js"),
    "--target",
    "bun",
    // The release root holds no `@tackup/core` link; the worker names the script API's own file.
    "--define",
    `__TACK_SCRIPT_API__=${JSON.stringify("./packages/core/src/script-api.ts")}`,
  ],
  root,
);
for (const path of [
  "package.json",
  "bun.lock",
  "patches",
  "apps/cli/package.json",
  "packages/core/package.json",
  "packages/reader/package.json",
  "packages/reader/src",
  "packages/core/src",
  "apps/cli/src/builtins",
])
  await copy(path, path === "apps/cli/src/builtins" ? "builtins" : path);
run(["install", "--production", "--frozen-lockfile"], release);
await Bun.write(join(release, "state-format.json"), JSON.stringify({ stateFormat }));
process.stdout.write(`${release}\n`);
