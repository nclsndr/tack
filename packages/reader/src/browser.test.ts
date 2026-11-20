import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { collectSelection, sectionIds, filterDocuments, interactionContext } from "./browser.ts";
import type { ReaderDocument } from "./types.ts";

describe("rendered source selection", () => {
  it("collects only contributing leaf blocks across multiple files", () => {
    const dom = new JSDOM(
      '<main><div data-source-id="invoke"><div data-source-id="a" data-source-file="/a.mdx" data-source-version="one"><p>Alpha text</p></div><div data-source-id="b" data-source-file="/fragment.mdx" data-source-version="two"><p>Beta text</p></div></div><div data-source-id="c"><p>Outside</p></div></main>',
    );
    const doc = dom.window.document;
    const range = doc.createRange();
    range.setStart(doc.querySelector("p")!.firstChild!, 2);
    range.setEnd(doc.querySelectorAll("p")[1]!.firstChild!, 4);
    const selection = dom.window.getSelection()!;
    selection.addRange(range);
    expect(collectSelection(selection, doc.querySelector("main")!)).toEqual({
      readable: "pha textBeta",
      blocks: [
        { id: "a", file: "/a.mdx", version: "one" },
        { id: "b", file: "/fragment.mdx", version: "two" },
      ],
    });
  });
  it("rejects empty and outside selections", () => {
    const doc = new JSDOM("<main></main><p>Outside</p>").window.document;
    expect(collectSelection(null, doc.querySelector("main")!)).toBeNull();
    const selection = doc.defaultView!.getSelection()!;
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector("p")!);
    selection.addRange(range);
    expect(collectSelection(selection, doc.querySelector("main")!)).toBeNull();
  });
  it("copies a section until the next peer heading", () => {
    const doc = new JSDOM(
      '<main><div data-source-id="h"><h2>One</h2></div><div data-source-id="p">Text</div><div data-source-id="sub"><h3>Child</h3></div><div data-source-id="child">Child text</div><div data-source-id="next"><h2>Two</h2></div></main>',
    ).window.document;
    expect(sectionIds(doc.querySelector("main")!, "h")).toEqual(["h", "p", "sub", "child"]);
    expect(sectionIds(doc.querySelector("main")!, "p")).toEqual(["p"]);
  });
  it("treats only a direct authored heading as a section boundary", () => {
    const doc = new JSDOM(
      '<main><div data-source-id="h"><h2>One</h2></div><div data-source-id="visual"><figure><h2>Visual title</h2></figure></div><div data-source-id="p">Text</div><div data-source-id="next"><h2>Two</h2></div></main>',
    ).window.document;
    expect(sectionIds(doc.querySelector("main")!, "h")).toEqual(["h", "visual", "p"]);
    expect(sectionIds(doc.querySelector("main")!, "visual")).toEqual(["visual"]);
  });
  it("returns contributing leaves once when a section includes an imported fragment", () => {
    const doc = new JSDOM(
      '<main><div data-source-id="h"><h2>One</h2></div><div data-source-id="invocation"><div data-source-id="fragment-a">Alpha</div><div data-source-id="fragment-b">Beta</div></div><div data-source-id="next"><h2>Two</h2></div></main>',
    ).window.document;
    expect(sectionIds(doc.querySelector("main")!, "h")).toEqual(["h", "fragment-a", "fragment-b"]);
  });
  it("reads declared custom component state and readable exports", () => {
    const doc = new JSDOM(
      '<main><figure data-reader-readable="All six steps" data-reader-state=\'{"step":3}\'></figure></main>',
    ).window.document;
    expect(interactionContext(doc.querySelector("main")!)).toEqual({
      readable: "All six steps",
      state: { step: 3 },
    });
  });
  it("ignores malformed optional custom state", () => {
    const doc = new JSDOM('<main><div data-reader-state="oops"></div></main>').window.document;
    expect(interactionContext(doc.querySelector("main")!).state).toEqual({});
  });
  it("keeps separate visual identities when their state field names overlap", () => {
    const doc = new JSDOM(
      '<main><figure id="diagram" data-reader-readable="Model" data-reader-state=\'{"selected":"source","zoom":1.5}\'></figure><figure id="chart" data-reader-readable="Cost" data-reader-state=\'{"selected":"setup","scale":"sqrt"}\'></figure></main>',
    ).window.document;
    expect(interactionContext(doc.querySelector("main")!)).toEqual({
      readable: "Model\n\nCost",
      state: {
        diagram: { selected: "source", zoom: 1.5 },
        chart: { selected: "setup", scale: "sqrt" },
      },
    });
  });
  it("reads state on the supplied root even without a readable export", () => {
    const doc = new JSDOM('<figure id="custom" data-reader-state=\'{"parameter":2}\'></figure>')
      .window.document;
    expect(interactionContext(doc.querySelector("figure")!)).toEqual({
      readable: "",
      state: { custom: { parameter: 2 } },
    });
  });
  it("does not invent interaction state for a readable-only export", () => {
    const doc = new JSDOM('<figure id="fact" data-reader-readable="Declared fact"></figure>').window
      .document;
    expect(interactionContext(doc.querySelector("figure")!)).toEqual({
      readable: "Declared fact",
      state: {},
    });
  });
  it("ignores non-object optional state while retaining other exports", () => {
    const doc = new JSDOM(
      '<main data-reader-readable="Root"><p data-reader-state="null"></p><p data-reader-state="[]"></p><p data-reader-state="42"></p><p data-reader-state=\'"text"\'></p><p data-reader-readable="Child"></p></main>',
    ).window.document;
    expect(interactionContext(doc.querySelector("main")!)).toEqual({
      readable: "Root\n\nChild",
      state: {},
    });
  });
  it("rejects absent, collapsed and unowned selections", () => {
    const dom = new JSDOM("<main><p>Plain text without a source block</p></main>");
    const root = dom.window.document.querySelector("main")!;
    const selection = dom.window.getSelection()!;
    expect(collectSelection(selection, root)).toBeNull();
    const range = dom.window.document.createRange();
    range.selectNodeContents(root);
    range.collapse(true);
    selection.addRange(range);
    expect(collectSelection(selection, root)).toBeNull();
    selection.removeAllRanges();
    range.selectNodeContents(root);
    selection.addRange(range);
    expect(collectSelection(selection, root)).toBeNull();
  });
  it("handles trailing sections, unknown ids, and missing optional element attributes", () => {
    const dom = new JSDOM(
      '<main><div data-source-id="heading"><h2>Last section</h2></div><div data-source-id="text">Unversioned</div></main>',
    );
    const root = dom.window.document.querySelector("main")!;
    expect(sectionIds(root, "heading")).toEqual(["heading", "text"]);
    expect(sectionIds(root, "missing")).toEqual([]);
    const range = dom.window.document.createRange();
    range.selectNodeContents(root.querySelector('[data-source-id="text"]')!);
    const selection = dom.window.getSelection()!;
    selection.addRange(range);
    expect(collectSelection(selection, root)?.blocks).toEqual([
      { id: "text", file: "", version: "" },
    ]);
  });
});

