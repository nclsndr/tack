import { parse, parseExpression } from "@babel/parser";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import remarkFrontmatter from "remark-frontmatter";

import type { BundleReference } from "../../domain/bundles/bundle-reference.ts";

type SyntaxNode = { readonly type: string; readonly [key: string]: unknown };
const node = (value: unknown): value is SyntaxNode =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
const literal = (value: unknown) =>
  node(value) === true && value.type === "StringLiteral" && typeof value["value"] === "string"
    ? value["value"]
    : undefined;
const parserOptions = {
  sourceType: "unambiguous",
  plugins: ["typescript", "jsx", "decorators"],
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  createImportExpressions: true,
} satisfies NonNullable<Parameters<typeof parse>[1]>;
const assetAttributes = new Set(["src", "href", "poster"]);

/** Walks parser-owned nodes only; comments, strings and source text never become executable syntax. */
function* syntaxNodes(value: unknown): Generator<SyntaxNode> {
  if (Array.isArray(value) === true) {
    for (const child of value) yield* syntaxNodes(child);
  } else if (node(value) === true) {
    yield value;
    for (const child of Object.values(value)) yield* syntaxNodes(child);
  }
}
const moduleArgument = (argument: unknown): BundleReference => {
  const value = literal(argument);
  return value === undefined
    ? { kind: "computed", value: "module path" }
    : { kind: "module", value };
};
const sourceReferences = (root: unknown): ReadonlyArray<BundleReference> =>
  Array.from(syntaxNodes(root)).flatMap((entry): ReadonlyArray<BundleReference> => {
    if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(
        entry.type,
      ) === true &&
      entry["importKind"] !== "type" &&
      entry["exportKind"] !== "type"
    ) {
      const value = literal(entry["source"]);
      return value === undefined ? [] : [{ kind: "module", value }];
    }
    if (entry.type === "ImportExpression") return [moduleArgument(entry["source"])];
    if (entry.type === "CallExpression" && node(entry["callee"]) === true) {
      const callee = entry["callee"];
      const requireCall = callee.type === "Identifier" && callee["name"] === "require";
      const requireResolve =
        callee.type === "MemberExpression" &&
        node(callee["object"]) === true &&
        callee["object"].type === "Identifier" &&
        callee["object"]["name"] === "require" &&
        node(callee["property"]) === true &&
        callee["property"].type === "Identifier" &&
        callee["property"]["name"] === "resolve";
      if (requireCall === true || requireResolve === true || callee.type === "Import")
        return [
          moduleArgument(
            Array.isArray(entry["arguments"]) === true && entry["arguments"].length === 1
              ? entry["arguments"][0]
              : undefined,
          ),
        ];
    }
    if (
      entry.type === "JSXAttribute" &&
      node(entry["name"]) === true &&
      typeof entry["name"]["name"] === "string" &&
      assetAttributes.has(entry["name"]["name"]) === true
    ) {
      const value = literal(
        node(entry["value"]) === true && entry["value"].type === "JSXExpressionContainer"
          ? entry["value"]["expression"]
          : entry["value"],
      );
      return [
        { kind: value === undefined ? "computed" : "asset", value: value ?? "asset reference" },
      ];
    }
    return [];
  });
const markdown = unified().use(remarkParse).use(remarkFrontmatter);
const mdx = unified().use(remarkParse).use(remarkFrontmatter).use(remarkMdx);
const markdownNodes = (value: unknown): ReadonlyArray<SyntaxNode> =>
  node(value) === false
    ? []
    : [
        value,
        ...(Array.isArray(value["children"]) === true
          ? value["children"].flatMap(markdownNodes)
          : []),
      ];
const htmlReferences = (text: string): ReadonlyArray<BundleReference> => {
  const collect = (entry: DefaultTreeAdapterTypes.ChildNode): ReadonlyArray<BundleReference> => [
    ...("attrs" in entry
      ? entry.attrs
          .filter((attribute) => assetAttributes.has(attribute["name"]) === true)
          .map((attribute) => ({ kind: "asset" as const, value: attribute["value"] }))
      : []),
    ...("childNodes" in entry ? entry.childNodes.flatMap(collect) : []),
  ];
  return parseFragment(text).childNodes.flatMap(collect);
};

/** Reads real JS/TS/JSX and Markdown/MDX references without transforming, importing or running content. */
export const bundleReferences = (file: string, text: string): ReadonlyArray<BundleReference> => {
  if (/\.mdx?$/i.test(file) === false)
    return sourceReferences(
      parse(text, {
        ...parserOptions,
        plugins:
          /x$/i.test(file) === true
            ? parserOptions.plugins
            : parserOptions.plugins.filter((plugin) => plugin !== "jsx"),
      }),
    );
  const nodes = markdownNodes(
    (file.toLowerCase().endsWith(".mdx") === true ? mdx : markdown).parse(text),
  );
  const definitions = new Map(
    nodes
      .filter(
        (entry) =>
          entry.type === "definition" &&
          typeof entry["identifier"] === "string" &&
          typeof entry["url"] === "string",
      )
      .map((entry) => [entry["identifier"], entry["url"]]),
  );
  return nodes.flatMap((entry): ReadonlyArray<BundleReference> => {
    if ((entry.type === "link" || entry.type === "image") && typeof entry["url"] === "string")
      return [{ kind: "asset", value: entry["url"] }];
    if (entry.type === "linkReference" || entry.type === "imageReference") {
      const value = definitions.get(entry["identifier"]);
      return typeof value === "string" ? [{ kind: "asset", value }] : [];
    }
    if (entry.type === "html" && typeof entry["value"] === "string")
      return htmlReferences(entry["value"]);
    if (entry.type === "mdxjsEsm" && typeof entry["value"] === "string")
      return sourceReferences(parse(entry["value"], parserOptions));
    if (
      (entry.type === "mdxFlowExpression" || entry.type === "mdxTextExpression") &&
      typeof entry["value"] === "string" &&
      entry["value"].trim().length > 0
    )
      return sourceReferences(parseExpression(entry["value"], parserOptions));
    if (
      (entry.type === "mdxJsxFlowElement" || entry.type === "mdxJsxTextElement") &&
      Array.isArray(entry["attributes"]) === true
    )
      return entry["attributes"].flatMap((attribute: unknown): ReadonlyArray<BundleReference> => {
        if (node(attribute) === false) return [];
        const expression =
          node(attribute["value"]) === true && typeof attribute["value"]["value"] === "string"
            ? parseExpression(attribute["value"]["value"], parserOptions)
            : undefined;
        const imports = expression === undefined ? [] : sourceReferences(expression);
        if (
          typeof attribute["name"] !== "string" ||
          assetAttributes.has(attribute["name"]) === false
        )
          return imports;
        const value =
          typeof attribute["value"] === "string" ? attribute["value"] : literal(expression);
        return [
          ...imports,
          { kind: value === undefined ? "computed" : "asset", value: value ?? "asset reference" },
        ];
      });
    return [];
  });
};
