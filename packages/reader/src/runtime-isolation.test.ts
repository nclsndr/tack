// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReaderLayout, type ReaderBoot, type ReaderCustomization } from "./runtime.tsx";
const route = vi.hoisted(() => ({ pathname: "/broken", failContent: false }));
vi.mock("@rspress/core/runtime", () => ({
  Content: () => {
    if (route.failContent === true) throw new Error("MDX render failed");
    return createElement("p", null, "Rendered document");
  },
  useLocation: () => ({ pathname: route.pathname }),
  useNavigate: () => () => undefined,
  useNavigationType: () => "POP",
  NavigationType: { Pop: "POP", Push: "PUSH", Replace: "REPLACE" },
  pathnameToRouteService: () => undefined,
}));
const boot: ReaderBoot = {
  worktree: "/project",
  project: { name: "project" },
  resources: [],
  checkout: null,
  revision: "one",
  token: "test",
  archive: [],
  metadata: { types: [], statuses: [], tags: [] },
  presets: { navigation: "folders" },
  documents: ["broken", "healthy"].map((name) => ({
    id: `/source/${name}/page.md`,
    path: `/source/${name}/page.md`,
    relativePath: "page.md",
    route: `/${name}`,
    title: name,
    metadata: { title: name, tags: [] },
    blocks: [],
    imports: [],
    searchText: "",
    source: "# Page",
    resource: {
      sourceRegistrationId: name,
      sourcePath: `/source/${name}`,

      name: "docs",
    },
  })),
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  route.pathname = "/broken";
  route.failContent = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = async (customization: ReaderCustomization = {}, revision = "one") => {
  await act(async () =>
    root.render(createElement(ReaderLayout, { boot: { ...boot, revision }, customization })),
  );
};
const fail = () => {
  throw new Error("Source presentation failed");
};
it("falls back to project navigation after a source navigation render throws", async () => {
  await render({ customizations: { "broken:docs": { Navigation: fail } } });
  expect(container.querySelector('nav[aria-label="Folders"] a[href="/healthy"]')).not.toBeNull();
  expect(container.textContent).toContain("Source presentation failed");
  expect(container.textContent).toContain("Rendered document");
});
it("keeps the shell after layout failure and recovers on healthy resource selection", async () => {
  const customization = {
    customizations: { "broken:docs": { layouts: { default: fail } } },
  };
  await render(customization);
  expect(container.textContent).toContain("broken / docs");
  expect(container.querySelector('[aria-label="Search documents"]')).not.toBeNull();
  expect(container.textContent).toContain("Source presentation failed");
  route.pathname = "/healthy";
  await render(customization);
  expect(container.textContent).toContain("Rendered document");
  expect(container.textContent).not.toContain("Source presentation failed");
});
it("isolates MDX rendering and retries the resource after a new saved revision", async () => {
  route.failContent = true;
  await render();
  expect(container.textContent).toContain("MDX render failed");
  expect(container.querySelector('nav[aria-label="Folders"] a[href="/healthy"]')).not.toBeNull();
  route.failContent = false;
  await render({}, "two");
  expect(container.textContent).toContain("Rendered document");
});
it("keeps pending and rejected source modules out of the document render", async () => {
  route.failContent = true;
  await render({ pendingResources: ["broken:docs"] });
  expect(container.textContent).toContain("Loading source presentation");
  expect(container.textContent).not.toContain("MDX render failed");
  await render({ resourceErrors: { "broken:docs": "Source module failed to initialize" } });
  expect(container.textContent).toContain("Source module failed to initialize");
  expect(container.querySelector('nav[aria-label="Folders"] a[href="/healthy"]')).not.toBeNull();
  route.pathname = "/healthy";
  route.failContent = false;
  await render({ resourceErrors: { "broken:docs": "Source module failed to initialize" } });
  expect(container.textContent).toContain("Rendered document");
});
it("names a thrown non-error value from a source layout in the presentation error", async () => {
  await render({
    customizations: {
      "broken:docs": {
        layouts: {
          default: () => {
            // oxlint-disable-next-line no-throw-literal -- A source module may throw any value, not only an Error.
            throw "layout exploded";
          },
        },
      },
    },
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("layout exploded");
  expect(container.querySelector('[aria-label="Search documents"]')).not.toBeNull();
});
