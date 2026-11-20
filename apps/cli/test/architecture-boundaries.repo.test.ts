import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../src");

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });

/** Every module specifier a file names: static imports and exports, and inline `import("...")` types. */
const importsOf = (path: string) =>
  [...readFileSync(path, "utf8").matchAll(/(?:from\s+|\bimport\(\s*)["']([^"']+)["']/g)].map(
    (match) => match[1] ?? "",
  );

const modulePath = (path: string) => relative(sourceRoot, path).replaceAll("\\", "/");

/** Source-relative paths of the modules one file imports through relative specifiers. */
const localImportsOf = (path: string) =>
  importsOf(path)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => modulePath(resolve(dirname(path), specifier)));

const productionSourceFiles = () =>
  sourceFiles(sourceRoot).filter((path) => !path.endsWith(".test.ts"));

/**
 * The layers, lowest first, and the layers each may import. An import points down this list or stays
 * inside its own layer; `platform` and `features` are siblings that never import each other.
 *
 * - `domain`: pure schemas, identities, policy, plans and static facts. No I/O, imports nothing else.
 * - `services`: the declarations of every injected capability (tag and interface), over `domain`.
 * - `platform`: adapters that implement a service against files, git, processes and the reader.
 * - `features`: use cases that drive services and domain policy.
 * - `cli`: command declarations and the host. `bootstrap`: the composition root that builds live layers.
 *
 * `cli/commands` parses command families into transport-free requests; `cli/host` dispatches them and
 * owns the single public envelope and exit status. Pure policy stays ordinary TypeScript in `domain`.
 * Add an Effect `Context.Service` capability only when a feature must replace an external action in
 * tests, choose a live implementation, or share a resource lifecycle. Declare it in `services`, keep it
 * small and named for the feature intent, and add no generic infrastructure or file-operation services.
 * Its live implementation belongs in `platform`, and `bootstrap` supplies it once. A service that a
 * feature implements itself, such as `Source`, keeps its declaration and live layer in that feature.
 * Feature workflows must not select production layers themselves.
 */
const layerImports: Readonly<Record<string, ReadonlyArray<string>>> = {
  domain: ["domain"],
  services: ["domain", "services"],
  platform: ["domain", "services", "platform"],
  features: ["domain", "services", "features"],
  cli: ["domain", "services", "features", "cli"],
  bootstrap: ["domain", "services", "platform", "features", "cli", "bootstrap"],
};

/** Root modules every layer may read; each is a leaf that imports at most `domain`. */
const rootModules: ReadonlyArray<string> = ["release.ts", "version.ts"];

/** The layer a source-relative module belongs to, or `undefined` for a root module or an unknown folder. */
const layerOf = (module: string) => {
  const first = module.split("/")[0] ?? "";
  return first in layerImports ? first : undefined;
};

/** The feature folder of a `features/` module; a file directly in `features/` is a feature of its own. */
const featureOf = (module: string) => {
  const [, second = ""] = module.split("/");
  return second.replace(/\.ts$/, "");
};

/** One cycle through a directed graph as a path that returns to its start, or `undefined`. */
const findCycle = (graph: ReadonlyMap<string, ReadonlySet<string>>) => {
  const finished = new Set<string>();
  const visit = (node: string, path: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
    const at = path.indexOf(node);
    if (at >= 0) return [...path.slice(at), node];
    if (finished.has(node)) return undefined;
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next, [...path, node]);
      if (cycle !== undefined) return cycle;
    }
    finished.add(node);
    return undefined;
  };
  for (const node of graph.keys()) {
    const cycle = visit(node, []);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
};

