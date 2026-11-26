import { extname } from "node:path";
import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

const markdownParser = unified().use(remarkParse).use(remarkFrontmatter);
const mdxParser = unified().use(remarkParse).use(remarkMdx).use(remarkFrontmatter);

/** The last tree parsed for each path, with the text it was parsed from. */
const trees = new Map<string, { readonly text: string; readonly tree: Root }>();

/** The paths each running {@link keepTreesUsedBy} load has asked for so far. */
const running = new Set<Set<string>>();

/**
 * The syntax tree of one authored document: Markdown for a `.md` path, MDX for any other. A path
 * and text parsed before return the same tree, so the corpus load, the icon check and the component
 * check of one document share one parse. The tree is shared: a caller reads it and never changes
 * it. A parse error is thrown and not remembered.
 */
export function authoredTree(path: string, text: string): Root {
  running.forEach((used) => used.add(path));
  const known = trees.get(path);
  if (known !== undefined && known.text === text) return known.tree;
  const tree = (extname(path) === ".md" ? markdownParser : mdxParser).parse(text);
  trees.set(path, { text, tree });
  return tree;
}

/**
 * Runs one corpus load, then forgets every tree that neither it nor a load still running asked
 * for. The trees kept are the current corpus's, so a long reader session does not keep the trees
 * of documents that were edited, moved or removed.
 */
export async function keepTreesUsedBy<T>(load: () => Promise<T>): Promise<T> {
  const used = new Set<string>();
  running.add(used);
  try {
    return await load();
  } finally {
    running.delete(used);
    const kept = [used, ...running];
    [...trees.keys()]
      .filter((path) => kept.some((paths) => paths.has(path)) === false)
      .forEach((path) => trees.delete(path));
  }
}
