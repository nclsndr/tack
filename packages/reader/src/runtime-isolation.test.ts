// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReaderLayout, type ReaderBoot, type ReaderCustomization } from "./runtime.tsx";
import { testRoot } from "./react.test-support.ts";
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
const ui = testRoot();
// Silences the error boundary's reports on the console as it was before testRoot wraps it, so the
// wrapper still fails a test on an update outside act.
const original = console;
beforeEach(() => {
  route.pathname = "/broken";
  route.failContent = false;
  vi.spyOn(original, "error").mockImplementation(() => undefined);
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});
const render = async (customization: ReaderCustomization = {}, revision = "one") => {
  await ui.render(createElement(ReaderLayout, { boot: { ...boot, revision }, customization }));
};
const fail = () => {
  throw new Error("Source presentation failed");
};
it("falls back to project navigation after a source navigation render throws", async () => {
  await render({ customizations: { "broken:docs": { Navigation: fail } } });
  expect(ui.container.querySelector('nav[aria-label="Folders"] a[href="/healthy"]')).not.toBeNull();
  expect(ui.container.textContent).toContain("Source presentation failed");
  expect(ui.container.textContent).toContain("Rendered document");
});
it("keeps the shell after layout failure and recovers on healthy resource selection", async () => {
  const customization = {
    customizations: { "broken:docs": { layouts: { default: fail } } },
  };
  await render(customization);
  expect(ui.container.textContent).toContain("broken / docs");
  expect(ui.container.querySelector('[aria-label="Search documents"]')).not.toBeNull();
  expect(ui.container.textContent).toContain("Source presentation failed");
  route.pathname = "/healthy";
  await render(customization);
  expect(ui.container.textContent).toContain("Rendered document");
  expect(ui.container.textContent).not.toContain("Source presentation failed");
});
it("isolates MDX rendering and retries the resource after a new saved revision", async () => {
  route.failContent = true;
  await render();
  expect(ui.container.textContent).toContain("MDX render failed");
  expect(ui.container.querySelector('nav[aria-label="Folders"] a[href="/healthy"]')).not.toBeNull();
  route.failContent = false;
  await render({}, "two");
  expect(ui.container.textContent).toContain("Rendered document");
});
it("keeps pending and rejected source modules out of the document render", async () => {
  route.failContent = true;
  await render({ pendingResources: ["broken:docs"] });
  expect(ui.container.textContent).toContain("Loading source presentation");
  expect(ui.container.textContent).not.toContain("MDX render failed");
  await render({ resourceErrors: { "broken:docs": "Source module failed to initialize" } });
  expect(ui.container.textContent).toContain("Source module failed to initialize");
  expect(ui.container.querySelector('nav[aria-label="Folders"] a[href="/healthy"]')).not.toBeNull();
  route.pathname = "/healthy";
  route.failContent = false;
  await render({ resourceErrors: { "broken:docs": "Source module failed to initialize" } });
  expect(ui.container.textContent).toContain("Rendered document");
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
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain("layout exploded");
  expect(ui.container.querySelector('[aria-label="Search documents"]')).not.toBeNull();
});
