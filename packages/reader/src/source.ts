import { readFile, realpath, readdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Root, RootContent } from "mdast";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import remarkFrontmatter from "remark-frontmatter";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ReaderConfigurationError } from "./config.ts";
import { globMatcher } from "./host.ts";
import { readerFile } from "./reader-files.ts";
import { docsWalkSkips, marksSourceEdge } from "./source-edges.ts";
import { treeFences } from "./figures/tree-fences.ts";
import type {
  CopyInput,
  DocumentImport,
  DocumentMetadata,
  ReaderConfig,
  ReaderDocument,
  ReaderDocumentResource,
  SourceBlock,
  SourceReference,
} from "./types.ts";

const markdownParser = unified().use(remarkParse).use(remarkFrontmatter);
const mdxParser = unified().use(remarkParse).use(remarkMdx).use(remarkFrontmatter);
const metadataSchema = z.strictObject({
  title: z.string().trim().min(1),
  type: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  layout: z.string().min(1).optional(),
});
const optionalMetadataSchema = z.object({
  title: z.string().trim().min(1).optional(),
  type: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  layout: z.string().min(1).optional(),
});
const blockTypes = [
  "blockquote",
  "code",
  "heading",
  "html",
  "list",
  "mdxFlowExpression",
  "mdxJsxFlowElement",
  "paragraph",
  "table",
  "thematicBreak",
  "footnoteDefinition",
] satisfies MdxJsxFlowElement["children"][number]["type"][];

function isWrappedBlock(node: RootContent): node is MdxJsxFlowElement["children"][number] {
  return blockTypes.some((type) => type === node.type);
}

function sourceReference(path: string, node: RootContent): SourceReference {
  if (node.position === undefined)
    throw new ReaderConfigurationError(`${path}: authored block has no physical source position.`);
  return { path, startLine: node.position.start.line, endLine: node.position.end.line };
}

function blockId(reference: SourceReference) {
  return `${reference.path}:${reference.startLine}:${reference.endLine}`;
}

/** Identifies a block's exact authored contents so live edits cannot produce stale citations. */
export function sourceVersion(text: string): string {
  return text
    .split("")
    .reduce(
      (hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0,
      2166136261,
    )
    .toString(36);
}

function contributingVersion(raw: string, contents: string[]) {
  return sourceVersion(contents.length === 0 ? raw : [raw, ...contents].join("\u0000"));
}

function physicalSlice(text: string, reference: SourceReference) {
  return text
    .split(/\r?\n/)
    .slice(reference.startLine - 1, reference.endLine)
    .join("\n");
}

function literalText(text: string) {
  return [
    ...text.matchAll(
      /(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`|(?<![\w$])(-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)(?![\w$]))/g,
    ),
  ]
    .map((match) =>
      (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "")
        .replace(/\\n/g, "\n")
        .replace(/\\(["'`\\])/g, "$1"),
    )
    .join("\n");
}

function readableNode(node: RootContent): string {
  if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
    const attributes = node.attributes.flatMap((attribute) => {
      if (
        attribute.type !== "mdxJsxAttribute" ||
        attribute.value === null ||
        attribute.value === undefined
      )
        return [];
      return typeof attribute.value === "string"
        ? [attribute.value]
        : [literalText(attribute.value.value)];
    });
    return [...attributes, ...node.children.map((child) => readableNode(child))].join(" ").trim();
  }
  if (node.type === "mdxFlowExpression" || node.type === "mdxTextExpression")
    return literalText(node.value);
  if ("children" in node)
    return node.children
      .map((child) => readableNode(child))
      .join(node.type === "paragraph" || node.type === "heading" ? "" : "\n")
      .trim();
  if ("value" in node) return node.value;
  if (node.type === "image") return node.alt ?? "";
  return "";
}

function documentImports(path: string, tree: Root): DocumentImport[] {
  return tree.children.flatMap((node) => {
    if (node.type !== "mdxjsEsm") return [];
    return (
      node.data?.estree?.body.flatMap((declaration) => {
        if (
          declaration.type !== "ImportDeclaration" ||
          typeof declaration.source.value !== "string" ||
          declaration.specifiers.length === 0
        )
          return [];
        return [
          {
            specifier: declaration.source.value,
            identifiers: declaration.specifiers.map((specifier) => specifier.local.name),
            source: sourceReference(path, node),
          },
        ];
      }) ?? []
    );
  });
}

