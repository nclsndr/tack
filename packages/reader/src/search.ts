import type { ReaderDocument, SourceBlock } from "./types.ts";
export { resourceIdentity } from "./resource.ts";

export type {
  DocsResourceReference,
  ReaderConfig,
  ReaderDocument,
  ReaderDocumentResource,
  ReaderProjectInput,
  ReaderResource,
  ReaderResourceIssue,
} from "./types.ts";

export const defaultSearchLimit = 10;
export const maximumSearchLimit = 50;
export const maximumSearchQueryLength = 512;

export type ViewFilters = { query: string; type: string; status: string; tag: string };
export type ReaderSearchQuery = {
  query: string;
  type?: string;
  status?: string;
  tag?: string;
  limit?: number;
};
export type ReaderSearchMatch = Pick<SourceBlock, "id" | "version" | "source" | "contributors"> & {
  excerpt: string;
};
export type ReaderSearchHit = {
  document: Pick<
    ReaderDocument,
    "path" | "relativePath" | "title" | "route" | "metadata" | "resource"
  >;
  score: number;
  matches: ReaderSearchMatch[];
};
export type ReaderSearchResult = {
  query: string;
  limit: number;
  total: number;
  truncated: boolean;
  hits: ReaderSearchHit[];
};

function searchTerms(query: string) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^\.\//, ""))
    .filter((term) => term.length > 0);
}

/** Searches text and file paths with AND terms, optional ./ prefixes, and exact metadata filters. */
export function filterDocuments(
  documents: ReaderDocument[],
  filters: ViewFilters,
): ReaderDocument[] {
  const terms = searchTerms(filters.query);
  return documents.filter((document) => {
    const text =
      `${document.title} ${document.path} ${document.relativePath} ${document.searchText} ${document.metadata.type ?? ""} ${document.metadata.status ?? ""} ${document.metadata.tags.join(" ")} ${document.resource?.sourceRegistrationId ?? ""} ${document.resource?.name ?? ""} ${document.resource?.sourcePath ?? ""}`.toLowerCase();
    return (
      terms.every((term) => text.includes(term)) &&
      (filters.type === "" || document.metadata.type === filters.type) &&
      (filters.status === "" || document.metadata.status === filters.status) &&
      (filters.tag === "" || document.metadata.tags.includes(filters.tag))
    );
  });
}

function uniqueBlocks(blocks: SourceBlock[]) {
  return blocks
    .filter(
      (block, index) =>
        blocks.findIndex((other) => other.id === block.id && other.version === block.version) ===
        index,
    )
    .map((block) => {
      const contributors = blocks
        .filter((other) => other.id === block.id && other.version === block.version)
        .flatMap((other) => other.contributors);
      return {
        ...block,
        contributors: contributors.filter(
          (reference, index) =>
            contributors.findIndex(
              (other) =>
                other.path === reference.path &&
                other.startLine === reference.startLine &&
                other.endLine === reference.endLine &&
                other.kind === reference.kind,
            ) === index,
        ),
      };
    });
}

function blockScore(block: SourceBlock, terms: string[]) {
  const text = block.readable.toLowerCase();
  return terms.filter((term) => text.includes(term)).length * (block.kind === "heading" ? 20 : 1);
}

function documentScore(document: ReaderDocument, terms: string[]) {
  const title = document.title.toLowerCase();
  const headings = document.blocks
    .filter((block) => block.kind === "heading")
    .map((block) => block.readable.toLowerCase());
  const body = document.blocks
    .filter((block) => block.kind !== "heading")
    .map((block) => block.readable.toLowerCase());
  return terms.reduce(
    (score, term) =>
      score +
      (title.includes(term) === true ? 100 : 0) +
      (headings.some((text) => text.includes(term)) === true ? 20 : 0) +
      (body.some((text) => text.includes(term)) === true ? 1 : 0),
    0,
  );
}

/** Lowercasing can expand Unicode characters, so normalized offsets need physical text mapping. */
function sourceOffset(text: string, normalizedOffset: number) {
  let offset = 0;
  let normalized = 0;
  for (const character of text) {
    normalized += character.toLowerCase().length;
    if (normalized > normalizedOffset) return offset;
    offset += character.length;
  }
  // Coverage skip: callers supply an existing match offset, so iteration always returns above.
  /* v8 ignore next -- @preserve */
  return offset;
}

function excerpt(text: string, terms: string[]) {
  if (text.length <= 400) return text;
  const normalized = text.toLowerCase();
  const firstMatch = Math.min(
    ...terms.map((term) => normalized.indexOf(term)).filter((index) => index >= 0),
  );
  const position = sourceOffset(text, firstMatch);
  const start = Math.max(0, Math.min(position - 80, text.length - 398));
  const end = start + 398;
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function searchHit(document: ReaderDocument, terms: string[]): ReaderSearchHit {
  return {
    document: {
      path: document.path,
      relativePath: document.relativePath,
      title: document.title,
      route: document.route,
      metadata: document.metadata,
      ...(document.resource === undefined ? {} : { resource: document.resource }),
    },
    score: documentScore(document, terms),
    matches: uniqueBlocks(document.blocks)
      .map((block, index) => ({ block, index, score: blockScore(block, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 3)
      .map(({ block }) => ({
        id: block.id,
        version: block.version,
        source: block.source,
        contributors: block.contributors,
        excerpt: excerpt(block.readable, terms),
      })),
  };
}

/**
 * Ranks matching saved documents by title, heading, then body term presence.
 * Returns bounded excerpts with physical citations; metadata-only hits have no block matches.
 */
export function searchDocuments(
  documents: ReaderDocument[],
  request: ReaderSearchQuery,
): ReaderSearchResult {
  if (
    typeof request.query !== "string" ||
    request.query.trim().length === 0 ||
    request.query.trim().length > maximumSearchQueryLength
  ) {
    throw new Error(
      `Reader search query must contain 1–${maximumSearchQueryLength} characters after trimming.`,
    );
  }
  const limit = request.limit ?? defaultSearchLimit;
  if (Number.isInteger(limit) === false || limit < 1 || limit > maximumSearchLimit) {
    throw new Error(`Reader search limit must be an integer from 1–${maximumSearchLimit}.`);
  }
  const query = request.query.trim();
  const terms = searchTerms(query);
  const hits = filterDocuments(documents, {
    query,
    type: request.type ?? "",
    status: request.status ?? "",
    tag: request.tag ?? "",
  })
    .map((document) => searchHit(document, terms))
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.document.relativePath < right.document.relativePath
          ? -1
          : left.document.relativePath > right.document.relativePath
            ? 1
            : `${left.document.resource?.sourceRegistrationId ?? ""}/${left.document.resource?.name ?? ""}`.localeCompare(
                `${right.document.resource?.sourceRegistrationId ?? ""}/${right.document.resource?.name ?? ""}`,
              )),
    );
  return {
    query,
    limit,
    total: hits.length,
    truncated: hits.length > limit,
    hits: hits.slice(0, limit),
  };
}
