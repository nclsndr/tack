// @vitest-environment jsdom
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ArchitectureMap, FileTree, System } from "../visuals.tsx";
import { layoutEngineRequested } from "./layout-engine.ts";
import { testRoot } from "../react.test-support.ts";
import { capturePath } from "./system-fixtures.ts";

const source = resolve(import.meta.dirname, "..");

async function modules(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory() === true) return await modules(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

const ui = testRoot();

describe("the layout engine", () => {
  it("is imported by one module only, on demand, so it lands in its own chunk", async () => {
    const importers = await Promise.all(
      (await modules(source)).map(async (path) => {
        const text = await readFile(path, "utf8");
        const imports = [...text.matchAll(/^(?!\s*\/\/).*["']elkjs[^"']*["']/gm)].map((match) =>
          match[0].trim(),
        );
        return { path: relative(source, path), imports };
      }),
    );
    expect(importers.filter((item) => item.imports.length > 0)).toEqual([
      {
        path: "figures/layout-engine.ts",
        imports: [
          'import type { ElkNode } from "elkjs/lib/elk-api"',
          'export type { ElkNode } from "elkjs/lib/elk-api"',
          'loading ??= import("elkjs/lib/elk.bundled.js"',
        ],
      },
    ]);
  });

  it("is not requested by a page without a System, and is once a System renders", async () => {
    await ui.render([
      createElement(ArchitectureMap, {
        key: "map",
        id: "map",
        title: "A page asks the API and never the database",
        rule: { title: "Calls point down", text: "A box calls the boxes below it." },
        tiers: [
          { id: "web", label: "Web", nodes: [{ id: "page", label: "page" }] },
          { id: "api", label: "API", nodes: [{ id: "api", label: "api" }] },
        ],
        links: [{ from: "page", to: "api", label: "fetches" }],
      }),
      createElement(FileTree, {
        key: "tree",
        id: "tree",
        title: "One file sits in one folder here",
        source: "a/\n  b",
      }),
    ]);
    expect(layoutEngineRequested()).toBe(false);
    await ui.render(createElement(System, capturePath));
    expect(layoutEngineRequested()).toBe(true);
  });
});