function parsedBlocks(path: string, text: string, tree: Root): SourceBlock[] {
  const declarations = tree.children.flatMap((node) =>
    node.type !== "mdxjsEsm"
      ? []
      : [...node.value.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((match) => ({
          identifier: match[1] ?? "",
          source: { ...sourceReference(path, node), kind: "data" as const },
          readable: literalText(node.value),
        })),
  );
  return tree.children
    .filter((node) => isWrappedBlock(node) === true)
    .map((node) => {
      const source = sourceReference(path, node);
      const raw = physicalSlice(text, source);
      const block = {
        id: blockId(source),
        kind: node.type,
        readable: readableNode(node),
        raw,
        version: sourceVersion(raw),
        source,
        contributors: [],
      };
      const data = declarations.filter(
        (declaration) => usedAsData(block, declaration.identifier) === true,
      );
      return {
        ...block,
        version: contributingVersion(
          raw,
          data.map((entry) => physicalSlice(text, entry.source)),
        ),
        readable: [block.readable, ...data.map((entry) => entry.readable)]
          .filter((part) => part.length > 0)
          .join("\n"),
        contributors: data.map((entry) => entry.source),
      };
    });
}

function parseSource(path: string, text: string) {
  try {
    const tree = (extname(path) === ".md" ? markdownParser : mdxParser).parse(text);
    return { tree, blocks: parsedBlocks(path, text, tree), imports: documentImports(path, tree) };
  } catch (error) {
    throw new ReaderConfigurationError(
      // Coverage skip: remark throws Error objects; retain a defensive fallback for foreign throws.
      /* v8 ignore next -- @preserve */
      `${path}: cannot parse authored MDX: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Analyzes a saved Markdown page using physical authored-source positions, including frontmatter. */
export function analyzeDocument(
  path: string,
  text: string,
  options: { requireTitle?: boolean } = {},
): ReaderDocument {
  const absolute = resolve(path);
  const parsed = parseSource(absolute, text);
  const frontmatter = parsed.tree.children.find((node) => node.type === "yaml");
  let value: unknown;
  try {
    value = frontmatter !== undefined && "value" in frontmatter ? parseYaml(frontmatter.value) : {};
  } catch (error) {
    throw new ReaderConfigurationError(
      // Coverage skip: YAML throws Error objects; retain a defensive fallback for foreign throws.
      /* v8 ignore next -- @preserve */
      `${absolute}: invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const metadata =
    (options.requireTitle ?? true)
      ? metadataSchema.safeParse(value)
      : optionalMetadataSchema.safeParse(value);
  if (metadata.success === false) {
    throw new ReaderConfigurationError(
      `${absolute}: document frontmatter requires a title and valid metadata: ${metadata.error.message}`,
    );
  }
  const firstHeading = parsed.tree.children.find((node) => node.type === "heading");
  const title =
    metadata.data.title ??
    (firstHeading === undefined ? "" : readableNode(firstHeading).trim()) ??
    basename(absolute, extname(absolute));
  const normalized: DocumentMetadata = {
    title: title.length === 0 ? basename(absolute, extname(absolute)) : title,
    ...(metadata.data.type === undefined ? {} : { type: metadata.data.type }),
    ...(metadata.data.status === undefined ? {} : { status: metadata.data.status }),
    ...(metadata.data.layout === undefined ? {} : { layout: metadata.data.layout }),
    tags: metadata.data.tags ?? [],
  };
  return {
    id: absolute,
    path: absolute,
    relativePath: basename(absolute),
    route: `/${basename(absolute, extname(absolute))}`,
    title: normalized.title,
    metadata: normalized,
    blocks: parsed.blocks,
    imports: parsed.imports,
    searchText: [
      normalized.title,
      normalized.type ?? "",
      normalized.status ?? "",
      ...normalized.tags,
      ...parsed.blocks.map((block) => block.readable),
    ].join("\n"),
    source: text,
  };
}

function documentLink(url: string, path: string, routes: ReadonlyMap<string, string>): string {
  if (url === "" || /^(?:[a-z][a-z\d+.-]*:|[/?#])/i.test(url) === true) return url;
  const suffixAt = url.search(/[?#]/);
  const pathname = suffixAt === -1 ? url : url.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : url.slice(suffixAt);
  try {
    const target = resolve(dirname(path), decodeURIComponent(pathname));
    const route = routes.get(target);
    return route === undefined ? url : `${route}${suffix}`;
  } catch {
    return url;
  }
}

function resolveDocumentLinks(
  node: Root | RootContent,
  path: string,
  routes: ReadonlyMap<string, string>,
) {
  if (node.type === "link" || node.type === "definition") {
    node.url = documentLink(node.url, path, routes);
  }
  if ("children" in node) {
    node.children.forEach((child) => resolveDocumentLinks(child, path, routes));
  }
}

/** Wraps physical source blocks and resolves authored page links against the declared corpus routes. */
export function remarkSourceBlocks(
  options: {
    worktree?: string | ((path: string) => string);
    pages?: readonly Pick<ReaderDocument, "path" | "route">[];
  } = {},
) {
  const routes = new Map((options.pages ?? []).map((page) => [resolve(page.path), page.route]));
  return async (tree: Root, file: { path: string; value?: string | Uint8Array }) => {
    const path = resolve(file.path);
    const contents = await readFile(path, "utf8").catch(() =>
      typeof file.value === "string"
        ? file.value
        : file.value === undefined
          ? ""
          : new TextDecoder().decode(file.value),
    );
    const root =
      options.worktree === undefined
        ? dirname(path)
        : typeof options.worktree === "string"
          ? options.worktree
          : options.worktree(path);
    const analyzed = await contributorsFor(path, contents, root, new Set([path]));
    resolveDocumentLinks(tree, path, routes);
    treeFences(tree);
    tree.children = tree.children.map((node) => {
      if (isWrappedBlock(node) === false) return node;
      const reference = sourceReference(path, node);
      const version =
        analyzed.blocks.find((block) => block.id === blockId(reference))?.version ??
        sourceVersion(physicalSlice(contents, reference));
      const attributes = {
        id: blockId(reference),
        file: path,
        version,
        "data-source-id": blockId(reference),
        "data-source-file": path,
      };
      return {
        type: "mdxJsxFlowElement",
        name: "SourceBlock",
        attributes: Object.entries(attributes).map(([name, value]) => ({
          type: "mdxJsxAttribute",
          name,
          value,
        })),
        children: [node],
      } satisfies MdxJsxFlowElement;
    });
  };
}

/**
 * Lists regular files below a directory; a directory that does not exist yet holds none. The walk
 * passes over the entries a docs walk skips and never enters a folder below `root` that is another
 * source, as `tack check` does.
 */
async function filesUnder(directory: string, root = directory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  if (directory !== root && marksSourceEdge(entries.map((entry) => entry.name)) === true) return [];
  return (
    await Promise.all(
      entries
        .filter((entry) => docsWalkSkips(entry.name) === false)
        .map(async (entry) => {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory() === true) return filesUnder(path, root);
          return entry.isFile() === true ? [path] : [];
        }),
    )
  ).flat();
}

function wholeFile(
  path: string,
  source: string,
  kind: "data" | "fragment" | "implementation",
): SourceReference {
  return {
    path,
    startLine: 1,
    endLine: Math.max(1, source.replace(/\r?\n$/, "").split(/\r?\n/).length),
    kind,
  };
}

async function localImport(path: string, specifier: string, worktree: string) {
  if (specifier === "@tackup/reader") {
    const implementation = readerFile("visuals.tsx");
    return {
      path: implementation,
      source: await readFile(implementation, "utf8"),
      implementationOnly: true,
    };
  }
  if (specifier.startsWith(".") === false) return undefined;
  const candidate = resolve(dirname(path), specifier);
  const possibilities =
    extname(candidate) === ""
      ? [
          candidate,
          ...[".ts", ".tsx", ".js", ".jsx", ".json", ".mdx"].map(
            (extension) => `${candidate}${extension}`,
          ),
          ...[".ts", ".tsx", ".js", ".jsx", ".json", ".mdx"].map((extension) =>
            resolve(candidate, `index${extension}`),
          ),
        ]
      : [candidate];
  for (const possibility of possibilities) {
    try {
      const actual = await realpath(possibility);
      const difference = relative(worktree, actual);
      if (
        difference === ".." ||
        difference.startsWith(`..${sep}`) === true ||
        isAbsolute(difference) === true
      ) {
        throw new ReaderConfigurationError(
          `${path}: imported source ${specifier} resolves outside the selected worktree.`,
        );
      }
      return { path: actual, source: await readFile(actual, "utf8"), implementationOnly: false };
    } catch (error) {
      if (error instanceof ReaderConfigurationError) throw error;
    }
  }
  throw new ReaderConfigurationError(
    `${path}: imported source ${specifier} cannot be read. Install dependencies explicitly or fix the relative import.`,
  );
}

function usedAsData(block: SourceBlock, identifier: string) {
  const occurrences = [
    ...block.raw.matchAll(new RegExp(`\\b${identifier.replace(/[$]/g, "\\$")}\\b`, "g")),
  ];
  return occurrences.some((match) => {
    const prefix = block.raw.slice(0, match.index);
    return /<\/?\s*$/.test(prefix) === false;
  });
}

type DataSource = { path: string; source: string };

function customReadable(path: string, source: string) {
  const match =
    /^[ \t]*export[ \t]+const[ \t]+readerReadable[ \t]*=[ \t]*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)[ \t]*;?[ \t]*$/m.exec(
      source,
    );
  if (match === null) return undefined;
  const literal = match[1] ?? "";
  // Template interpolation is generated content, so it needs an authored literal export instead.
  if (literal.startsWith("`") === true && literal.includes("${") === true) return undefined;
  const startLine = source.slice(0, match.index).split(/\r?\n/).length;
  return {
    readable: literalText(literal),
    raw: match[0],
    source: {
      path,
      startLine,
      endLine: startLine + match[0].split(/\r?\n/).length - 1,
      kind: "data" as const,
    },
  };
}

async function dataSources(
  imported: DataSource,
  worktree: string,
  seen: Set<string>,
): Promise<DataSource[]> {
  if (seen.has(imported.path) === true) return [];
  const visited = new Set([...seen, imported.path]);
  const specifiers = [
    ...imported.source.matchAll(
      /\b(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s+from\s*["']([^"']+)["']/g,
    ),
  ].map((match) => match[1] ?? "");
  const dependencies = await Promise.all(
    specifiers.map(async (specifier) => {
      const source = await localImport(imported.path, specifier, worktree);
      return source === undefined || source.implementationOnly === true
        ? []
        : dataSources(source, worktree, visited);
    }),
  );
  const sources = [imported, ...dependencies.flat()];
  return sources.filter(
    (source, index) => sources.findIndex((entry) => entry.path === source.path) === index,
  );
}

async function contributorsFor(
  path: string,
  source: string,
  worktree: string,
  seen: Set<string>,
): Promise<{ blocks: SourceBlock[]; fragments: SourceBlock[]; readable: string }> {
  const parsed = parseSource(path, source);
  const dependencies = await Promise.all(
    parsed.imports.map(async (entry) => ({
      entry,
      imported: await localImport(path, entry.specifier, worktree),
    })),
  );
  const resolved = await Promise.all(
    dependencies.map(async ({ entry, imported }) => {
      if (imported === undefined || seen.has(imported.path) === true)
        return { entry, imported, fragment: undefined, dataFiles: [], readerReadable: undefined };
      const fragment = [".md", ".mdx"].includes(extname(imported.path))
        ? await contributorsFor(
            imported.path,
            imported.source,
            worktree,
            new Set([...seen, imported.path]),
          )
        : undefined;
      const dataFiles =
        fragment === undefined &&
        imported.implementationOnly === false &&
        parsed.blocks.some(
          (block) => entry.identifiers.some((identifier) => usedAsData(block, identifier)) === true,
        ) === true
          ? await dataSources(imported, worktree, seen)
          : [];
      return {
        entry,
        imported,
        fragment,
        dataFiles,
        readerReadable:
          imported.implementationOnly === true
            ? undefined
            : customReadable(imported.path, imported.source),
      };
    }),
  );
  const blocks = parsed.blocks.map((block) => {
    const data = resolved.filter(
      ({ entry, imported, fragment }) =>
        imported !== undefined &&
        imported.implementationOnly === false &&
        fragment === undefined &&
        entry.identifiers.some((identifier) => usedAsData(block, identifier)) === true,
    );
    const fragments = resolved.flatMap(({ entry, imported, fragment }) =>
      imported !== undefined &&
      fragment !== undefined &&
      entry.identifiers.some((identifier) => new RegExp(`<${identifier}\\b`).test(block.raw)) ===
        true
        ? [{ entry, imported, fragment }]
        : [],
    );
    const customReadables = resolved.flatMap(({ entry, readerReadable }) =>
      readerReadable !== undefined &&
      entry.identifiers.some((identifier) => new RegExp(`<${identifier}\\b`).test(block.raw)) ===
        true
        ? [readerReadable]
        : [],
    );
    return {
      ...block,
      version: contributingVersion(block.raw, [
        ...block.contributors.map((reference) => physicalSlice(source, reference)),
        ...data.flatMap(({ dataFiles }) => dataFiles.map((entry) => entry.source)),
        ...customReadables.map((entry) => entry.raw),
        ...fragments.flatMap(({ imported, fragment }) => [
          imported.source,
          ...fragment.blocks.map((entry) => entry.version),
          ...fragment.fragments.map((entry) => entry.version),
        ]),
      ]),
      contributors: [
        ...block.contributors,
        ...customReadables.map((entry) => entry.source),
        ...data.flatMap(({ dataFiles }) =>
          dataFiles.map((entry) => wholeFile(entry.path, entry.source, "data")),
        ),
        ...fragments.map(({ imported }) => wholeFile(imported.path, imported.source, "fragment")),
      ],
      implementations: resolved.flatMap(({ entry, imported, fragment }) =>
        imported !== undefined &&
        fragment === undefined &&
        entry.identifiers.some((identifier) => new RegExp(`<${identifier}\\b`).test(block.raw)) ===
          true
          ? [wholeFile(imported.path, imported.source, "implementation")]
          : [],
      ),
      readable: [
        block.readable,
        ...customReadables.map((entry) => entry.readable),
        ...data.flatMap(({ dataFiles }) => dataFiles.map((entry) => literalText(entry.source))),
        ...fragments.map(({ fragment }) => fragment.readable),
      ]
        .filter((text) => text.length > 0)
        .join("\n"),
    };
  });
  const fragments = resolved.flatMap(({ entry, fragment }) => {
    if (fragment === undefined) return [];
    const invocations = blocks
      .filter(
        (block) =>
          entry.identifiers.some((identifier) =>
            new RegExp(`<${identifier}\\b`).test(block.raw),
          ) === true,
      )
      .map((block) => block.source);
    return [...fragment.blocks, ...fragment.fragments].map((block) => ({
      ...block,
      contributors: [...block.contributors, ...invocations],
    }));
  });
  return { blocks, fragments, readable: blocks.map((block) => block.readable).join("\n") };
}

function validateVocabulary(document: ReaderDocument, config: ReaderConfig) {
  const invalid = [
    ...(document.metadata.type !== undefined &&
    config.metadata.types.includes(document.metadata.type) === false
      ? [`type '${document.metadata.type}'`]
      : []),
    ...(document.metadata.status !== undefined &&
    config.metadata.statuses.includes(document.metadata.status) === false
      ? [`status '${document.metadata.status}'`]
      : []),
  ];
  if (invalid.length > 0)
    throw new ReaderConfigurationError(
      `${document.path}: undeclared metadata ${invalid.join(", ")}. Extend the metadata vocabularies in ${config.configPath}.`,
    );
}

export type CorpusLoadOptions = {
  extensions?: readonly string[];
  relativeRoot?: string;
  routePrefix?: string;
  resource?: ReaderDocumentResource;
  requireTitle?: boolean;
  validateMetadata?: boolean;
};

/** One selected document that failed to load, with the original error for strict callers. */
export type CorpusDocumentFailure = { path: string; cause: unknown };

/** Every document that loaded, and every selected document that did not. */
export type CorpusLoadReport = {
  documents: ReaderDocument[];
  failures: CorpusDocumentFailure[];
};

async function selectedFiles(config: ReaderConfig, extensions: readonly string[]) {
  const selections = (
    await Promise.all(
      config.content.map(async (entry) => {
        const files = await filesUnder(entry.root);
        const includes = entry.include.map(globMatcher);
        const excludes = entry.exclude.map(globMatcher);
        return files.filter((path) => {
          const name = relative(entry.root, path).split(sep).join("/");
          return (
            extensions.includes(extname(path)) &&
            includes.some((matches) => matches(name)) === true &&
            excludes.some((matches) => matches(name)) === false
          );
        });
      }),
    )
  ).flat();
  return selections
    .filter((path, index) => selections.indexOf(path) === index)
    .sort((left, right) => left.localeCompare(right));
}

async function loadDocument(
  config: ReaderConfig,
  options: CorpusLoadOptions,
  path: string,
): Promise<ReaderDocument> {
  const source = await readFile(path, "utf8");
  const document = analyzeDocument(path, source, {
    ...(options.requireTitle === undefined ? {} : { requireTitle: options.requireTitle }),
  });
  if (options.validateMetadata !== false) validateVocabulary(document, config);
  const contributions = await contributorsFor(path, source, config.worktree, new Set([path]));
  const relativePath = relative(options.relativeRoot ?? config.worktree, path)
    .split(sep)
    .join("/");
  const routePath = relativePath.replace(/\.(?:md|mdx)$/, "");
  return {
    ...document,
    relativePath,
    route: `${options.routePrefix ?? ""}/${routePath}`,
    blocks: [...contributions.blocks, ...contributions.fragments],
    searchText: [document.searchText, contributions.readable].join("\n"),
    ...(options.resource === undefined ? {} : { resource: options.resource }),
  };
}

/**
 * Reads only explicitly included pages and reparses saved pages and local imported data on every
 * call. Each selected document loads on its own, so one bad document is reported without hiding
 * its healthy siblings.
 */
export async function loadCorpusReport(
  config: ReaderConfig,
  options: CorpusLoadOptions = {},
): Promise<CorpusLoadReport> {
  const paths = await selectedFiles(config, options.extensions ?? [".mdx"]);
  const results = await Promise.all(
    paths.map(async (path) => {
      try {
        return { path, document: await loadDocument(config, options, path) };
      } catch (cause) {
        return { path, cause };
      }
    }),
  );
  return {
    documents: results.flatMap((result) => ("document" in result ? [result.document] : [])),
    failures: results.flatMap((result) =>
      "cause" in result ? [{ path: result.path, cause: result.cause }] : [],
    ),
  };
}

/** Loads every selected document or rejects with the first document's original error. */
export async function loadCorpus(
  config: ReaderConfig,
  options: CorpusLoadOptions = {},
): Promise<ReaderDocument[]> {
  const report = await loadCorpusReport(config, options);
  const [first] = report.failures;
  if (first !== undefined) throw first.cause;
  return report.documents;
}

function uniqueReferences(blocks: SourceBlock[], includeImplementations: boolean) {
  const references = blocks.flatMap((block) => [
    block.source,
    ...block.contributors,
    ...(includeImplementations === true ? (block.implementations ?? []) : []),
  ]);
  return references.filter(
    (reference, index) =>
      references.findIndex(
        (candidate) =>
          candidate.path === reference.path &&
          candidate.startLine === reference.startLine &&
          candidate.endLine === reference.endLine,
      ) === index,
  );
}

/** Formats selected authored blocks with saved-file citations and relevant URL interaction state. */
export function formatCopy(input: CopyInput): string {
  const mode = input.mode ?? "readable";
  const references = uniqueReferences(input.blocks, input.includeImplementations === true);
  const citations = references
    .map(
      (reference) =>
        `${reference.path}:${reference.startLine}-${reference.endLine}${reference.kind === undefined ? "" : ` (${reference.kind})`}`,
    )
    .join("\n");
  const content =
    mode === "raw"
      ? input.blocks.map((block) => block.raw).join("\n\n")
      : (input.readable ??
        input.blocks
          .map((block) => block.readable)
          .filter((text) => text.length > 0)
          .join("\n\n"));
  const importedRaw =
    mode === "raw" && input.sources !== undefined
      ? references
          .flatMap((reference) => {
            const source = input.sources?.[reference.path];
            return reference.kind !== undefined && source !== undefined
              ? [`${reference.path}\n${physicalSlice(source, reference)}`]
              : [];
          })
          .join("\n\n")
      : "";
  const state =
    input.state !== undefined && Object.keys(input.state).length > 0
      ? `Interaction state:\n${JSON.stringify(input.state, null, 2)}`
      : "";
  const resources = (input.resources ?? [])
    .filter(
      (resource, index, entries) =>
        entries.findIndex(
          (entry) =>
            entry.sourceRegistrationId === resource.sourceRegistrationId &&
            entry.name === resource.name &&
            entry.sourcePath === resource.sourcePath,
        ) === index,
    )
    .map(
      (resource) => `${resource.name} (${resource.sourceRegistrationId})\n${resource.sourcePath}`,
    )
    .join("\n");
  if (mode === "reference")
    return [resources.length > 0 ? `Docs resources:\n${resources}` : "", citations]
      .filter((part) => part.length > 0)
      .join("\n\n");
  return [
    content,
    importedRaw,
    state,
    resources.length > 0 ? `Docs resources:\n${resources}` : "",
    citations.length > 0 ? `Sources (physical authored lines):\n${citations}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
