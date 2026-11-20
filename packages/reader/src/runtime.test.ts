import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const route = vi.hoisted(() => ({ pathname: "/page" }));
vi.mock("@rspress/core/runtime", () => ({
  Content: () => createElement("p", null, "MDX content"),
  useLocation: () => ({ pathname: route.pathname }),
  useNavigate: () => () => undefined,
  useNavigationType: () => "POP",
  NavigationType: { Pop: "POP", Push: "PUSH", Replace: "REPLACE" },
  pathnameToRouteService: () => undefined,
}));
import { ReaderLayout, SourceBlock, type ReaderBoot } from "./runtime.tsx";
const document = {
  id: "/repo/page.mdx",
  path: "/repo/page.mdx",
  relativePath: "page.mdx",
  route: "/page",
  title: "First reader",
  metadata: { title: "First reader", tags: [] },
  blocks: [],
  imports: [],
  searchText: "",
  source: "",
};
const boot: ReaderBoot = {
  worktree: "/repo",
  project: { name: "repo" },
  resources: [],
  checkout: null,
  documents: [document],
  revision: "one",
  token: "test",
  metadata: { types: [], statuses: [], tags: [] },
  presets: { navigation: "folders", layouts: "reader", components: "standard" },
  archive: [],
};
beforeEach(() => {
  route.pathname = "/page";
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("reader layout", () => {
  it("renders folder navigation, outline, search filters and source copy controls", () => {
    const html = renderToStaticMarkup(createElement(ReaderLayout, { boot, customization: {} }));
    expect(html).toContain("First reader");
    expect(html).toContain("Search documents");
    expect(html).toContain("Contents");
    expect(html).toContain("Copy selection");
    expect(html).toContain("Open in editor");
  });
  it("uses repository navigation and document layouts", () => {
    const html = renderToStaticMarkup(
      createElement(ReaderLayout, {
        boot: {
          ...boot,
          documents: [{ ...document, metadata: { ...document.metadata, layout: "focus" } }],
        },
        customization: {
          Navigation: ({ children }) => createElement("nav", { "data-repo": "nav" }, children),
          layouts: {
            focus: ({ children }) => createElement("section", { "data-repo": "layout" }, children),
          },
        },
      }),
    );
    expect(html).toContain('data-repo="nav"');
    expect(html).toContain('data-repo="layout"');
  });
  it("keeps source-qualified resources distinct and selects only the current source customization", () => {
    route.pathname = "/alpha";
    const alpha = {
      ...document,
      id: "/alpha/readme.md",
      route: "/alpha",
      title: "Readme",
      resource: {
        sourceRegistrationId: "alpha",

        name: "docs",
        sourcePath: "/sources/alpha",
      },
    };
    const beta = {
      ...alpha,
      id: "/beta/readme.md",
      route: "/beta",
      resource: { ...alpha.resource, sourceRegistrationId: "beta", sourcePath: "/sources/beta" },
    };
    const html = renderToStaticMarkup(
      createElement(ReaderLayout, {
        boot: { ...boot, documents: [alpha, beta] },
        customization: {
          customizations: {
            "alpha:docs": {
              Navigation: ({ children }) =>
                createElement("div", { "data-alpha-nav": true }, children),
            },
            "beta:docs": {
              Navigation: ({ children }) =>
                createElement("div", { "data-beta-nav": true }, children),
            },
          },
        },
      }),
    );
    expect(html).toContain("alpha / docs");
    expect(html).toContain("beta / docs");
    expect(html).toContain('data-alpha-nav="true"');
    expect(html).not.toContain('data-beta-nav="true"');
  });
  it("shows an unavailable resource beside healthy documents", () => {
    const html = renderToStaticMarkup(
      createElement(ReaderLayout, {
        boot: {
          ...boot,
          issues: [
            {
              resource: { sourceRegistrationId: "broken", name: "notes" },
              sourcePath: "/sources/broken",
              code: "resource-load",
              message: "Reader configuration failed.",
            },
          ],
        },
        customization: {},
      }),
    );
    expect(html).not.toContain("Some documentation is unavailable.");
    expect(html).toContain("1 resource unavailable");
    expect(html).toContain("First reader");
  });
  it("wraps semantic blocks with physical source identifiers and versions", () => {
    expect(
      renderToStaticMarkup(
        createElement(
          SourceBlock,
          { id: "block", file: "/repo/page.mdx", version: "v" },
          "Authored text",
        ),
      ),
    ).toContain('data-source-version="v"');
  });
  it("uses the generated repository boot when no explicit boot prop is supplied", () => {
    vi.stubGlobal("tackReaderBoot", boot);
    expect(renderToStaticMarkup(createElement(ReaderLayout, { customization: {} }))).toContain(
      "First reader",
    );
  });
  it("opens the first declared page at the root route and handles missing routes", () => {
    route.pathname = "/";
    const root = renderToStaticMarkup(createElement(ReaderLayout, { boot, customization: {} }));
    expect(root).toContain("MDX content");
    expect(root).not.toContain("No declared documents");
    route.pathname = "/missing";
    expect(
      renderToStaticMarkup(createElement(ReaderLayout, { boot, customization: {} })),
    ).toContain("Choose an available document");
    route.pathname = "/docs/00000000-0000-4000-8000-000000000000/shared/handbook/page";
    expect(
      renderToStaticMarkup(createElement(ReaderLayout, { boot, customization: {} })),
    ).toContain("Docs route not found");
    route.pathname = "/";
    expect(
      renderToStaticMarkup(
        createElement(ReaderLayout, { boot: { ...boot, documents: [] }, customization: {} }),
      ),
    ).toMatch(/class="tack-file-count[^"]*">0<\/span>/);
    expect(
      renderToStaticMarkup(
        createElement(ReaderLayout, { boot: { ...boot, documents: [] }, customization: {} }),
      ),
    ).toContain("No declared documents");
  });
  it("does not inject folder navigation when a repository selects module-only navigation", () => {
    const html = renderToStaticMarkup(
      createElement(ReaderLayout, {
        boot: { ...boot, presets: {} },
        customization: {
          Navigation: ({ children }) => createElement("div", { "data-module-nav": true }, children),
        },
      }),
    );
    expect(html).toContain('data-module-nav="true"');
    expect(html).toContain('<div data-module-nav="true"></div>');
    expect(html).not.toContain('href="/page"');
  });
  it("applies a repository default layout when the document does not name one", () => {
    const html = renderToStaticMarkup(
      createElement(ReaderLayout, {
        boot,
        customization: {
          layouts: {
            default: ({ children }) =>
              createElement("section", { "data-default-layout": true }, children),
          },
        },
      }),
    );
    expect(html).toContain('data-default-layout="true"');
  });
});
