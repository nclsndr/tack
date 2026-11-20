import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The package gate. It builds the npm package, packs it, installs the tarball into a throwaway
 * prefix with npm (Node) or `bun add -g` (Bun), and runs the runtime gate against the installed
 * package with only that runtime and git on `PATH`. Every install and cache stays inside one new
 * directory under `GATE_ROOT` (default: the system temporary directory), which it leaves in place.
 *
 * Usage: bun scripts/gate-package.ts node <path to a node binary>
 *        bun scripts/gate-package.ts bun <path to a bun binary>
 */
const [runtime, binary] = process.argv.slice(2);
if ((runtime !== "node" && runtime !== "bun") || binary === undefined)
  throw new Error("Usage: bun scripts/gate-package.ts <node|bun> <runtime binary>");

const checkout = dirname(import.meta.dirname);
const root = realpathSync(
  mkdtempSync(join(process.env["GATE_ROOT"] ?? tmpdir(), `tack-package-gate-${runtime}-`)),
);
const tools = join(root, "tools");
for (const directory of ["home", "tmp", "tarballs", "tools", "prefix"])
  mkdirSync(join(root, directory), { recursive: true });
symlinkSync(realpathSync(binary), join(tools, runtime));
const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
symlinkSync(git, join(tools, "git"));
writeFileSync(join(root, "npmrc"), "");
writeFileSync(join(root, "empty-bunfig.toml"), "");

/** Everything an install may write goes under the gate root. */
const isolated: NodeJS.ProcessEnv = {
  HOME: join(root, "home"),
  TMPDIR: join(root, "tmp"),
  XDG_CONFIG_HOME: join(root, "home/.config"),
  XDG_DATA_HOME: join(root, "home/.local/share"),
  XDG_CACHE_HOME: join(root, "home/.cache"),
  npm_config_cache: join(root, "npm-cache"),
  npm_config_prefix: join(root, "prefix"),
  npm_config_userconfig: join(root, "npmrc"),
  BUN_INSTALL: join(root, "bun"),
  BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
  PATH: `${dirname(realpathSync(binary))}:${dirname(git)}:/usr/bin:/bin`,
};
const run = (command: string, args: ReadonlyArray<string>, cwd = root) => {
  const result = spawnSync(command, args, { cwd, env: isolated, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
};

const pkg = join(root, "package");
// The build reads the checkout with the caller's tools; only the install and the gate are isolated.
const built = spawnSync(process.execPath, [join(checkout, "scripts/build-package.ts"), pkg], {
  cwd: checkout,
  encoding: "utf8",
});
if (built.status !== 0)
  throw new Error(`The package build failed:\n${built.stdout}${built.stderr}`);

let command: ReadonlyArray<string>;
if (runtime === "node") {
  run(join(dirname(realpathSync(binary)), "npm"), [
    "pack",
    pkg,
    "--pack-destination",
    join(root, "tarballs"),
  ]);
  const [tarball] = readdirSync(join(root, "tarballs"));
  if (tarball === undefined) throw new Error("npm pack produced no tarball.");
  run(join(dirname(realpathSync(binary)), "npm"), [
    "install",
    "--global",
    "--no-audit",
    "--no-fund",
    join(root, "tarballs", tarball),
  ]);
  command = [join(root, "prefix/bin/tack")];
} else {
  run(binary, ["pm", "pack", "--destination", join(root, "tarballs")], pkg);
  const [tarball] = readdirSync(join(root, "tarballs"));
  if (tarball === undefined) throw new Error("bun pm pack produced no tarball.");
  run(binary, ["add", "--global", join(root, "tarballs", tarball)]);
  command = [
    join(tools, "bun"),
    "--bun",
    "--no-env-file",
    `--config=${join(root, "empty-bunfig.toml")}`,
    join(root, "bun/install/global/node_modules/@tackup/cli/dist/main.js"),
  ];
}

const gate = spawnSync(
  process.execPath,
  [join(checkout, "scripts/gate-runtime.ts"), `package-${runtime}`, "--", ...command],
  {
    cwd: checkout,
    env: {
      ...process.env,
      GATE_ROOT: root,
      GATE_PATH: `${tools}:/usr/bin:/bin`,
      GATE_RUNTIME: runtime,
      GATE_PACKAGE: "1",
      GATE_TSC: join(checkout, "node_modules/.bin/tsc"),
    },
    stdio: "inherit",
  },
);
process.exit(gate.status ?? 1);
