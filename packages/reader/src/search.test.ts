import { describe, expect, it } from "vitest";
import { filterDocuments as browserFilterDocuments } from "./browser.ts";
import {
  defaultSearchLimit,
  filterDocuments,
  maximumSearchLimit,
  maximumSearchQueryLength,
  searchDocuments,
} from "./search.ts";
import type { ReaderDocument, SourceBlock } from "./types.ts";

function block(readable: string, overrides: Partial<SourceBlock> = {}): SourceBlock {
  return {
    id: "/repo/page.mdx:6:8",
    version: "saved-version",
    kind: "paragraph",
    readable,
    raw: "PRIVATE RAW SOURCE",
    source: { path: "/repo/page.mdx", startLine: 6, endLine: 8 },
    contributors: [],
    ...overrides,
  };
}

function document(overrides: Partial<ReaderDocument> = {}): ReaderDocument {
  const blocks = overrides.blocks ?? [block("Configure the reader source")];
  return {
    id: "page",
    path: "/repo/page.mdx",
    relativePath: "page.mdx",
    route: "/page",
    title: "Reader guide",
    metadata: { title: "Reader guide", type: "reference", status: "draft", tags: ["setup"] },
    imports: [],
    source: "PRIVATE FULL DOCUMENT",
    searchText: blocks.map((entry) => entry.readable).join("\n"),
    ...overrides,
    blocks,
  };
}

