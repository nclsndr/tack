import { describe, expect, it } from "vitest";
import { authoredTree, keepTreesUsedBy } from "./parsed-source.ts";

describe("authoredTree", () => {
  it("returns the same tree for the same path and text, and a new one when either changes", () => {
    const tree = authoredTree("/docs/a.mdx", "# A\n");

    expect(authoredTree("/docs/a.mdx", "# A\n")).toBe(tree);
    expect(authoredTree("/docs/a.mdx", "# A again\n")).not.toBe(tree);
    expect(authoredTree("/docs/b.mdx", "# A again\n")).not.toBe(
      authoredTree("/docs/a.mdx", "# A again\n"),
    );
  });

  it.each([
    { path: "/docs/page.md", type: "html" },
    { path: "/docs/page.mdx", type: "mdxJsxFlowElement" },
  ])("parses $path by its extension", ({ path, type }) => {
    const tree = authoredTree(path, '---\ntitle: Page\n---\n\n<Icon name="house" />\n');

    expect(tree.children.map((node) => node.type)).toEqual(["yaml", type]);
  });
});

describe("keepTreesUsedBy", () => {
  it("forgets every tree the load did not use, and keeps the ones it did", async () => {
    const kept = authoredTree("/docs/kept.mdx", "# Kept\n");
    const dropped = authoredTree("/docs/dropped.mdx", "# Dropped\n");

    const result = await keepTreesUsedBy(async () => {
      authoredTree("/docs/kept.mdx", "# Kept\n");
      return "loaded";
    });

    expect(result).toBe("loaded");
    expect(authoredTree("/docs/kept.mdx", "# Kept\n")).toBe(kept);
    expect(authoredTree("/docs/dropped.mdx", "# Dropped\n")).not.toBe(dropped);
  });

  it("keeps the trees of a load that is still running when another one ends", async () => {
    const gate = Promise.withResolvers<void>();
    const running = keepTreesUsedBy(async () => {
      const tree = authoredTree("/docs/running.mdx", "# Running\n");
      await gate.promise;
      return tree;
    });

    await keepTreesUsedBy(async () => authoredTree("/docs/other.mdx", "# Other\n"));
    gate.resolve();
    const tree = await running;

    expect(authoredTree("/docs/running.mdx", "# Running\n")).toBe(tree);
  });
});
