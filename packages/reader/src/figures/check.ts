/**
 * The figure check: finds every catalog figure in a document or a folder of documents, reads its
 * props without running the page, and lists the same issues the page shows under the figure.
 * It needs no browser and runs no author code.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { Root, RootContent } from "mdast";
import type {
  MdxJsxAttribute,
  MdxJsxExpressionAttribute,
  MdxJsxFlowElement,
  MdxJsxTextElement,
} from "mdast-util-mdx-jsx";
import type { ModuleDeclaration, Program, Statement } from "estree";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import remarkFrontmatter from "remark-frontmatter";
import { figureCatalog, figureUnchecked, isFigureComponent } from "./catalog.ts";
import { treeFences } from "./tree-fences.ts";
import { type AuthoredElement, kitElements, type KitElementName } from "./authored-model.ts";
import { issueLine } from "./issues.ts";
import { checkDocumentIcons, documentIconUses, type IconIssue } from "../icons/usage.ts";
import { checkDocumentComponents, type ComponentFinding } from "../authoring/check.ts";
import {
  documentScope,
  type ModuleGraph,
  type ModuleScope,
  NotStatic,
  staticValue,
} from "./static-props.ts";

/** One figure: `ok`, its issue lines, or why it could not be checked without running the page. */
export type FigureCheckResult =
  | {
      readonly component: string;
      readonly id: string;
      readonly line: number;
      readonly status: "ok";
      /** What the check read but could not verify, such as raw shapes. */
      readonly unchecked?: readonly string[];
    }
  | {
      readonly component: string;
      readonly id: string;
      readonly line: number;
      readonly status: "issues";
      readonly issues: readonly string[];
      readonly unchecked?: readonly string[];
    }
  | {
      readonly component: string;
      readonly id: string;
      readonly line: number;
      readonly status: "not-checked";
      readonly reason: string;
    };

export type FigureCheckDocument = {
  readonly path: string;
  readonly figures: readonly FigureCheckResult[];
  /** The document's `<Icon>` uses: how many, and those whose name the reader cannot draw. */
  readonly icons: number;
  readonly iconIssues: readonly IconIssue[];
  /** The document's author components (`Callout`, `Tabs`, `Tab`, `Term`), and those misused. */
  readonly components: number;
  readonly componentIssues: readonly Omit<ComponentFinding, "path">[];
};

export type FigureCheckReport = {
  readonly documents: readonly FigureCheckDocument[];
  /** Figures checked, with or without issues. */
  readonly figures: number;
  /** Figures with at least one issue. */
  readonly failing: number;
  /** Figures whose props are computed at runtime. */
  readonly unchecked: number;
  /** `<Icon>` uses checked. */
  readonly icons: number;
  /** `<Icon>` uses whose name is not in the docs icon set or not a plain string. */
  readonly unknownIcons: number;
  /** Author components checked. */
  readonly components: number;
  /** Author components used so the reader cannot show them as meant. */
  readonly failingComponents: number;
};

const parser = unified().use(remarkParse).use(remarkMdx).use(remarkFrontmatter);
const markdownParser = unified().use(remarkParse).use(remarkFrontmatter);

type FigureElement = MdxJsxFlowElement | MdxJsxTextElement;

