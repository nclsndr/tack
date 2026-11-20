// @vitest-environment jsdom
import { useMDXComponents } from "@mdx-js/react";
import { act, createElement, Fragment } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderLink } from "./link.tsx";
import { ReaderLayout } from "./runtime.tsx";
import type { ReaderBoot } from "./runtime.tsx";
import type { ReaderDocument } from "./types.ts";

const router = vi.hoisted(() => ({
  pathname: "/page",
  navigate: vi.fn<(to: string) => void>(),
  type: "POP",
  routes: ["/page", "/cost"],
}));
vi.mock("@rspress/core/runtime", () => ({
  Content: () => createElement(MarkdownLinks),
  useLocation: () => ({ pathname: router.pathname }),
  useNavigate: () => router.navigate,
  useNavigationType: () => router.type,
  NavigationType: { Pop: "POP", Push: "PUSH", Replace: "REPLACE" },
  pathnameToRouteService: (pathname: string) =>
    router.routes.includes(pathname) === true ? { path: pathname } : undefined,
}));

/** Renders links the way compiled Markdown does: through the MDX `a` component when one is provided. */
function MarkdownLinks(): ReactNode {
  const components = useMDXComponents();
  const Anchor = components["a"] ?? "a";
  const link = (label: string, props: Record<string, string>) =>
    createElement(Anchor, { key: label, "data-case": label, ...props }, label);
  return createElement(
    Fragment,
    null,
    link("page", { href: "/cost" }),
    link("page-hash", { href: "/cost#later" }),
    link("query-hash", { href: "/page#part" }),
    link("external", { href: "https://example.com/notes" }),
    link("mail", { href: "mailto:team@example.com" }),
    link("hash", { href: "#part" }),
    link("download", { href: "/cost", download: "" }),
    link("new-tab", { href: "/cost", target: "_blank" }),
    link("asset", { href: "/assets/diagram.svg" }),
  );
}

const page: ReaderDocument = {
  id: "/repo/page.md",
  path: "/repo/page.md",
  relativePath: "page.md",
  route: "/page",
  title: "First reader",
  metadata: { title: "First reader", tags: [] },
  blocks: [],
  imports: [],
  searchText: "reader notes",
  source: "",
};
const cost: ReaderDocument = {
  ...page,
  id: "/repo/cost.md",
  path: "/repo/cost.md",
  relativePath: "cost.md",
  route: "/cost",
  title: "Cost notes",
  metadata: { title: "Cost notes", tags: [] },
};
const boot: ReaderBoot = {
  worktree: "/repo",
  project: { name: "repo" },
  resources: [],
  checkout: null,
  documents: [page, cost],
  revision: "revision-one",
  token: "session",
  metadata: { types: [], statuses: [], tags: [] },
  presets: { navigation: "folders", layouts: "reader", components: "standard" },
  archive: [],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Promise<Response>(() => undefined)),
  );
  router.pathname = "/page";
  router.navigate.mockReset();
  router.type = "POP";
  window.history.replaceState(null, "", "/page?q=reader");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ReaderLayout, { boot, customization: {} })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function anchor(selector: string): HTMLAnchorElement {
  const result = container.querySelector<HTMLAnchorElement>(selector);
  if (result === null) throw new Error(`Missing link: ${selector}`);
  return result;
}

/**
 * Clicks a link and reports whether the browser would have left the document: an unprevented
 * click on an anchor is a full document navigation.
 */
async function click(target: HTMLAnchorElement, init: MouseEventInit = {}): Promise<boolean> {
  let browserNavigates = false;
  await act(async () => {
    // The window sees the click last: record whether anything kept it in the document, then stop
    // jsdom from attempting the navigation it does not implement.
    window.addEventListener(
      "click",
      (event) => {
        browserNavigates = event.defaultPrevented === false;
        event.preventDefault();
      },
      { once: true },
    );
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
  return browserNavigates;
}

describe("router-aware reader links", () => {
  it("opens a sidebar document through the client router and keeps the reader query", async () => {
    const row = anchor('aside a[href^="/cost"]');
    expect(row.getAttribute("href")).toBe("/cost?q=reader");

    // Budget: no full document navigation for an internal page.
    expect(await click(row)).toBe(false);
    expect(router.navigate.mock.calls.map(([to]) => to)).toEqual(["/cost?q=reader"]);
  });

  it("opens Markdown links to reader pages through the client router", async () => {
    expect(await click(anchor('[data-case="page"]'))).toBe(false);
    expect(await click(anchor('[data-case="page-hash"]'))).toBe(false);
    // The same page under another query is another address, not a jump within this one.
    expect(await click(anchor('[data-case="query-hash"]'))).toBe(false);
    expect(router.navigate.mock.calls.map(([to]) => to)).toEqual([
      "/cost",
      "/cost#later",
      "/page#part",
    ]);
  });

  it.each([
    ["external", {}],
    ["mail", {}],
    ["hash", {}],
    ["download", {}],
    ["new-tab", {}],
    ["asset", {}],
    ["page", { metaKey: true }],
    ["page", { ctrlKey: true }],
    ["page", { shiftKey: true }],
    ["page", { altKey: true }],
    ["page", { button: 1 }],
  ] satisfies [string, MouseEventInit][])(
    "leaves the %s link %o to the browser",
    async (label, init) => {
      expect(await click(anchor(`[data-case="${label}"]`), init)).toBe(true);
      expect(router.navigate).not.toHaveBeenCalled();
    },
  );

  it("leaves a modified click on a sidebar row to the browser", async () => {
    expect(await click(anchor('aside a[href^="/cost"]'), { metaKey: true })).toBe(true);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("leaves a click that a handler already took over to that handler", async () => {
    await act(async () =>
      root.render(
        createElement(
          ReaderLink,
          { href: "/cost", onClick: (event) => event.preventDefault(), id: "taken" },
          "Taken",
        ),
      ),
    );

    expect(await click(anchor("#taken"))).toBe(false);
    expect(router.navigate).not.toHaveBeenCalled();
  });
});

describe("client-routed page scroll", () => {
  async function arrive(pathname: string, address: string, type: string) {
    router.pathname = pathname;
    router.type = type;
    window.history.replaceState(null, "", address);
    await act(async () => root.render(createElement(ReaderLayout, { boot, customization: {} })));
  }

  it("opens a pushed page at its top", async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    await arrive("/cost", "/cost", "PUSH");

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("opens a pushed page at its fragment", async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    const target = document.createElement("h2");
    target.id = "later part";
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);
    try {
      await arrive("/cost", "/cost#later%20part", "PUSH");
    } finally {
      target.remove();
    }

    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("leaves Back and Forward scroll restoration to the browser", async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    await arrive("/cost", "/cost", "POP");

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
