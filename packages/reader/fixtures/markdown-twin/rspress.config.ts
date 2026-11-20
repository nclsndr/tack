/**
 * A docs site whose page uses the reader's figures, built with Markdown twins (`llms: true`) by
 * `markdown-twin.test.ts`. The build writes to the directory in `TACK_MARKDOWN_TWIN_OUT`.
 */
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import { treeFences } from "../../src/figures/tree-fences.ts";

export default {
  root: fileURLToPath(new URL("./docs", import.meta.url)),
  outDir: process.env["TACK_MARKDOWN_TWIN_OUT"],
  title: "Markdown twin",
  llms: true,
  markdown: { remarkPlugins: [() => (tree: Root) => void treeFences(tree)] },
};