/** Every JSX element in the tree whose name is a catalog figure, in document order. */
function figureElements(node: Root | RootContent): readonly FigureElement[] {
  const own =
    (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") &&
    node.name !== null &&
    isFigureComponent(node.name) === true
      ? [node]
      : [];
  return "children" in node
    ? [
        ...own,
        ...(node.children as readonly RootContent[]).flatMap((child) => figureElements(child)),
      ]
    : own;
}

function expressionOf(program: Program | null | undefined): Program["body"][number] | undefined {
  return program?.body[0];
}

/** The props of one element, evaluated statically. Throws `NotStatic` with the reason. */
function propsOf(
  element: FigureElement,
  scope: ModuleScope,
  graph: ModuleGraph,
): Readonly<Record<string, unknown>> {
  return element.attributes.reduce<Record<string, unknown>>(
    (props, attribute: MdxJsxAttribute | MdxJsxExpressionAttribute) => {
      if (attribute.type === "mdxJsxExpressionAttribute") {
        const statement = expressionOf(attribute.data?.estree);
        const object = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
        if (object === undefined) throw new NotStatic("a spread attribute that cannot be read");
        const value = staticValue(object, scope, graph);
        if (typeof value !== "object" || value === null || Array.isArray(value) === true)
          throw new NotStatic("a spread of something that is not an object");
        return { ...props, ...value };
      }
      const value = attribute.value;
      if (value === null || value === undefined) return { ...props, [attribute.name]: true };
      if (typeof value === "string") return { ...props, [attribute.name]: value };
      const statement = expressionOf(value.data?.estree);
      if (statement?.type !== "ExpressionStatement")
        throw new NotStatic(`${attribute.name} is empty`);
      try {
        return { ...props, [attribute.name]: staticValue(statement.expression, scope, graph) };
      } catch (error) {
        if (error instanceof NotStatic) throw new NotStatic(`${attribute.name}: ${error.message}`);
        throw error;
      }
    },
    {},
  );
}

/** The JSX elements among `children`, with paragraphs that wrap inline elements opened. */
function jsxChildren(children: readonly RootContent[]): readonly FigureElement[] {
  return children.flatMap((child): readonly FigureElement[] => {
    if (child.type === "mdxJsxFlowElement" || child.type === "mdxJsxTextElement") return [child];
    return child.type === "paragraph" ? jsxChildren(child.children) : [];
  });
}

const kitNames = new Map<string, KitElementName>(
  kitElements.flatMap((name) =>
    name === "raw" ? [] : [[`${name.charAt(0).toUpperCase()}${name.slice(1)}`, name] as const],
  ),
);

/**
 * An authored figure's drawing as data, read from its `<Drawing>` child: the height and every kit
 * element with its props. Any other element is a raw shape. Throws `NotStatic` like `propsOf`.
 */
function drawingOf(
  element: FigureElement,
  scope: ModuleScope,
  graph: ModuleGraph,
): { readonly height: unknown; readonly elements: readonly AuthoredElement[] } | undefined {
  const drawing = jsxChildren(element.children as readonly RootContent[]).find(
    (child) => child.name === "Drawing",
  );
  if (drawing === undefined) return undefined;
  return {
    height: propsOf(drawing, scope, graph)["height"],
    elements: jsxChildren(drawing.children as readonly RootContent[]).map((child) => {
      const kind = kitNames.get(child.name ?? "");
      return kind === undefined
        ? { element: "raw", props: {} }
        : { element: kind, props: propsOf(child, scope, graph) };
    }),
  };
}

/** One catalog figure of a document, with its props read statically or the reason they cannot be. */
export type StaticFigure = {
  readonly component: string;
  readonly line: number;
  /** The `id` written as a plain string, when there is one. */
  readonly literalId: string | undefined;
  readonly props: Readonly<Record<string, unknown>> | NotStatic;
};

/** Every catalog figure of one document, in order, with its ```tree fences read as `FileTree`. */
export async function staticFigures(path: string): Promise<readonly StaticFigure[]> {
  const mdx = extname(path) === ".mdx";
  const tree = treeFences((mdx ? parser : markdownParser).parse(await readFile(path, "utf8")));
  const body = tree.children.flatMap((node): readonly (Statement | ModuleDeclaration)[] =>
    node.type === "mdxjsEsm"
      ? ((node.data?.estree?.body ?? []) as readonly (Statement | ModuleDeclaration)[])
      : [],
  );
  const { scope, graph } = await documentScope(resolve(path), body);
  return figureElements(tree).map((element) => {
    const literalId = element.attributes.find(
      (attribute): attribute is MdxJsxAttribute =>
        attribute.type === "mdxJsxAttribute" && attribute.name === "id",
    )?.value;
    const read = (): Readonly<Record<string, unknown>> | NotStatic => {
      try {
        const props = propsOf(element, scope, graph);
        if (element.name !== "Figure") return props;
        const drawing = drawingOf(element, scope, graph);
        return drawing === undefined ? props : { ...props, drawing };
      } catch (error) {
        if (error instanceof NotStatic) return error;
        throw error;
      }
    };
    return {
      component: element.name ?? "",
      line: element.position?.start.line ?? 0,
      literalId: typeof literalId === "string" ? literalId : undefined,
      props: read(),
    };
  });
}

/** Checks the figures of one document. */
export async function checkDocument(path: string): Promise<FigureCheckDocument> {
  const absolute = resolve(path);
  const figures = await Promise.all(
    (await staticFigures(absolute)).map(async (figure): Promise<FigureCheckResult> => {
      const { component, line } = figure;
      const fallbackId = figure.literalId ?? `${component} at line ${line}`;
      if (figure.props instanceof NotStatic)
        return {
          component,
          id: fallbackId,
          line,
          status: "not-checked",
          reason: figure.props.message,
        };
      const id = typeof figure.props["id"] === "string" ? figure.props["id"] : fallbackId;
      const known = isFigureComponent(component) === true;
      const issues = known ? (await figureCatalog[component](figure.props)).map(issueLine) : [];
      const unchecked = known ? (figureUnchecked[component]?.(figure.props) ?? []) : [];
      const extra = unchecked.length === 0 ? {} : { unchecked };
      return issues.length === 0
        ? { component, id, line, status: "ok", ...extra }
        : { component, id, line, status: "issues", issues, ...extra };
    }),
  );
  const source = await readFile(absolute, "utf8");
  const componentCheck = checkDocumentComponents(source, absolute);
  return {
    path: absolute,
    figures,
    icons: documentIconUses(source, absolute).length,
    iconIssues: checkDocumentIcons(source, absolute).map(({ path: _path, ...issue }) => issue),
    components: componentCheck.components,
    componentIssues: componentCheck.findings.map(({ path: _path, ...finding }) => finding),
  };
}

const documentExtensions = new Set([".md", ".mdx"]);

/** The documents under `directory`, leaving out hidden and underscore folders and dependencies. */
async function documentsUnder(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory() === true)
        return /^[._]/.test(entry.name) === true || entry.name === "node_modules"
          ? []
          : documentsUnder(path);
      return entry.isFile() === true && documentExtensions.has(extname(entry.name)) === true
        ? [path]
        : [];
    }),
  );
  return nested.flat().toSorted();
}