describe("CLI architecture boundaries", () => {
  it("keeps Effect platform imports inside bootstrap", () => {
    const violations = productionSourceFiles().flatMap((path) =>
      importsOf(path).some((specifier) => specifier.startsWith("@effect/platform-")) &&
      !modulePath(path).startsWith("bootstrap/")
        ? [modulePath(path)]
        : [],
    );

    expect(violations).toEqual([]);
  });

  it("keeps every module in a named layer", () => {
    const strays = productionSourceFiles()
      .map(modulePath)
      .filter((module) => layerOf(module) === undefined && !rootModules.includes(module))
      .filter((module) => module !== "main.ts");

    expect(strays).toEqual([]);
  });

  it("imports only downward: each layer reads the layers its rule allows", () => {
    const violations = productionSourceFiles().flatMap((path) => {
      const module = modulePath(path);
      const own = layerOf(module);
      // A root module is a leaf over domain; main.ts is the process entry over bootstrap.
      const allowed =
        own === undefined ? (module === "main.ts" ? ["bootstrap"] : ["domain"]) : layerImports[own];
      return [...new Set(localImportsOf(path))].flatMap((target) => {
        const layer = layerOf(target);
        return layer === undefined || allowed?.includes(layer) === true
          ? []
          : [`${module} -> ${target}`];
      });
    });

    expect(violations).toEqual([]);
  });

  it("keeps the feature folders a directed acyclic graph", () => {
    const graph = new Map<string, Set<string>>();
    for (const path of productionSourceFiles()) {
      const module = modulePath(path);
      if (layerOf(module) !== "features") continue;
      const feature = featureOf(module);
      const targets = graph.get(feature) ?? new Set<string>();
      for (const target of localImportsOf(path)) {
        if (layerOf(target) === "features" && featureOf(target) !== feature) {
          targets.add(featureOf(target));
        }
      }
      graph.set(feature, targets);
    }

    expect(findCycle(graph)).toBeUndefined();
  });

  it("reads the state document only through the command snapshot", () => {
    const readers = productionSourceFiles().flatMap((path) =>
      /\breadState\b/.test(readFileSync(path, "utf8")) ? [modulePath(path)] : [],
    );

    // The state service declares the read, its adapter implements it, and the command snapshot is
    // the one caller outside them.
    expect(
      readers.filter(
        (module) => module !== "services/state-store.ts" && !module.startsWith("platform/state/"),
      ),
    ).toEqual(["features/snapshot/command-snapshot.ts"]);
  });

  it("keeps CLI command declarations independent from platform adapters", () => {
    const violations = sourceFiles(resolve(sourceRoot, "cli/commands")).flatMap((path) =>
      importsOf(path).some((specifier) => specifier.includes("/platform/"))
        ? [modulePath(path)]
        : [],
    );

    expect(violations).toEqual([]);
  });

  it("keeps the browser core out of the binary: no production module imports it", () => {
    const importers = productionSourceFiles().filter((path) =>
      localImportsOf(path).includes("bootstrap/core.ts"),
    );

    expect(importers.map(modulePath)).toEqual([]);
  });

  it("builds a resource identity key in one place and never reads the reader's", () => {
    const violations = productionSourceFiles().flatMap((path) => {
      const text = readFileSync(path, "utf8");
      const module = modulePath(path);
      return [
        ...(/\bresourceIdentity\b/.test(text) ? [`${module}: reader resourceIdentity`] : []),
        // The key joins source, kind and name with a NUL; only the one key function may do that.
        ...(/sourceRegistrationId\}?\\u0000\$\{[^}]*kind/.test(text) &&
        module !== "domain/sources/catalog-schema.ts"
          ? [`${module}: its own identity key`]
          : []),
        ...(/sourceRegistrationId\s*\?\?\s*["']{2}/.test(text)
          ? [`${module}: optional source`]
          : []),
      ];
    });

    expect(violations).toEqual([]);
  });
});

it("declares no hidden flags or unlisted commands, which help would omit", () => {
  const directory = join(import.meta.dirname, "../src/cli/commands");
  for (const file of readdirSync(directory)) {
    const text = readFileSync(join(directory, file), "utf8");
    expect(text, file).not.toMatch(/withHidden|unlisted/);
  }
});
