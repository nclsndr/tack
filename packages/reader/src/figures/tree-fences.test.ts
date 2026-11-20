import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Root, RootContent } from "mdast";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { remarkSourceBlocks } from "../source.ts";
import { FileTree } from "./file-tree.tsx";
import { fenceMeta, treeFences } from "./tree-fences.ts";

const tree = "a/\n  b -> ../c  # a link\nc\n";
const fence = `\`\`\`tree id="disk" title="One link points at a file"\n${tree}\`\`\`\n`;

const markdown = unified().use(remarkParse).use(remarkFrontmatter);
const mdx = unified().use(remarkParse).use(remarkMdx).use(remarkFrontmatter);

const isRoot = (node: { readonly type: string }): node is Root => node.type === "root";

/** Every FileTree element in a tree, wrapped or not. */
function fileTrees(node: Root | RootContent): readonly MdxJsxFlowElement[] {
  const own = node.type === "mdxJsxFlowElement" && node.name === "FileTree" ? [node] : [];
  return "children" in node
    ? [...own, ...(node.children as readonly RootContent[]).flatMap((child) => fileTrees(child))]
    : own;
}
const props = (element: MdxJsxFlowElement | undefined): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    (element?.attributes ?? []).flatMap((attribute) =>
      attribute.type === "mdxJsxAttribute" ? [[attribute.name, attribute.value]] : [],
    ),
  );

describe("tree fences", () => {
  it("reads id, title and summary from the fence line and ignores other keys", () => {
    expect(fenceMeta(`id="a" title='It is a claim' summary="s" other="x"`)).toEqual({
      id: "a",
      title: "It is a claim",
      summary: "s",
    });
    expect(fenceMeta(undefined)).toEqual({});
  });

  it("turns a fence into a FileTree with the tree as its source", () => {
    const element = fileTrees(treeFences(markdown.parse(fence)))[0];
    expect(props(element)).toEqual({
      id: "disk",
      title: "One link points at a file",
      source: tree.trimEnd(),
    });
    expect(element?.position?.start.line).toBe(1);
  });

  it("gives a wrapper its fence, and the wrapper's attributes win", () => {
    const wrapped = `<FileTree id="outer" lenses={[]}>\n\n${fence}\n</FileTree>\n`;
    const element = fileTrees(treeFences(mdx.parse(wrapped)))[0];
    expect(Object.keys(props(element))).toEqual(["id", "lenses", "title", "source"]);
    expect(props(element)["id"]).toBe("outer");
    expect(element?.children).toEqual([]);
  });

  it("turns a fence built without a source position into a FileTree without one", () => {
    const built: Root = {
      type: "root",
      children: [{ type: "code", lang: "tree", meta: 'id="disk"', value: tree }],
    };
    const element = fileTrees(treeFences(built))[0];
    expect(props(element)).toEqual({ id: "disk", source: tree });
    expect(element !== undefined && "position" in element).toBe(false);
  });

  it("leaves other fences and a wrapper without a fence alone", () => {
    const parsed = treeFences(mdx.parse('```ts\nconst a = 1;\n```\n\n<FileTree id="x" />\n'));
    expect(parsed.children.map((node) => node.type)).toEqual(["code", "mdxJsxFlowElement"]);
    expect(props(fileTrees(parsed)[0])).toEqual({ id: "x" });
  });

  it("draws the same figure from a .md and a .mdx document through the reader's plugin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tack-tree-fence-"));
    const rendered = await Promise.all(
      [
        { name: "page.md", processor: markdown },
        { name: "page.mdx", processor: mdx },
      ].map(async ({ name, processor }) => {
        const path = join(directory, name);
        const value = `# Disk\n\n${fence}`;
        await writeFile(path, value);
        const pipeline = processor().use(remarkSourceBlocks);
        const result = await pipeline.run(pipeline.parse({ path, value }), { path, value });
        if (isRoot(result) === false) throw new Error("The plugin must return a document tree");
        const [block] = result.children;
        expect(block?.type === "mdxJsxFlowElement" ? block.name : undefined).toBe("SourceBlock");
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Attribute values of a fence are strings.
        return renderToStaticMarkup(createElement(FileTree, props(fileTrees(result)[0]) as never));
      }),
    );
    expect(rendered[0]).toContain("tack-file-tree");
    expect(rendered[0]).toContain('data-entry="a/b"');
    expect(rendered[1]).toBe(rendered[0]);
  });
});