describe("shared reader search", () => {
  it("shares filename, relative and absolute path matching with browser filters", () => {
    const guide = document({
      path: "/repo/docs/guides/page.mdx",
      relativePath: "docs/guides/page.mdx",
    });
    const archived = document({
      path: "/repo/docs/archive/page.mdx",
      relativePath: "docs/archive/page.mdx",
    });
    const documents = [guide, archived];
    for (const [query, expected] of [
      ["page.mdx", [guide.path, archived.path]],
      ["guides/page.mdx", [guide.path]],
      ["docs/guides/page.mdx", [guide.path]],
      ["./docs/guides/page.mdx", [guide.path]],
      ["  /REPO/DOCS/GUIDES/PAGE.MDX  ", [guide.path]],
      ["/other/docs/guides/page.mdx", []],
      ["./docs/guides/page.mdx SOURCE reference draft setup", [guide.path]],
      ["./docs/guides/page.mdx absent", []],
    ] as const) {
      const filters = { query, type: "reference", status: "draft", tag: "setup" };
      expect(
        browserFilterDocuments(documents, filters)
          .map((entry) => entry.path)
          .sort(),
      ).toEqual([...expected].sort());
      expect(
        searchDocuments(documents, filters)
          .hits.map((hit) => hit.document.path)
          .sort(),
      ).toEqual([...expected].sort());
    }
    const pathOnly = searchDocuments(documents, { query: "./docs/guides/page.mdx" });
    expect(pathOnly.hits[0]).toMatchObject({ score: 0, matches: [] });
    expect(
      searchDocuments(documents, { query: "./docs/guides/page.mdx source" }).hits[0]!.matches,
    ).toHaveLength(1);
  });

  it("shares browser matching with case-insensitive whitespace AND terms across fields", () => {
    const documents = [document(), document({ title: "Other", searchText: "irrelevant" })];
    const filters = { query: "  READER\tSOURCE \n", type: "", status: "", tag: "" };
    expect(browserFilterDocuments).toBe(filterDocuments);
    expect(filterDocuments(documents, filters)).toEqual([documents[0]]);
    expect(searchDocuments(documents, filters).hits.map((hit) => hit.document.path)).toEqual(
      filterDocuments(documents, filters).map((entry) => entry.path),
    );
    expect(searchDocuments(documents, { query: "reader absent" }).total).toBe(0);
    expect(filterDocuments(documents, { ...filters, query: " \t" })).toEqual(documents);
  });

  it("names the docs resource of a hit that has one", () => {
    const resource = { sourceRegistrationId: "team", name: "guides", sourcePath: "/repo" };
    const [hit] = searchDocuments([document({ resource })], { query: "reader" }).hits;
    expect(hit?.document.resource).toEqual(resource);
  });

  it("intersects exact metadata filters and admits metadata-only hits without source claims", () => {
    const entry = document({ blocks: [], searchText: "" });
    expect(
      searchDocuments([entry], {
        query: "reference draft setup",
        type: "reference",
        status: "draft",
        tag: "setup",
      }),
    ).toEqual({
      query: "reference draft setup",
      limit: 10,
      total: 1,
      truncated: false,
      hits: [
        {
          document: {
            path: entry.path,
            relativePath: entry.relativePath,
            title: entry.title,
            route: entry.route,
            metadata: entry.metadata,
          },
          score: 0,
          matches: [],
        },
      ],
    });
    for (const filter of [{ type: "Reference" }, { status: "done" }, { tag: "set" }]) {
      expect(searchDocuments([entry], { query: "reader", ...filter }).total).toBe(0);
    }
    expect(
      searchDocuments([document({ metadata: { title: "Reader guide", tags: [] } })], {
        query: "reader",
      }).total,
    ).toBe(1);
  });

  it("ranks title matches above headings above body, with code-unit path ties", () => {
    const documents = [
      document({ title: "Other", relativePath: "z.mdx", blocks: [block("needle")] }),
      document({ title: "Other", relativePath: "ä.mdx", blocks: [block("needle")] }),
      document({
        title: "Other",
        relativePath: "a.mdx",
        blocks: [block("needle", { kind: "heading" })],
      }),
      document({ title: "Needle", relativePath: "title.mdx", blocks: [] }),
      document({ title: "Other", relativePath: "Z.mdx", blocks: [block("needle")] }),
    ];
    const result = searchDocuments(documents, { query: "needle" });
    expect(result.hits.map((hit) => hit.document.relativePath)).toEqual([
      "title.mdx",
      "a.mdx",
      "Z.mdx",
      "z.mdx",
      "ä.mdx",
    ]);
    expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score);
    expect(result.hits[1]!.score).toBeGreaterThan(result.hits[2]!.score);
    expect(searchDocuments([...documents].reverse(), { query: "needle" })).toEqual(result);
    expect(searchDocuments([documents[0]!, documents[0]!], { query: "needle" }).total).toBe(2);
  });

  it("counts documents before limiting and accepts the inclusive limit bounds", () => {
    const documents = Array.from({ length: 51 }, (_, index) =>
      document({ relativePath: `${index}.mdx` }),
    );
    expect(defaultSearchLimit).toBe(10);
    expect(maximumSearchLimit).toBe(50);
    expect(maximumSearchQueryLength).toBe(512);
    const result = searchDocuments(documents, { query: "  reader  ", limit: 1 });
    expect(result).toMatchObject({ query: "reader", limit: 1, total: 51, truncated: true });
    expect(result.hits).toHaveLength(1);
    expect(searchDocuments(documents, { query: "reader" }).hits).toHaveLength(10);
    expect(searchDocuments(documents, { query: "reader", limit: 50 }).hits).toHaveLength(50);
    expect(searchDocuments([], { query: "reader" })).toEqual({
      query: "reader",
      limit: 10,
      total: 0,
      truncated: false,
      hits: [],
    });
    expect(searchDocuments([document()], { query: "reader", limit: 1 }).truncated).toBe(false);
    expect(
      searchDocuments([document({ title: "x".repeat(512) })], { query: "x".repeat(512) }).total,
    ).toBe(1);
  });

  it("rejects invalid programmatic query and limit bounds clearly", () => {
    for (const query of ["", " \n\t", "x".repeat(513)]) {
      expect(() => searchDocuments([], { query })).toThrow(/query.*1.*512/i);
    }
    for (const limit of [0, -1, 51, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => searchDocuments([], { query: "reader", limit })).toThrow(
        /limit.*integer.*1.*50/i,
      );
    }
  });

  it("treats punctuation literally and uses locale-independent Unicode lowercase", () => {
    const documents = [document({ blocks: [block("ÉTÉ [a+b] Привет İSTANBUL")] })];
    expect(searchDocuments(documents, { query: "été [A+B] привет i̇stanbul" }).total).toBe(1);
    expect(searchDocuments(documents, { query: ".*" }).total).toBe(0);
    expect(searchDocuments(documents, { query: "[a+b] missing" }).total).toBe(0);
  });

  it("returns at most three distinct authored blocks with saved identities and contributor citations", () => {
    const first = block("needle from imported data", {
      contributors: [{ path: "/repo/data.ts", startLine: 2, endLine: 5, kind: "data" }],
    });
    const fragment = block("needle in fragment", {
      id: "fragment",
      source: { path: "/repo/fragment.mdx", startLine: 3, endLine: 3 },
      contributors: [{ path: "/repo/page.mdx", startLine: 9, endLine: 9 }],
    });
    const entry = document({
      blocks: [
        first,
        first,
        fragment,
        block("needle third", { id: "third" }),
        block("needle fourth", { id: "fourth" }),
      ],
    });
    const matches = searchDocuments([entry], { query: "needle" }).hits[0]!.matches;
    expect(matches).toEqual(
      [first, fragment, entry.blocks[3]!].map(
        ({ id, version, source, contributors, readable }) => ({
          id,
          version,
          source,
          contributors,
          excerpt: readable,
        }),
      ),
    );
    expect(JSON.stringify(searchDocuments([entry], { query: "needle" }))).not.toContain("PRIVATE");
    expect(entry.blocks).toHaveLength(5);
  });

  it("finds matching blocks for terms split across a document and prefers matching headings", () => {
    const entry = document({
      title: "Alpha",
      blocks: [
        block("beta body"),
        block("beta heading", { id: "heading", kind: "heading" }),
        block("unrelated", { id: "other" }),
      ],
    });
    expect(
      searchDocuments([entry], { query: "alpha beta" }).hits[0]!.matches.map((match) => match.id),
    ).toEqual(["heading", "/repo/page.mdx:6:8"]);
  });

  it("merges contributor citations when overlapping fragments share the same saved block", () => {
    const first = block("needle", {
      contributors: [{ path: "/repo/one.mdx", startLine: 2, endLine: 2 }],
    });
    const second = {
      ...first,
      contributors: [first.contributors[0]!, { path: "/repo/two.mdx", startLine: 4, endLine: 4 }],
    };
    const result = searchDocuments([document({ blocks: [first, second] })], { query: "needle" });
    expect(result.hits[0]!.matches).toHaveLength(1);
    expect(result.hits[0]!.matches[0]!.contributors).toEqual(second.contributors);
    expect(first.contributors).toHaveLength(1);
  });

  it("windows bounded excerpts around the first literal match, including Unicode expansion", () => {
    const texts = [
      "needle " + "x".repeat(700),
      "x".repeat(700) + " needle",
      "x".repeat(500) + " needle " + "y".repeat(500),
      "İ".repeat(700) + " needle " + "y".repeat(500),
    ];
    for (const text of texts) {
      const excerpt = searchDocuments([document({ blocks: [block(text)] })], { query: "needle" })
        .hits[0]!.matches[0]!.excerpt;
      expect(excerpt.length).toBeLessThanOrEqual(400);
      expect(excerpt).toContain("needle");
    }
    expect(
      searchDocuments([document({ blocks: [block("short needle")] })], { query: "needle" }).hits[0]!
        .matches[0]!.excerpt,
    ).toBe("short needle");
  });
});
