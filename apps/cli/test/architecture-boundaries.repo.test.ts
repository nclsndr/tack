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
 * - `cli`: from argv to the public envelope, in the folders of {@link cliFolders}.
 * - `bootstrap`: the composition root that builds live layers.
 *
 * Pure policy stays ordinary TypeScript in `domain`.
 * Add an Effect `Context.Service` capability only when a feature must replace an external action in
 * tests, choose a live implementation, or share a resource lifecycle. Declare it in `services`, keep it
 * small and named for the feature intent, and add no generic infrastructure or file-operation services.
 * Its live implementation belongs in `platform`, and `bootstrap` supplies it once. A service that a
 * feature implements itself, such as `Source`, keeps its declaration and live layer in that feature.
 * The one implementation in `services` is `exclusive-lock.ts`: `platform/state` and two features
 * share that lock over `FileSystem`, and a service tag for it would add a seam for one rule.
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

/**
 * The folders of `cli`, lowest first. A folder imports only the folders before it, so the order
 * reads as the path of one command.
 *
 * - `commands`: command declarations that parse argv into transport-free requests.
 * - `envelope`: the public envelope, the command line it names, and how each typed result, partial
 *   cause and failure becomes a public outcome.
 * - `human`: the text views of an envelope.
 * - `explorer`: the interactive explorer session.
 * - `routes`: one route per command, which runs its use case and returns an outcome.
 * - `host`: dispatch, completion and the host environment; it renders and exits.
 */
const cliFolders: ReadonlyArray<string> = [
  "commands",
  "envelope",
  "human",
  "explorer",
  "routes",
  "host",
];

/**
 * The layers that may import each entry of the workspace packages the CLI uses. `domain` imports
 * none of them. The reader's pure entries hold facts and functions without I/O, so any layer above
 * `domain` may read them. The entries that read files or start the reader belong to `platform`, which
 * implements the reader services; `services` names their types only. `@tackup/core` runs scripts, so
 * only the execution adapter in `platform` imports it. An entry missing here is under no rule yet, so
 * importing it fails until it is added.
 */
const packageImports: Readonly<Record<string, ReadonlyArray<string>>> = {
  "@tackup/reader/icons": ["services", "platform", "features", "cli", "bootstrap"],
  "@tackup/reader/search-core": ["services", "platform", "features", "cli", "bootstrap"],
  "@tackup/reader/source-edges": ["services", "platform", "features", "cli", "bootstrap"],
  "@tackup/reader/figure-check": ["services", "platform", "bootstrap"],
  "@tackup/reader/search": ["services", "platform", "bootstrap"],
  "@tackup/reader/server": ["platform", "bootstrap"],
  "@tackup/core": ["platform", "bootstrap"],
  "@tackup/core/script-api": ["platform", "bootstrap"],
};

/** Whether a specifier names the reader or core package, which `packageImports` rules. */
const isWorkspacePackage = (specifier: string) =>
  /^@tackup\/(?:reader|core)(?:\/|$)/.test(specifier);

/** Root modules every layer may read; each is a leaf that imports at most `domain`. */
const rootModules: ReadonlyArray<string> = ["release.ts", "version.ts"];

/** The layer a source-relative module belongs to, or `undefined` for a root module or an unknown folder. */
const layerOf = (module: string) => {
  const first = module.split("/")[0] ?? "";
  return first in layerImports ? first : undefined;
};

/** The folder of a module inside its layer; a file directly in the layer is a folder of its own. */
const folderOf = (module: string) => {
  const [, second = ""] = module.split("/");
  return second.replace(/\.ts$/, "");
};

