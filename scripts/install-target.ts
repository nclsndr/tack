/**
 * Decides where `bun run install:local` puts the global `tack`, and how it reports that place.
 *
 * Volta intercepts `npm install --global` when its shim runs npm: it installs the package into its
 * own image and ignores npm's prefix. So a prefix asked for through the environment only holds
 * once Volta's interception is off, which `VOLTA_UNSAFE_GLOBAL=1` does.
 */
import { basename, dirname, join } from "node:path";

/**
 * Where the install lands.
 *
 * - `npm-prefix`: npm's global prefix decides, read with `env` added to the environment.
 * - `volta`: Volta installs the package into its image and links `bin` as its shim.
 */
type InstallTarget =
  | { readonly kind: "npm-prefix"; readonly env: Readonly<Record<string, string>> }
  | { readonly kind: "volta"; readonly bin: string };

/**
 * Picks the install target from the npm that runs the install.
 *
 * @param npm - The real path of the `npm` on PATH, symlinks resolved; Volta's is its `volta-shim`.
 * @param env - The environment the install runs with; npm reads `npm_config_prefix` in either letter case.
 */
export const installTarget = (
  npm: string,
  env: Readonly<Record<string, string | undefined>>,
): InstallTarget => {
  if (basename(npm) !== "volta-shim") return { kind: "npm-prefix", env: {} };
  const prefix = env["npm_config_prefix"] ?? env["NPM_CONFIG_PREFIX"] ?? "";
  if (prefix !== "") return { kind: "npm-prefix", env: { VOLTA_UNSAFE_GLOBAL: "1" } };
  // The shim lives in `$VOLTA_HOME/bin`, next to the shims Volta links for installed packages.
  return { kind: "volta", bin: join(dirname(npm), "tack") };
};

/**
 * Says where the build landed, and whether running `tack` now reaches it.
 *
 * @param bin - The `tack` executable the install wrote.
 * @param onPath - The `tack` that PATH resolves to, or `undefined` when none does.
 */
export const describeInstall = (installed: {
  readonly version: string;
  readonly commit: string;
  readonly bin: string;
  readonly onPath: string | undefined;
}) => {
  const { version, commit, bin, onPath } = installed;
  const landed = `Installed @tackup/cli ${version} (${commit}) as ${bin}`;
  if (onPath === bin)
    return `${landed}, which is the \`tack\` on PATH. Run \`tack init\` to relink built-in skills.`;
  if (onPath === undefined)
    return `${landed}, which is not on PATH: add ${dirname(bin)} to PATH to run it as \`tack\`.`;
  return `${landed}, but \`tack\` on PATH is still ${onPath}: put ${dirname(bin)} first on PATH to run this build as \`tack\`.`;
};