/** Checks every figure in the given documents and folders of documents. */
export async function checkFigures(paths: readonly string[]): Promise<FigureCheckReport> {
  const files = (
    await Promise.all(
      paths.map(async (path) => {
        const absolute = resolve(path);
        const found = await stat(absolute).catch(() => undefined);
        if (found === undefined)
          throw Object.assign(new Error(`${path}: no document or folder at this path`), {
            code: "ENOENT",
          });
        return found.isDirectory() === true ? documentsUnder(absolute) : [absolute];
      }),
    )
  ).flat();
  const documents = await Promise.all([...new Set(files)].map((file) => checkDocument(file)));
  const figures = documents.flatMap((document) => document.figures);
  return {
    documents: documents.filter(
      (document) =>
        document.figures.length > 0 ||
        document.iconIssues.length > 0 ||
        document.componentIssues.length > 0,
    ),
    figures: figures.length,
    failing: figures.filter((figure) => figure.status === "issues").length,
    unchecked: figures.filter((figure) => figure.status === "not-checked").length,
    icons: documents.reduce((total, document) => total + document.icons, 0),
    unknownIcons: documents.reduce((total, document) => total + document.iconIssues.length, 0),
    components: documents.reduce((total, document) => total + document.components, 0),
    failingComponents: documents.reduce(
      (total, document) => total + document.componentIssues.length,
      0,
    ),
  };
}

const uncheckedText = (unchecked: readonly string[] | undefined): string =>
  unchecked === undefined || unchecked.length === 0 ? "" : ` (${unchecked.join(", ")})`;

/**
 * The report as text: one line per figure, then one line per issue, then one per unknown icon and
 * one per misused author component.
 */
export function figureReportLines(
  report: FigureCheckReport,
  relativeTo = process.cwd(),
): readonly string[] {
  return report.documents.flatMap((document) => [
    document.path.startsWith(`${relativeTo}/`) === true
      ? document.path.slice(relativeTo.length + 1)
      : document.path,
    ...document.figures.flatMap((figure) => {
      switch (figure.status) {
        case "ok":
          return [`  ${figure.id}: ok${uncheckedText(figure.unchecked)}`];
        case "issues":
          return [
            `  ${figure.id}: ${figure.issues.length} ${figure.issues.length === 1 ? "issue" : "issues"}${uncheckedText(figure.unchecked)}`,
            ...figure.issues.map((issue) => `    ${issue}`),
          ];
        case "not-checked":
          return [`  ${figure.id}: not checked: ${figure.reason}`];
        // Coverage skip: an exhaustive guard; every figure status has its own case above.
        /* v8 ignore next -- @preserve */
        default: {
          const exhaustive: never = figure;
          return exhaustive;
        }
      }
    }),
    ...document.iconIssues.map((issue) => `  icon line ${issue.line}: ${issue.message}`),
    ...document.componentIssues.map(
      (issue) => `  ${issue.component} line ${issue.line}: ${issue.message}`,
    ),
  ]);
}
