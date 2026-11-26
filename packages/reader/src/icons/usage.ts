import { extname } from "node:path";
import type { Root, RootContent } from "mdast";
import { authoredTree } from "../parsed-source.ts";
import { iconNameFinding } from "./catalog.ts";

/** One `<Icon>` of a document: its line, and its name when written as a plain string. */
export type IconUse = { readonly line: number; readonly name?: string };

/** An `<Icon>` whose name cannot be drawn, with why and the names of the set to use instead. */
export type IconIssue = IconUse & {
  readonly message: string;
  readonly suggestions: readonly string[];
};

/** An unusable `<Icon>` of one document file, by path and line. */
export type IconFinding = IconIssue & { readonly path: string };

/** The attribute that names an icon: `name` on `Icon`, `icon` on `Callout`. */
const iconAttribute: Readonly<Record<string, string>> = { Icon: "name", Callout: "icon" };

function iconElements(node: Root | RootContent): readonly IconUse[] {
  const isElement = node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";
  const attributeName = isElement && node.name !== null ? iconAttribute[node.name] : undefined;
  const attributes =
    isElement && attributeName !== undefined
      ? node.attributes.filter(
          (attribute) => attribute.type === "mdxJsxAttribute" && attribute.name === attributeName,
        )
      : [];
  // An Icon always draws one; a Callout only when it names one.
  const uses = isElement && (node.name === "Icon" || attributes.length > 0);
  const own: readonly IconUse[] =
    uses === true
      ? [
          attributes
            .flatMap((attribute) =>
              attribute.type === "mdxJsxAttribute" && typeof attribute.value === "string"
                ? [attribute.value]
                : [],
            )
            .reduce<IconUse>((use, name) => ({ ...use, name }), {
              line: node.position?.start.line ?? 0,
            }),
        ]
      : [];
  return [...own, ...("children" in node ? node.children.flatMap(iconElements) : [])];
}

/**
 * Every `<Icon>` of a document, in order. Only MDX renders components, so a `.md` document has
 * none; code blocks are text, so an `<Icon>` shown in one is not counted. It reads the document's
 * shared tree, so a document the corpus already loaded is not parsed again.
 *
 * @param path - The document's path; its extension says whether it is MDX.
 */
export function documentIconUses(source: string, path: string): readonly IconUse[] {
  return extname(path) === ".mdx" ? iconElements(authoredTree(path, source)) : [];
}

/** The uses whose name is not in the docs icon set, or not a plain string the reader can bundle. */
export function iconIssues(uses: readonly IconUse[]): readonly IconIssue[] {
  return uses.flatMap((use) => {
    const finding =
      use.name === undefined
        ? {
            message:
              'an Icon needs a literal name, such as name="database", so the reader can bundle it',
            suggestions: [],
          }
        : iconNameFinding(use.name);
    return finding === undefined ? [] : [{ ...use, ...finding }];
  });
}

/**
 * The icon check of one document: every `<Icon>` of its MDX whose name is not in the docs icon set
 * or not a plain string, by file and line, with the closest names of the set. A `.md` document has
 * none. It reads nothing from disk, so any command that holds a document's text can run it.
 *
 * @param path - The document's path; its extension says whether it is MDX.
 */
export function checkDocumentIcons(source: string, path: string): readonly IconFinding[] {
  return iconIssues(documentIconUses(source, path)).map((issue) => ({ path, ...issue }));
}

/**
 * The plain-string names a component module passes to `<Icon>` or `<Callout icon>`, for bundling:
 * `name="x"` or `name={"x"}` inside an `<Icon ...>` tag, `icon="x"` inside a `<Callout ...>` tag.
 */
export function moduleIconNames(source: string): readonly string[] {
  return [
    ...source.matchAll(
      /<(?:Icon\b[^>]*?\bname|Callout\b[^>]*?\bicon)=(?:"([^"]+)"|\{\s*"([^"]+)"\s*\})/g,
    ),
  ].flatMap(([, plain, braced]) => plain ?? braced ?? []);
}