/** The imports between the folders of one layer, as a graph from folder to the folders it reads. */
const folderGraph = (layer: string) => {
  const graph = new Map<string, Set<string>>();
  for (const path of productionSourceFiles()) {
    const module = modulePath(path);
    if (layerOf(module) !== layer) continue;
    const folder = folderOf(module);
    const targets = graph.get(folder) ?? new Set<string>();
    for (const target of localImportsOf(path)) {
      if (layerOf(target) === layer && folderOf(target) !== folder) targets.add(folderOf(target));
    }
    graph.set(folder, targets);
  }
  return graph;
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

  it("imports the reader and core packages only from the layers their rule allows", () => {
    const violations = productionSourceFiles().flatMap((path) => {
      const module = modulePath(path);
      const layer = layerOf(module);
      return [...new Set(importsOf(path).filter(isWorkspacePackage))].flatMap((specifier) =>
        layer !== undefined && packageImports[specifier]?.includes(layer) === true
          ? []
          : [`${module} -> ${specifier}`],
      );
    });

    expect(violations).toEqual([]);
  });

  it("keeps domain free of the reader and core packages", () => {
    expect(
      Object.entries(packageImports).filter(([, layers]) => layers.includes("domain")),
    ).toEqual([]);
  });

  // `domain` holds what is stored, or what two features share. A plan, report or result schema
  // that one feature produces lives beside that feature, and a cycle between two domain folders
  // means a file sits in the wrong one.
  it.each(["domain", "features"])("keeps the %s folders a directed acyclic graph", (layer) => {
    expect(findCycle(folderGraph(layer))).toBeUndefined();
  });

  it("orders the cli folders: each imports only the folders before it", () => {
    const graph = folderGraph("cli");

    expect([...graph.keys()].toSorted()).toEqual(cliFolders.toSorted());
    expect(
      [...graph].flatMap(([folder, targets]) =>
        [...targets].flatMap((target) =>
          cliFolders.indexOf(target) < cliFolders.indexOf(folder) ? [] : [`${folder} -> ${target}`],
        ),
      ),
    ).toEqual([]);
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

  it("adds no throw: a failure goes through the Effect error channel", () => {
    // Each file that throws today, and how often. The script worker and its protocol run outside
    // Effect, and the bundle codec, the YAML reader and the release facts are plain functions. Lower
    // a count when a throw goes; a new one needs a reason to throw rather than fail an Effect.
    const allowed = {
      "cli/explorer/profile-editor.ts": 2,
      "domain/agents/agent-layout.ts": 1,
      "domain/bundles/bundle-codec.ts": 4,
      "domain/bundles/bundle-path.ts": 3,
      "domain/bundles/bundle-registration.ts": 2,
      "domain/bundles/tar.ts": 2,
      "domain/links/link-record-schema.ts": 1,
      "domain/runtime-neutral.ts": 2,
      "platform/execution/execution-platform.ts": 7,
      "platform/execution/history.ts": 10,
      "platform/execution/input.ts": 9,
      "platform/execution/protocol.ts": 8,
      "platform/execution/script-api-adapter.ts": 3,
      "platform/execution/script-api-hooks.ts": 1,
      "platform/execution/script-api-loader.ts": 1,
      "platform/execution/secrets.ts": 4,
      "platform/execution/shell.ts": 2,
      "platform/execution/supervisor.ts": 3,
      "platform/execution/worker.ts": 3,
      "release.ts": 1,
      "version.ts": 2,
    };
    const throws = productionSourceFiles().flatMap((path) => {
      const count = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
        .reduce((total, line) => total + (line.match(/\bthrow\b/g)?.length ?? 0), 0);
      return count === 0 ? [] : [[modulePath(path), count] as const];
    });

    expect(Object.fromEntries(throws)).toEqual(allowed);
  });

  it("names every service identifier after the path of its declaring module", () => {
    const identifiers = productionSourceFiles().flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/["'](tack\/cli\/[^"']+)["']/g)].map((match) => ({
        module: modulePath(path),
        identifier: match[1] ?? "",
      })),
    );
    const misnamed = identifiers.filter(
      ({ module, identifier }) =>
        identifier.slice(0, identifier.lastIndexOf("/")) !==
        `tack/cli/${module.slice(0, -".ts".length)}`,
    );

    expect(identifiers.length).toBeGreaterThan(0);
    expect(misnamed).toEqual([]);
  });
});

it("declares no hidden flags or unlisted commands, which help would omit", () => {
  const directory = join(import.meta.dirname, "../src/cli/commands");
  for (const file of readdirSync(directory)) {
    const text = readFileSync(join(directory, file), "utf8");
    expect(text, file).not.toMatch(/withHidden|unlisted/);
  }
});
