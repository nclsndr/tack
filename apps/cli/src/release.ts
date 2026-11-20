import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstallKind } from "./domain/self/upgrade-guide.ts";
import { currentVersionReport } from "./version.ts";

/**
 * The install kind of a run; a package in Bun's global folder was installed with `bun add -g`. Any
 * other run is built from a checkout, including the compiled build the evals container runs.
 */
export const installKindOf = (run: {
  readonly packageRun: boolean;
  readonly entryPoint: string;
}): InstallKind =>
  run.packageRun ? (run.entryPoint.includes("/.bun/install/global/") ? "bun" : "npm") : "source";

/** Finds a file in the release, independent of the caller's directory or executable link. */
export const resolveSidecar = (moduleUrl: string, executablePath: string, name: string): string =>
  moduleUrl.includes("$bunfs")
    ? join(dirname(dirname(executablePath)), name)
    : fileURLToPath(new URL(name, moduleUrl));

/** The built-ins of a compiled release, beside its executable, or of a checkout, beside this file. */
export const resolveBuiltIns = (moduleUrl: string, executablePath: string): string =>
  moduleUrl.includes("$bunfs")
    ? join(dirname(dirname(executablePath)), "builtins")
    : fileURLToPath(new URL("./builtins", moduleUrl));

/** The hidden first argument that turns the CLI entry point into the script worker. */
export const workerCommand = "__tack-worker";

/**
 * The module that starts this Tack: `main.ts` beside this file in a source run. A bundle inlines
 * this module, so its own URL is already the entry point.
 */
export const entryPointOf = (moduleUrl: string): string =>
  fileURLToPath(moduleUrl.endsWith("/release.ts") ? new URL("./main.ts", moduleUrl) : moduleUrl);

/**
 * Where an npm package keeps one copy of its built-ins per version: `TACK_BUILTINS_DIR`, else
 * `~/.tack/builtins`. `--state-dir` and `TACK_STATE_DIR` never move it, so states share the copies.
 */
export const builtInsRoot = (
  environment: Readonly<Record<string, string | undefined>>,
  home: string | undefined,
): string | undefined =>
  environment["TACK_BUILTINS_DIR"] ??
  (home === undefined ? undefined : join(home, ".tack/builtins"));

const completeMarker = ".tack-complete";

/**
 * Copies a package's built-ins into `<root>/<version>` once, so agent links never point into a
 * package manager's cache that may be cleared. The copy is staged, marked complete, then renamed into
 * place; a copy without the marker is an interrupted one and is replaced.
 */
export const materializeBuiltIns = (source: string, root: string, version: string): string => {
  const target = join(root, version);
  if (existsSync(join(target, completeMarker)) === true) return target;
  const staging = `${target}.staging-${process.pid}`;
  mkdirSync(root, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  cpSync(source, staging, { recursive: true });
  writeFileSync(join(staging, completeMarker), "");
  // Another first run may have completed the copy meanwhile; only an interrupted copy is replaced.
  if (existsSync(join(target, completeMarker)) === false)
    rmSync(target, { recursive: true, force: true });
  try {
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    // Coverage skip: only a concurrent first run of the same version loses this rename.
    /* v8 ignore next -- @preserve */
    if (existsSync(join(target, completeMarker)) === false) throw error;
  }
  return target;
};

/** Each entry's names in a folder, or none when the folder cannot be read. */
const entriesOf = (folder: string): ReadonlyArray<string> => {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
};

/** The real path of a symbolic link's target, or `undefined` for anything that is not a link. */
const linkTarget = (path: string): string | undefined => {
  try {
    return resolve(realpathSync(dirname(path)), readlinkSync(path));
  } catch {
    return undefined;
  }
};

/**
 * The built-ins versions under `root` that a symbolic link in one of `folders` points into, such as
 * the agents' skill folders of the user home and every registered project root.
 */
export const linkedBuiltIns = (
  root: string,
  folders: ReadonlyArray<string>,
): ReadonlySet<string> => {
  const real = existsSync(root) ? realpathSync(root) : root;
  return new Set(
    folders.flatMap((folder) =>
      entriesOf(folder).flatMap((name) => {
        const target = linkTarget(join(folder, name));
        const inside = target === undefined ? ".." : relative(real, target);
        return inside === "" || inside.startsWith("..") || isAbsolute(inside)
          ? []
          : inside.split(sep).slice(0, 1);
      }),
    ),
  );
};

/**
 * Removes the complete built-ins copies under `root` that nothing needs: not the running version,
 * not the newest other copy (another state may still run it), and not one a link points into.
 * States share the root, so a version only another state's links use survives as the newest one
 * until that state syncs. Returns the removed versions.
 */
export const pruneBuiltIns = (
  root: string,
  running: string,
  linked: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const [_previous, ...older] = entriesOf(root)
    .filter((name) => name !== running && existsSync(join(root, name, completeMarker)))
    .map((name) => ({ name, at: statSync(join(root, name, completeMarker)).mtimeMs }))
    .toSorted((left, right) => right.at - left.at);
  const removed = older.map(({ name }) => name).filter((name) => linked.has(name) === false);
  for (const name of removed) rmSync(join(root, name), { recursive: true, force: true });
  return removed;
};

// An npm package build injects its published name; a source run and a compiled release have none.
// oxlint-disable-next-line eslint/no-underscore-dangle -- The package build injects this constant by its reserved name.
declare const __TACK_PACKAGE__: string | undefined;

/** Whether this process runs from an installed npm package rather than a checkout or a release. */
export const packageRun = typeof __TACK_PACKAGE__ === "string";

/** Whether this process is running from a compiled release. */
export const compiledRelease = import.meta.url.includes("$bunfs");
const executablePath = compiledRelease ? realpathSync(process.execPath) : process.execPath;

/** How the running Tack was installed. */
export const installKind = (): InstallKind =>
  installKindOf({ packageRun, entryPoint: entryPointOf(import.meta.url) });

/** Where the built-in source lives: a package's versioned copy, else beside a release or checkout. */
const builtInsPath = (): string => {
  const root = packageRun ? builtInsRoot(process.env, process.env["HOME"]) : undefined;
  // Coverage skip: only the packaged bundle, which the package gate runs, copies its built-ins.
  /* v8 ignore start -- @preserve */
  if (root !== undefined)
    return materializeBuiltIns(
      fileURLToPath(new URL("./builtins", import.meta.url)),
      root,
      currentVersionReport().stamp,
    );
  /* v8 ignore stop -- @preserve */
  return resolveBuiltIns(import.meta.url, executablePath);
};

/** The stable identity and installation-relative location of Tack's bundled source. */
export const builtInSource = {
  id: "98a032d9-b6da-4f82-89ed-782fcd821af6",
  canonicalPath: builtInsPath(),
};

/** The entry point a worker re-runs. */
export const cliEntryPoint = entryPointOf(import.meta.url);

/** Locates a compiled release sidecar, or its source checkout counterpart. */
export const releaseSidecar = (name: string) =>
  resolveSidecar(import.meta.url, executablePath, name);
