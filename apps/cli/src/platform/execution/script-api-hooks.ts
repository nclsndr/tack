import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import {
  compiledModule,
  extensionlessTarget,
  loadPlan,
  type ScriptApiLoaderData,
} from "./script-api-loader.ts";

// A package build ships the script API and the asynchronous hooks module as their own files beside
// the bundle, and names them here.
// oxlint-disable-next-line eslint/no-underscore-dangle -- The package build injects this constant by its reserved name.
declare const __TACK_SCRIPT_API__: string | undefined;
// oxlint-disable-next-line eslint/no-underscore-dangle -- The package build injects this constant by its reserved name.
declare const __TACK_SCRIPT_LOADER__: string | undefined;

/** The script API module scripts get: the package's own file, else the workspace source. */
// Coverage skip: only a package or release build defines the API file.
/* v8 ignore start -- @preserve */
export const scriptApiUrl =
  typeof __TACK_SCRIPT_API__ === "string"
    ? new URL(__TACK_SCRIPT_API__, import.meta.url).href
    : import.meta.resolve("@tackup/core/script-api");
/* v8 ignore stop -- @preserve */

/** The hooks module Node 22.12–22.14 load on their hooks thread. */
// Coverage skip: only a package build defines the hooks file.
/* v8 ignore start -- @preserve */
const scriptApiLoaderUrl =
  typeof __TACK_SCRIPT_LOADER__ === "string"
    ? new URL(__TACK_SCRIPT_LOADER__, import.meta.url).href
    : new URL("./script-api-loader.ts", import.meta.url).href;
/* v8 ignore stop -- @preserve */

/** How this runtime lets the worker provide a module under a package name. */
export type ScriptApiHook = "bun-virtual-module" | "node-sync-hooks" | "node-async-hooks";

/** The hook this runtime supports: Bun's virtual modules, else Node's in-thread or threaded hooks. */
export const scriptApiHook = (): ScriptApiHook =>
  process.versions.bun !== undefined
    ? "bun-virtual-module"
    : // Coverage skip: tests run under Bun; the Node lanes of the gates run these branches.
      /* v8 ignore next -- @preserve */
      typeof nodeModule.registerHooks === "function"
      ? "node-sync-hooks"
      : "node-async-hooks";

type BunPluginBuilder = {
  readonly module: (
    specifier: string,
    load: () => { readonly contents: string; readonly loader: "js" },
  ) => void;
};
type BunRuntime = {
  readonly plugin: (plugin: {
    readonly name: string;
    readonly setup: (build: BunPluginBuilder) => void;
  }) => void;
};

/**
 * Makes `specifier` import the running Tack's own script API, in this process only, whatever a
 * source installed under that name. Bun ignores runtime resolve hooks for bare package names, so it
 * gets a virtual module and keeps its own TypeScript. Node gets resolve and load hooks that also
 * compile TypeScript with SWC (see `script-api-loader.ts`).
 */
// Coverage skip: hooks change module resolution for the whole process; the worker subprocess
// installs them, and the runtime and package gates exercise each runtime's branch.
/* v8 ignore start -- @preserve */
export const installScriptApi = (specifier: string, apiUrl: string): ScriptApiHook => {
  const hook = scriptApiHook();
  if (hook === "bun-virtual-module") {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The Bun global exists only under Bun, which `scriptApiHook` checked.
    const bun = (globalThis as unknown as { readonly Bun: BunRuntime }).Bun;
    const contents = `export * from ${JSON.stringify(fileURLToPath(apiUrl))};`;
    bun.plugin({
      name: "tack-script-api",
      setup: (build) => build.module(specifier, () => ({ contents, loader: "js" })),
    });
  } else if (hook === "node-sync-hooks")
    nodeModule.registerHooks({
      resolve: (requested, context, next) => {
        if (requested === specifier) return { url: apiUrl, shortCircuit: true };
        try {
          return next(requested, context);
        } catch (error) {
          const retry =
            error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND"
              ? extensionlessTarget(requested, context.parentURL)
              : undefined;
          if (retry === undefined) throw error;
          return { url: retry, shortCircuit: true };
        }
      },
      load: (url, context, next) => {
        const plan = loadPlan(url, context);
        if (plan === "compile") return compiledModule(url);
        return plan === "json"
          ? next(url, {
              ...context,
              importAttributes: { ...context.importAttributes, type: "json" },
            })
          : next(url, context);
      },
    });
  else
    nodeModule.register(scriptApiLoaderUrl, {
      data: { specifier, apiUrl } satisfies ScriptApiLoaderData,
    });
  return hook;
};
/* v8 ignore stop -- @preserve */
