import { extname } from "node:path";
import type { Root, RootContent } from "mdast";
import type { MdxJsxFlowElement, MdxJsxTextElement } from "mdast-util-mdx-jsx";
import { authoredTree } from "../parsed-source.ts";
import { authorComponentNames, calloutLabels, type AuthorComponentName } from "./kinds.ts";

/** A misused author component of one document, by file and line. */
export type ComponentFinding = {
  readonly path: string;
  readonly line: number;
  readonly component: AuthorComponentName;
  readonly message: string;
};

/** What the component check found in one document: how many author components, and the misuses. */
export type ComponentCheck = {
  readonly components: number;
  readonly findings: readonly ComponentFinding[];
};

type Element = MdxJsxFlowElement | MdxJsxTextElement;

const authored: ReadonlySet<string> = new Set(authorComponentNames);
const kinds = Object.keys(calloutLabels);

const isElement = (node: Root | RootContent): node is Element =>
  node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";

/** A plain-string attribute, `undefined` when absent or not a plain string. */
const literal = (element: Element, name: string): string | undefined => {
  const value = element.attributes.find(
    (attribute) => attribute.type === "mdxJsxAttribute" && attribute.name === name,
  )?.value;
  return typeof value === "string" ? value : undefined;
};

/** The author components under `node`, each with whether it sits directly in a `Tabs`. */
function elements(node: Root | RootContent, inTabs: boolean): readonly [Element, boolean][] {
  const own: readonly [Element, boolean][] =
    isElement(node) && node.name !== null && authored.has(node.name) ? [[node, inTabs]] : [];
  // MDX wraps a line of elements in a paragraph, so a Tab can sit in one inside its Tabs.
  const nested = (isElement(node) && node.name === "Tabs") || (inTabs && node.type === "paragraph");
  return [
    ...own,
    ...("children" in node ? node.children.flatMap((child) => elements(child, nested)) : []),
  ];
}

/** The `Tab` children of a `Tabs`, also when MDX wrapped them in a paragraph. */
const tabsOf = (tabs: Element): readonly Element[] =>
  tabs.children.flatMap((child): readonly Element[] =>
    isElement(child) && child.name === "Tab"
      ? [child]
      : "children" in child
        ? child.children.flatMap((inner) =>
            isElement(inner) && inner.name === "Tab" ? [inner] : [],
          )
        : [],
  );

/**
 * The component check of one document: every `Callout`, `Tabs`, `Tab` and `Term` of its MDX, and
 * each one used so the reader cannot show it as meant. It reads nothing from disk, and reads the
 * document's shared tree, so a document the corpus already loaded is not parsed again. A `.md`
 * document renders no components.
 *
 * @param path - The document's path; its extension says whether it is MDX.
 */
export function checkDocumentComponents(source: string, path: string): ComponentCheck {
  if (extname(path) !== ".mdx") return { components: 0, findings: [] };
  const found = elements(authoredTree(path, source), false);
  const findings = found.flatMap(([element, inTabs]): readonly ComponentFinding[] => {
    const line = element.position?.start.line ?? 0;
    const finding = (component: ComponentFinding["component"], message: string) => [
      { path, line, component, message },
    ];
    switch (element.name) {
      case "Callout": {
        const kind = literal(element, "kind");
        return kind === undefined || kinds.includes(kind)
          ? []
          : finding("Callout", `Callout kind "${kind}" is not one of ${kinds.join(", ")}`);
      }
      case "Tabs":
        return tabsOf(element).length < 2
          ? finding("Tabs", "Tabs needs at least two Tab children; one alternative is just content")
          : [];
      case "Term":
        return (literal(element, "title") ?? "") === ""
          ? finding("Term", 'a Term needs its definition, such as title="A folder Tack reads"')
          : [];
      default: {
        if (inTabs === false) return finding("Tab", "a Tab only works inside Tabs");
        const label = literal(element, "label") ?? "";
        return label === "" ? finding("Tab", 'a Tab needs a label, such as label="macOS"') : [];
      }
    }
  });
  const duplicates = found.flatMap(([element]): readonly ComponentFinding[] => {
    if (element.name !== "Tabs") return [];
    const labelled = tabsOf(element).flatMap((tab) => {
      const label = literal(tab, "label");
      return label === undefined || label === "" ? [] : [{ tab, label }];
    });
    return labelled.flatMap(({ tab, label }, index) =>
      labelled.findIndex((other) => other.label === label) === index
        ? []
        : [
            {
              path,
              line: tab.position?.start.line ?? 0,
              component: "Tab" as const,
              message: `Tab label "${label}" is used twice in the same Tabs`,
            },
          ],
    );
  });
  return {
    components: found.length,
    findings: [...findings, ...duplicates].toSorted((left, right) => left.line - right.line),
  };
}
