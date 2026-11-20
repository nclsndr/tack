/**
 * The module hooks that give scripts on Node the script API and Bun's TypeScript dialect: the
 * published name resolves to the running Tack's API, TypeScript compiles with Rspack's SWC (a type
 * imported without `import type`, enums, decorators, TSX), an extensionless relative import finds its
 * file, and a JSON import needs no attribute. Node 22.15 and later run these hooks in the worker's
 * thread; earlier versions load this module on a hooks thread with `module.register`, so it imports
 * only Node built-ins and loads Rspack on the first TypeScript file.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** What the hooks need to know: the name scripts import and the API module it stands for. */
export type ScriptApiLoaderData = { readonly specifier: string; readonly apiUrl: string };

type ResolveResult = { readonly url: string; readonly shortCircuit?: boolean };
type LoadContext = {
  readonly importAttributes?: Readonly<Record<string, string | undefined>> | undefined;
};
type LoadResult = {
  readonly format?: string | null;
  readonly source?: string | ArrayBuffer | Uint8Array | null;
  readonly shortCircuit?: boolean;
};

const typeScript = /\.(?:[cm]?ts|tsx)$/;
const extensionSuffixes = [".ts", ".tsx", "/index.ts", "/index.tsx", ".js"] as const;

/** Rspack's SWC, loaded on the first TypeScript file; it ships with Tack for the reader. */
let swc: typeof import("@rspack/core").experiments.swc | undefined;
const loadSwc = () =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `require` is untyped; the import type names the module it loads.
  (swc ??= (createRequire(import.meta.url)("@rspack/core") as typeof import("@rspack/core"))
    .experiments.swc);

/** Compiles one TypeScript module to JavaScript, keeping its imports as written. */
export const compileTypeScript = (source: string, path: string): string =>
  loadSwc().transformSync(source, {
    filename: path,
    jsc: {
      parser: { syntax: "typescript", tsx: path.endsWith("x"), decorators: true },
      target: "es2022",
      transform: { react: { runtime: "automatic" }, legacyDecorator: true },
    },
    module: { type: "es6" },
    isModule: true,
  }).code;

/** The file an extensionless relative import names, trying the extensions Bun would. */
export const extensionlessTarget = (specifier: string, parentUrl: string | undefined) =>
  specifier.startsWith(".") === false || parentUrl === undefined
    ? undefined
    : extensionSuffixes
        .map((suffix) => new URL(`${specifier}${suffix}`, parentUrl))
        .find((candidate) => existsSync(fileURLToPath(candidate)))?.href;

const isModuleNotFound = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND";

/** How a module loads: compiled when it is the script's own TypeScript, unchanged otherwise. */
export const loadPlan = (url: string, context: LoadContext): "compile" | "json" | "default" =>
  url.endsWith(".json") && context.importAttributes?.["type"] === undefined
    ? "json"
    : url.startsWith("file:") && typeScript.test(url) && url.includes("/node_modules/") === false
      ? "compile"
      : "default";

/** Compiles one TypeScript file into a module load result. */
export const compiledModule = (
  url: string,
): { readonly format: "module"; readonly source: string; readonly shortCircuit: true } => {
  const path = fileURLToPath(url);
  return {
    format: "module" as const,
    source: compileTypeScript(readFileSync(path, "utf8"), path),
    shortCircuit: true as const,
  };
};

let data: ScriptApiLoaderData | undefined;

/** Receives the hook data on the hooks thread (Node 22.12–22.14). */
export const initialize = (received: ScriptApiLoaderData): void => {
  data = received;
};

/** The asynchronous resolve hook. */
export const resolve = async (
  specifier: string,
  context: { readonly parentURL?: string },
  next: (specifier: string, context: object) => Promise<ResolveResult>,
): Promise<ResolveResult> => {
  if (data !== undefined && specifier === data.specifier)
    return { url: data.apiUrl, shortCircuit: true };
  try {
    return await next(specifier, context);
  } catch (error) {
    const retry = isModuleNotFound(error)
      ? extensionlessTarget(specifier, context.parentURL)
      : undefined;
    if (retry === undefined) throw error;
    return { url: retry, shortCircuit: true };
  }
};

/** The asynchronous load hook. */
export const load = async (
  url: string,
  context: LoadContext,
  next: (url: string, context: LoadContext) => Promise<LoadResult>,
): Promise<LoadResult> => {
  const plan = loadPlan(url, context);
  return plan === "compile"
    ? compiledModule(url)
    : plan === "json"
      ? next(url, { ...context, importAttributes: { ...context.importAttributes, type: "json" } })
      : next(url, context);
};
