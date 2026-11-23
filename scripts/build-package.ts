import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { build, type BuildOptions, type Plugin } from "esbuild";
import { buildCommit, isShippedFile, shippedWorkspaces } from "./build-recipe.ts";
import { publishedPackageName as packageName } from "../apps/cli/src/domain/execution/published-name.ts";
import { scriptApiDeclarations } from "../apps/cli/src/domain/execution/script-api-declarations.ts";
import { typesStub } from "../apps/cli/src/features/execution/script-types.ts";

/**
 * Builds Tack as one plain npm package that runs on Node or Bun, into an empty directory:
 *
 * - `dist/main.js`, the CLI with `@tackup/core`, the reader's host code and the script worker inlined;
 *   every other package stays an npm dependency, pinned to the version installed here;
 * - `dist/reader/`, the reader files Rspack compiles at serve time, with prebuilt `engine.js` and
 *   `watcher.js` process entry points (Node refuses to strip types under `node_modules`);
 * - `dist/builtins/`, the built-in source, which the CLI copies to `TACK_BUILTINS_DIR` per version;
 * - `dist/script.js` and `dist/script.d.ts`, the Effect-free script API, which the worker provides to
 *   scripts under the package's name, kept as its own file so scripts never load the CLI;
 * - `dist/tack-env.d.ts`, the same declarations as an ambient module, so a source's editor knows the
 *   API without installing anything.
 *
 * Usage: bun scripts/build-package.ts <absolute output directory>
 */
const [output] = process.argv.slice(2);
if (output === undefined || isAbsolute(output) === false || existsSync(output) === true)
  throw new Error("Pass an absolute output directory that does not exist yet.");

const checkout = dirname(import.meta.dirname);

type Manifest = {
  readonly version?: string;
  readonly description?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
};
const readManifest = (path: string): Manifest => {
  const manifest: Manifest = JSON.parse(readFileSync(path, "utf8"));
  return manifest;
};
const git = (args: ReadonlyArray<string>) =>
  spawnSync("git", args, { cwd: checkout, encoding: "utf8" }).stdout.trim();

const version = readManifest(join(checkout, "package.json")).version ?? "0.0.0";
const commit = buildCommit(checkout, 12);
const ahead = Number.parseInt(git(["rev-list", "--count", "origin/main..HEAD"]) || "0", 10);

/** The version of a dependency installed for one workspace, which the package then pins exactly. */
const installedVersion = (workspace: string, name: string) => {
  const candidates = [
    join(checkout, workspace, "node_modules"),
    join(checkout, "node_modules"),
  ].map((directory) => join(directory, name, "package.json"));
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) throw new Error(`${name} is not installed for ${workspace}.`);
  return readManifest(found).version ?? "";
};

/** Every npm dependency of the shipped workspaces, pinned, with the first workspace's version winning. */
const dependencies = Object.fromEntries(
  shippedWorkspaces
    .flatMap((workspace) =>
      Object.keys(readManifest(join(checkout, workspace, "package.json")).dependencies ?? {})
        .filter((name) => name.startsWith("@tackup/") === false)
        .map((name) => [name, installedVersion(workspace, name)] as const),
    )
    .filter(([name], index, all) => all.findIndex(([other]) => other === name) === index)
    .sort(([left], [right]) => left.localeCompare(right)),
);

/** Inlines Tack's own workspace packages and keeps every npm package external. */
const externalPackages: Plugin = {
  name: "tack-external-packages",
  setup: (pluginBuild) => {
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith("@tackup/") ? undefined : { path: args.path, external: true },
    );
  },
};

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.12",
  logLevel: "warning",
  plugins: [externalPackages],
} satisfies BuildOptions;

const dist = join(output, "dist");
await build({
  ...shared,
  entryPoints: [join(checkout, "apps/cli/src/main.ts")],
  outfile: join(dist, "main.js"),
  define: {
    __TACK_PACKAGE__: JSON.stringify(packageName),
    __TACK_BUILD_INFO__: JSON.stringify({ commit, ahead }),
    __TACK_READER_DIR__: JSON.stringify("./reader/"),
    __TACK_READER_ENTRY_EXTENSION__: JSON.stringify(".js"),
    __TACK_SCRIPT_API__: JSON.stringify("./script.js"),
    __TACK_SCRIPT_LOADER__: JSON.stringify("./script-loader.js"),
  },
});
// The entry point keeps the source's Bun hashbang; the package's bin runs on Node by default.
const main = readFileSync(join(dist, "main.js"), "utf8");
writeFileSync(join(dist, "main.js"), `#!/usr/bin/env node\n${main.replace(/^#!.*\n/, "")}`);
chmodSync(join(dist, "main.js"), 0o755);
await build({
  ...shared,
  entryPoints: ["engine", "watcher"].map((stem) =>
    join(checkout, `packages/reader/src/${stem}.ts`),
  ),
  outdir: join(dist, "reader"),
  define: {
    __TACK_READER_DIR__: JSON.stringify("./"),
    __TACK_READER_ENTRY_EXTENSION__: JSON.stringify(".js"),
  },
});

// Rspack compiles the reader's runtime, components and styles from these sources at serve time.
cpSync(join(checkout, "packages/reader/src"), join(dist, "reader"), {
  recursive: true,
  filter: isShippedFile,
});
cpSync(join(checkout, "apps/cli/src/builtins"), join(dist, "builtins"), { recursive: true });

const scriptApi = join(checkout, "packages/core/src/script-api.ts");
await build({ ...shared, entryPoints: [scriptApi], outfile: join(dist, "script.js") });
// Node 22.12–22.14 load the worker's module hooks on their own thread, from their own file.
await build({
  ...shared,
  entryPoints: [join(checkout, "apps/cli/src/platform/execution/script-api-loader.ts")],
  outfile: join(dist, "script-loader.js"),
});
writeFileSync(join(dist, "script.d.ts"), scriptApiDeclarations);
writeFileSync(join(dist, "tack-env.d.ts"), typesStub(version));

mkdirSync(output, { recursive: true });
cpSync(join(checkout, "LICENSE"), join(output, "LICENSE"));
writeFileSync(
  join(output, "package.json"),
  `${JSON.stringify(
    {
      name: packageName,
      version,
      // The CLI workspace's description: the one sentence that says what Tack is, everywhere.
      description: readManifest(join(checkout, "apps/cli/package.json")).description,
      license: "MIT",
      type: "module",
      bin: { tack: "dist/main.js" },
      exports: { ".": { types: "./dist/script.d.ts", default: "./dist/script.js" } },
      files: ["dist"],
      engines: { node: ">=22.12" },
      dependencies,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`${JSON.stringify({ output, packageName, version, commit, ahead })}\n`);