describe("reader views", () => {
  const documents: ReaderDocument[] = [
    {
      id: "walkthrough",
      path: "/repo/docs/guides/walkthrough.mdx",
      relativePath: "docs/guides/walkthrough.mdx",
      route: "/walkthrough",
      blocks: [],
      imports: [],
      source: "",
      title: "Link a review skill",
      searchText: "hidden final step status",
      metadata: {
        title: "Link a review skill",
        type: "walkthrough",
        status: "draft",
        tags: ["skills"],
      },
    },
    {
      id: "note",
      path: "/repo/note.mdx",
      relativePath: "note.mdx",
      route: "/note",
      blocks: [],
      imports: [],
      source: "",
      title: "Cost",
      searchText: "shared setup",
      metadata: { title: "Cost", type: "note", status: "done", tags: ["cost"] },
    },
  ];
  it.each([
    "walkthrough.mdx",
    "guides/walkthrough.mdx",
    "docs/guides/walkthrough.mdx",
    "./docs/guides/walkthrough.mdx",
    "/repo/docs/guides/walkthrough.mdx",
    "  /REPO/DOCS/GUIDES/WALKTHROUGH.MDX  ",
  ])("finds a document by its filename or path: %s", (query) => {
    expect(filterDocuments(documents, { query, type: "", status: "", tag: "" })).toEqual([
      documents[0],
    ]);
  });
  it("combines path terms with content and metadata filters", () => {
    const filters = {
      query: "./docs/guides/walkthrough.mdx hidden status",
      type: "walkthrough",
      status: "draft",
      tag: "skills",
    };
    expect(filterDocuments(documents, filters)).toEqual([documents[0]]);
    expect(filterDocuments(documents, { ...filters, type: "note" })).toEqual([]);
    expect(filterDocuments(documents, { ...filters, status: "done" })).toEqual([]);
    expect(filterDocuments(documents, { ...filters, tag: "cost" })).toEqual([]);
    expect(
      filterDocuments(documents, { ...filters, query: "docs/guides/walkthrough.mdx missing" }),
    ).toEqual([]);
  });
  it("distinguishes identical filenames by their folder and absolute worktree path", () => {
    const archived = {
      ...documents[0]!,
      id: "archived",
      path: "/repo/docs/archive/walkthrough.mdx",
      relativePath: "docs/archive/walkthrough.mdx",
      route: "/archived",
    };
    const corpus = [...documents, archived];
    expect(
      filterDocuments(corpus, {
        query: "docs/guides/walkthrough.mdx",
        type: "",
        status: "",
        tag: "",
      }),
    ).toEqual([documents[0]]);
    expect(
      filterDocuments(corpus, { query: "walkthrough.mdx", type: "", status: "", tag: "" }),
    ).toEqual([documents[0], archived]);
    expect(
      filterDocuments(corpus, {
        query: "/other/docs/guides/walkthrough.mdx",
        type: "",
        status: "",
        tag: "",
      }),
    ).toEqual([]);
  });
  it("searches authored content and intersects metadata filters", () => {
    expect(
      filterDocuments(documents, {
        query: "hidden status",
        type: "walkthrough",
        status: "draft",
        tag: "skills",
      }),
    ).toEqual([documents[0]]);
    expect(
      filterDocuments(documents, { query: "hidden", type: "note", status: "", tag: "" }),
    ).toEqual([]);
    expect(
      filterDocuments(documents, { query: "", type: "", status: "done", tag: "cost" }),
    ).toEqual([documents[1]]);
    expect(
      filterDocuments(documents, { query: "   SHARED   SETUP  ", type: "", status: "", tag: "" }),
    ).toEqual([documents[1]]);
    expect(
      filterDocuments([{ ...documents[0]!, metadata: { title: "No vocabulary", tags: [] } }], {
        query: "No vocabulary",
        type: "",
        status: "",
        tag: "",
      }),
    ).toEqual([]);
    expect(
      filterDocuments(documents, { query: "", type: "", status: "draft", tag: "cost" }),
    ).toEqual([]);
  });
});
