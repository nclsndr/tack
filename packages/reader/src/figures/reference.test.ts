import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFigures, figureReportLines } from "./check.ts";
import { figureContracts, figureExamples, figureReference } from "./reference.ts";
import { figureCatalog } from "./catalog.ts";

describe("the figure reference", () => {
  it("documents only catalog components", () => {
    expect(figureContracts.every((contract) => Object.hasOwn(figureCatalog, contract.name))).toBe(
      true,
    );
    expect(figureReference()).toContain("## `ArchitectureMap`");
    expect(figureReference()).toContain("| `lenses` | No |");
    expect(figureReference()).toContain("## `FileTree`");
    expect(figureReference()).toContain("## `Figure`");
    expect(figureReference()).toContain("## `System`");
    expect(figureReference()).toContain("## `Schema`");
    expect(figureReference()).toContain("## `Walkthrough`");
    expect(figureReference()).toContain("| `steps` | Yes |");
    expect(figureReference()).toContain("## `Chart`");
    expect(figureReference()).toContain("| `scenarios` | No |");
    // Schema has two worked examples: a SQL schema and a domain model.
    expect(figureReference()).toContain("### Worked example: a domain model");
    expect(figureReference()).toContain("| `tables` | Yes |");
    expect(figureReference()).toContain("`stroke-muted`");
    // An example holding a fence is fenced with four backticks, so the page stays valid Markdown.
    expect(figureReference()).toContain("````mdx\n<FileTree");
  });

  it("gives worked examples that pass the figure check", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tack-figure-reference-")));
    await writeFile(
      join(root, "web-imports.ts"),
      [
        "export const links = [",
        '  { from: "pages-home", to: "api-orders" },',
        '  { from: "pages-account", to: "api-orders", label: "POST /api/orders" },',
        '  { from: "api-orders", to: "db-orders", label: "INSERT" },',
        '  { from: "jobs-billing", to: "db-orders", label: "SELECT" },',
        "];",
      ].join("\n"),
    );
    const pages = await Promise.all(
      figureExamples().map(async (example) => {
        const path = join(root, `${example.name}.mdx`);
        await writeFile(path, `# ${example.name}\n\n${example.source}\n`);
        return path;
      }),
    );
    const report = await checkFigures(pages);
    expect(figureReportLines(report, root)).toEqual([
      "ArchitectureMap.mdx",
      "  web-architecture: ok",
      "FileTree.mdx",
      "  release-on-disk: ok",
      "System.mdx",
      "  capture-path: ok",
      "Schema.mdx",
      "  parcel-schema: ok",
      "Schema-domain-model.mdx",
      "  source-domain: ok",
      "Figure.mdx",
      "  update-pipeline: ok",
      "Walkthrough.mdx",
      "  first-sync: ok",
      "Chart.mdx",
      "  sync-time: ok",
    ]);
  });
});
