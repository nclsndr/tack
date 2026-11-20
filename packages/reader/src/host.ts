/**
 * Everything the reader asks of its JavaScript runtime, built on Node APIs and shipped packages so
 * the same code runs under Node and under Bun: child processes with an IPC channel, TypeScript
 * transpilation, import scanning, module resolution, a browser compile check and glob matching.
 */
import { spawn as spawnChild } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { Parser } from "acorn";
import type * as Esbuild from "esbuild";
import picomatch from "picomatch";

// Rspack's native binding and esbuild load on first use: most reader calls never need them.
const require = createRequire(import.meta.url);
const rspack = (): typeof import("@rspack/core").experiments =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `require` is untyped; the import type names the module it loads.
  (require("@rspack/core") as typeof import("@rspack/core")).experiments;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `require` is untyped; the import type names the module it loads.
const esbuild = () => require("esbuild") as typeof Esbuild;

/** The parts of a child process the reader uses. */
export type ReaderProcess = {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Settles with the exit code, or 128 for a signal, once the process has ended. */
  readonly exited: Promise<number>;
  readonly kill: (signal?: NodeJS.Signals) => void;
};

type Stdio = "ignore" | "pipe" | "inherit";

/** Options for one child process; `ipc` opens a JSON message channel to it. */
type ReaderProcessOptions = {
  readonly cmd: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: Stdio;
  readonly stdout?: Stdio;
  readonly stderr?: Stdio;
  readonly ipc?: (message: unknown) => void;
};

const empty = () =>
  new ReadableStream<Uint8Array>({
    start: (controller) => controller.close(),
  });

/** Starts one child process. */
const spawnProcess = (options: ReaderProcessOptions): ReaderProcess => {
  const [command, ...args] = options.cmd;
  const child = spawnChild(command, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ?? process.env,
    stdio: [
      options.stdin ?? "ignore",
      options.stdout ?? "pipe",
      options.stderr ?? "pipe",
      ...(options.ipc === undefined ? [] : ["ipc" as const]),
    ],
    serialization: "json",
  });
  if (options.ipc !== undefined) child.on("message", options.ipc);
  const web = (stream: Readable | null) =>
    stream === null
      ? empty()
      : // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Node types web streams from `node:stream/web`, structurally the global ReadableStream.
        (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>);
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code) => resolve(code ?? 128));
    child.once("error", () => resolve(127));
  });
  return {
    stdout: web(child.stdout),
    stderr: web(child.stderr),
    exited,
    kill: (signal) => {
      child.kill(signal);
    },
  };
};

/**
 * The reader's process boundary. Tests replace `spawn` on this object to model the engine, the
 * watcher and the browser opener without starting them.
 */
export const readerProcesses = { spawn: spawnProcess };

/** The syntaxes a reader module can be written in. */
export type ModuleLoader = "ts" | "tsx" | "jsx" | "js";

/** Compiles one module to plain JavaScript with Rspack's SWC: types and JSX removed, imports kept. */
export const transpile = (source: string, loader: ModuleLoader): string =>
  rspack().swc.transformSync(source, {
    jsc: {
      parser:
        loader === "ts" || loader === "tsx"
          ? { syntax: "typescript", tsx: loader === "tsx" }
          : { syntax: "ecmascript", jsx: loader === "jsx" },
      target: "es2022",
      transform: { react: { runtime: "automatic" } },
    },
    module: { type: "es6" },
    isModule: true,
  }).code;

/** One ESTree node, read only for the fields import scanning needs. */
type ScannedNode = { readonly type?: unknown; readonly source?: unknown; readonly value?: unknown };

const isNode = (value: unknown): value is ScannedNode & Record<string, unknown> =>
  typeof value === "object" && value !== null;

const importNodes = new Set([
  "ImportDeclaration",
  "ExportAllDeclaration",
  "ExportNamedDeclaration",
  "ImportExpression",
]);

/** The specifiers a node and its children import: static, re-exported and literal dynamic imports. */
const specifiersIn = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap(specifiersIn);
  if (isNode(value) === false) return [];
  const own =
    typeof value.type === "string" &&
    importNodes.has(value.type) &&
    isNode(value.source) &&
    value.source.type === "Literal" &&
    typeof value.source.value === "string"
      ? [value.source.value]
      : [];
  return [...own, ...Object.values(value).flatMap(specifiersIn)];
};

/** Every module specifier one module imports, after its types are removed. */
export const scanImports = (source: string, loader: ModuleLoader): ReadonlyArray<string> =>
  specifiersIn(
    Parser.parse(transpile(source, loader), { ecmaVersion: "latest", sourceType: "module" }),
  );

let resolver: InstanceType<ReturnType<typeof rspack>["resolver"]["ResolverFactory"]> | undefined;

/** Resolves a package the way a browser bundle would, from the file that imports it. */
export const resolveModule = async (specifier: string, fromFile: string): Promise<string> => {
  resolver ??= new (rspack().resolver.ResolverFactory)({
    conditionNames: ["browser", "import", "module", "default"],
    mainFields: ["browser", "module", "main"],
    extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
  });
  const result = await resolver.async(dirname(fromFile), specifier);
  if (typeof result.path !== "string")
    throw new Error(result.error ?? `Cannot resolve ${specifier}.`);
  return result.path;
};

/** The outcome of compiling one browser entry: its error messages when it fails. */
export type BrowserBuild = { readonly success: boolean; readonly messages: ReadonlyArray<string> };

const isBuildFailure = (error: unknown): error is Esbuild.BuildFailure =>
  error instanceof Error && "errors" in error && Array.isArray(error.errors);

/** Code the browser check compiles; any other imported file is an asset it only needs to find. */
const compiledModule = /\.(?:[cm]?[jt]sx?|json|css)$/;

/** Loads every asset (an image, a font) as an empty file, as a bundler that copies it would. */
const assetsAsFiles: Esbuild.Plugin = {
  name: "tack-reader-assets",
  setup: (build) => {
    build.onLoad({ filter: /.*/ }, (args) =>
      compiledModule.test(args.path) === true ? undefined : { contents: "", loader: "empty" },
    );
  },
};

/** Bundles one entry for the browser without writing anything, to report compile errors early. */
export const checkBrowserBuild = async (
  entry: string,
  external: ReadonlyArray<string>,
): Promise<BrowserBuild> => {
  try {
    await esbuild().build({
      entryPoints: [entry],
      bundle: true,
      platform: "browser",
      format: "esm",
      external: [...external],
      jsx: "automatic",
      // Nothing is written; an output directory only lets stylesheets and assets join the bundle.
      absWorkingDir: dirname(entry),
      outdir: dirname(entry),
      write: false,
      logLevel: "silent",
      plugins: [assetsAsFiles],
    });
    return { success: true, messages: [] };
  } catch (error) {
    if (isBuildFailure(error) === false) throw error;
    return {
      success: false,
      messages: error.errors.map((message) =>
        message.location === null
          ? message.text
          : `${message.location.file}:${message.location.line}: ${message.text}`,
      ),
    };
  }
};

/** Matches a path against one glob pattern; dotfiles match like any other name. */
export const globMatcher = (pattern: string): ((path: string) => boolean) =>
  picomatch(pattern, { dot: true });
