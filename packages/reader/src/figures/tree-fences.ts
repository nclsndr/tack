/**
 * Turns ```tree fences into `FileTree` figures, in Markdown and in MDX. A fence on its own becomes
 * `<FileTree>` with the attributes of its fence line; a fence inside `<FileTree>` gives that
 * wrapper its text. The reader's remark plugin and the figure check both call this, so the page
 * and the check read the same tree.
 */
import type { Root, RootContent } from "mdast";
import type { MdxJsxAttribute, MdxJsxFlowElement } from "mdast-util-mdx-jsx";

/** The fence language that makes a tree. */
const treeLanguage = "tree";

/** The attributes a fence line may carry: `id="…" title="…" summary="…"`. */
const fenceAttributes = ["id", "title", "summary"] as const;

/** Reads `key="value"` and `key='value'` pairs from a fence's meta string. */
export function fenceMeta(meta: string | null | undefined): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...(meta ?? "").matchAll(/([A-Za-z][\w-]*)=(?:"([^"]*)"|'([^']*)')/g)].flatMap((match) => {
      const key = match[1] ?? "";
      return (fenceAttributes as readonly string[]).includes(key)
        ? [[key, match[2] ?? match[3] ?? ""]]
        : [];
    }),
  );
}

const attribute = (name: string, value: string): MdxJsxAttribute => ({
  type: "mdxJsxAttribute",
  name,
  value,
});

const isTreeFence = (node: RootContent): node is Extract<RootContent, { type: "code" }> =>
  node.type === "code" && node.lang === treeLanguage;

/** Rewrites the tree fences of a document in place. Returns the tree for chaining. */
export function treeFences(tree: Root): Root {
  tree.children = tree.children.map((node): RootContent => {
    if (isTreeFence(node)) {
      return {
        type: "mdxJsxFlowElement",
        name: "FileTree",
        attributes: [
          ...Object.entries(fenceMeta(node.meta)).map(([name, value]) => attribute(name, value)),
          attribute("source", node.value),
        ],
        children: [],
        ...(node.position === undefined ? {} : { position: node.position }),
      } satisfies MdxJsxFlowElement;
    }
    if (node.type === "mdxJsxFlowElement" && node.name === "FileTree") {
      const fence = node.children.find((child) => isTreeFence(child as RootContent));
      if (fence === undefined || fence.type !== "code") return node;
      const meta = fenceMeta(fence.meta);
      const written = new Set(
        node.attributes.flatMap((item) => (item.type === "mdxJsxAttribute" ? [item.name] : [])),
      );
      return {
        ...node,
        attributes: [
          ...node.attributes,
          // The wrapper's own attributes win over the fence line's.
          ...Object.entries(meta)
            .filter(([name]) => written.has(name) === false)
            .map(([name, value]) => attribute(name, value)),
          attribute("source", fence.value),
        ],
        children: node.children.filter((child) => child !== fence),
      };
    }
    return node;
  });
  return tree;
}
