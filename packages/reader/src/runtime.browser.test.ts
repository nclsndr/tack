// @vitest-environment jsdom
import { useMDXComponents } from "@mdx-js/react";
import { House, type LucideIcon } from "lucide-react";
import { act, createElement, Fragment, useState } from "react";
import type { ReactNode } from "react";
import { press, pressKey, settle, tabOut } from "./popover.test-support.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderLayout, SourceBlock } from "./runtime.tsx";
import type { ReaderBoot, ReaderCustomization } from "./runtime.tsx";
import type { ReaderDocument } from "./types.ts";
import { testRoot } from "./react.test-support.ts";

const route = vi.hoisted(() => ({ pathname: "/page", navigate: vi.fn() }));
vi.mock("@rspress/core/runtime", () => ({
  Content: () => createElement(FixtureContent),
  useLocation: () => ({ pathname: route.pathname }),
  useNavigate: () => route.navigate,
  useNavigationType: () => "POP",
  NavigationType: { Pop: "POP", Push: "PUSH", Replace: "REPLACE" },
  pathnameToRouteService: (pathname: string) =>
    boot.documents.find((document) => document.route === pathname),
}));

function authored(id: string, children: ReactNode): ReactNode {
  return createElement(SourceBlock, { id, file: "/repo/page.mdx", version: `${id}-v1` }, children);
}

function FixtureContent(): ReactNode {
  const [hidden, setHidden] = useState(true);
  const components = useMDXComponents();
  const RepositoryComponent = components["RepositoryComponent"];
  const DocsIcon = components["Icon"];
  const DocsCallout = components["Callout"];
  return createElement(
    Fragment,
    null,
    authored("heading", createElement("h1", null, "Reader example")),
    authored("prose", createElement("p", null, "Alpha authored prose.")),
    authored(
      "diagram",
      createElement(
        "figure",
        {
          id: "model",
          "data-reader-readable": "All model nodes",
          "data-reader-state": '{"selected":"source","zoom":1.5}',
        },
        "Selected model node",
      ),
    ),
    authored(
      "chart",
      createElement(
        "figure",
        {
          id: "cost",
          "data-reader-readable": "All chart values",
          "data-reader-state": '{"selected":"setup","scale":"sqrt"}',
        },
        "Chart value",
        createElement("h4", null, "Chart annotation"),
      ),
    ),
    authored("next", createElement("h2", null, "Next section")),
    authored("opaque", createElement("aside", null, "Generated opaque detail")),
    authored("last", createElement("p", null, "Last authored prose.")),
    createElement("section", { hidden }, createElement("h3", null, "Hidden step heading")),
    createElement(
      "button",
      { onClick: () => setHidden((value) => value === false) },
      "Toggle hidden step",
    ),
    typeof RepositoryComponent === "function" ? createElement(RepositoryComponent, {}) : null,
    typeof DocsIcon === "function"
      ? createElement(DocsIcon, { name: "house", label: "Home" })
      : null,
    typeof DocsCallout === "function"
      ? createElement(DocsCallout, { kind: "tip", title: "Mapped" }, "From MDX.")
      : null,
  );
}

const sourceBlocks = ["heading", "prose", "diagram", "chart", "next", "opaque", "last"].map(
  (id, index) => ({
    id,
    kind: ["diagram", "chart", "opaque"].includes(id) === true ? "mdxJsxFlowElement" : "paragraph",
    readable: id,
    raw: `<${id} />`,
    version: `${id}-v1`,
    source: { path: "/repo/page.mdx", startLine: index + 1, endLine: index + 1 },
    contributors: [],
  }),
);
const page: ReaderDocument = {
  id: "/repo/page.mdx",
  path: "/repo/page.mdx",
  relativePath: "guides/page.mdx",
  route: "/page",
  title: "First reader",
  metadata: { title: "First reader", type: "walkthrough", status: "active", tags: ["skills"] },
  blocks: sourceBlocks,
  imports: [],
  searchText: "hidden steps alpha",
  source: "",
};
const secondPage: ReaderDocument = {
  ...page,
  id: "/repo/cost.mdx",
  path: "/repo/cost.mdx",
  relativePath: "cost.mdx",
  route: "/cost",
  title: "Cost notes",
  metadata: { title: "Cost notes", type: "note", status: "draft", tags: ["cost"] },
  searchText: "chart setup",
};
const boot: ReaderBoot = {
  worktree: "/repo",
  project: { name: "tack" },
  resources: [],
  checkout: { kind: "branch", name: "main" },
  documents: [page, secondPage],
  revision: "revision-one",
  token: "session-token",
  metadata: {
    types: ["walkthrough", "note"],
    statuses: ["active", "draft"],
    tags: ["skills", "cost"],
  },
  presets: { navigation: "folders", layouts: "reader", components: "standard" },
  archive: [],
};

const ui = testRoot();
let clipboard: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let copyResponse: unknown;
let copyStatus: number;
let liveResponse: unknown;

beforeEach(() => {
  window.localStorage.clear();
  route.pathname = "/page";
  route.navigate.mockClear();
  window.history.replaceState({ router: "keep" }, "", "/page#part");
  clipboard = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
  copyResponse = { text: "Copied prompt\nSources: /repo/page.mdx:1-3" };
  copyStatus = 200;
  liveResponse = { revision: "revision-one" };
  fetchMock = vi.fn(
    async (input: string, _init?: RequestInit) =>
      new Response(JSON.stringify(input === "/__tack/status" ? liveResponse : copyResponse), {
        status: input === "/__tack/status" ? 200 : copyStatus,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

async function mount(
  customization: ReaderCustomization = {},
  selectedBoot: ReaderBoot = boot,
  icons: Readonly<Record<string, LucideIcon>> = {},
): Promise<void> {
  await ui.render(createElement(ReaderLayout, { boot: selectedBoot, customization, icons }));
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- DOM selectors do not encode their concrete control type, so test callers supply it.
function element<Selected extends Element = HTMLElement>(selector: string): Selected {
  const result = ui.container.querySelector<Selected>(selector);
  if (result === null) throw new Error(`Missing element: ${selector}`);
  return result;
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Opens the copy split button's menu; it renders only while open, in the reader root. */
async function openCopyFormats(): Promise<void> {
  await click(element('.tack-copybar [aria-haspopup="menu"]'));
  await settle();
}

/** Chooses a copy format from the open menu by its title; the menu closes on the choice. */
async function chooseFormat(title: string): Promise<void> {
  const item = Array.from(ui.container.querySelectorAll('[role="menuitemradio"]')).find(
    (candidate) =>
      document.getElementById(candidate.getAttribute("aria-labelledby") ?? "")?.textContent ===
      title,
  );
  if (item === undefined) throw new Error(`Missing copy format: ${title}`);
  await click(item);
  await settle();
}

async function change(target: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    target.value = value;
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function copiedRequest(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((args) => args[0] === "/__tack/copy");
  const init: unknown = call?.[1];
  if (
    typeof init !== "object" ||
    init === null ||
    !("body" in init) ||
    typeof init.body !== "string"
  )
    throw new Error("Missing copy body");
  return JSON.parse(init.body);
}

function select(start: Element, end: Element): void {
  const startText = start.firstChild;
  const endText = end.firstChild;
  if (startText === null || endText === null) throw new Error("Expected selectable authored text");
  const range = document.createRange();
  range.setStart(startText, 0);
  range.setEnd(endText, endText.textContent?.length ?? 0);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("reader browser copy", () => {
  it("opens the current document in the remembered editor after route changes", async () => {
    localStorage.setItem("tack-reader-editor", "cursor");
    await mount();
    expect(element(".tack-editor-link").getAttribute("href")).toBe("cursor://file/repo/page.mdx:1");
    route.pathname = "/cost";
    await mount();
    expect(element(".tack-editor-link").getAttribute("href")).toBe("cursor://file/repo/cost.mdx:1");
  });

  it("copies a block with saved identity and previews the exact clipboard prompt", async () => {
    await mount();
    await click(element('[data-source-id="prose"] button'));
    expect(copiedRequest()).toEqual({
      blocks: [{ id: "prose", version: "prose-v1" }],
      readable: "Alpha authored prose.",
      state: { url: window.location.href },
      mode: "readable",
      includeImplementations: false,
    });
    expect(clipboard).toHaveBeenCalledWith("Copied prompt\nSources: /repo/page.mdx:1-3");
    expect(element<HTMLTextAreaElement>('textarea[aria-label="Last copied prompt"]').value).toBe(
      "Copied prompt\nSources: /repo/page.mdx:1-3",
    );
    expect(element('[role="status"]').textContent).toContain(
      "Copied with physical source references",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { "Content-Type": "application/json", "X-Tack-Token": "session-token" },
    });
  });

  it("copies a section with both visual identities and stops at its next peer heading", async () => {
    await mount();
    await click(element('[data-source-id="heading"] button[title="Copy this section"]'));
    expect(copiedRequest()["blocks"]).toEqual(
      ["heading", "prose", "diagram", "chart", "next", "opaque", "last"].map((id) => ({
        id,
        version: `${id}-v1`,
      })),
    );
    expect(copiedRequest()["state"]).toEqual({
      model: { selected: "source", zoom: 1.5 },
      cost: { selected: "setup", scale: "sqrt" },
      url: window.location.href,
    });
    expect(copiedRequest()["readable"]).not.toContain("Copy block");
  });

  it("offers raw and reference formats plus component implementation context", async () => {
    await mount();
    await openCopyFormats();
    await chooseFormat("Raw source");
    await openCopyFormats();
    await click(element('[role="menuitemcheckbox"]'));
    // The toggle keeps the menu open; Escape closes it, as a reader would before copying.
    await pressKey(document.activeElement, "Escape");
    await click(element('[data-source-id="prose"] button'));
    expect(copiedRequest()).toMatchObject({ mode: "raw", includeImplementations: true });
    fetchMock.mockClear();
    await openCopyFormats();
    await chooseFormat("References only");
    await click(element('[data-source-id="prose"] button'));
    expect(copiedRequest()["mode"]).toBe("reference");
    fetchMock.mockClear();
    await openCopyFormats();
    await chooseFormat("Readable + sources");
    await click(element('[data-source-id="prose"] button'));
    expect(copiedRequest()["mode"]).toBe("readable");
  });

  it("falls back to source for an authored custom JSX block without readable integration", async () => {
    await mount();
    await click(element('[data-source-id="opaque"] button'));
    expect(copiedRequest()).not.toHaveProperty("readable");
    expect(copiedRequest()["blocks"]).toEqual([{ id: "opaque", version: "opaque-v1" }]);
  });

  it("copies text selection with only the selected blocks' relevant interaction state", async () => {
    await mount();
    select(element('[data-source-id="prose"] p'), element('[data-source-id="diagram"] figure'));
    await click(element(".tack-copybar button"));
    expect(copiedRequest()["blocks"]).toEqual([
      { id: "prose", version: "prose-v1" },
      { id: "diagram", version: "diagram-v1" },
    ]);
    expect(copiedRequest()["state"]).toEqual({
      model: { selected: "source", zoom: 1.5 },
      url: window.location.href,
    });
  });

  it("reports an empty selection and applies the chosen format to native authored copy", async () => {
    await mount();
    // The text label names the action; no glyph repeats it.
    expect(element(".tack-copybar button").textContent).toBe("Copy selection");
    expect(element(".tack-copybar button").querySelector("svg")).toBeNull();
    await click(element(".tack-copybar button"));
    expect(element('[role="status"]').textContent).toBe("Select rendered document text first.");
    select(element('[data-source-id="prose"] p'), element('[data-source-id="prose"] p'));
    const event = new Event("copy", { bubbles: true, cancelable: true });
    await act(async () => {
      element("article").dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(clipboard).toHaveBeenCalledOnce();
    await openCopyFormats();
    await chooseFormat("Raw source");
    // Choosing moved focus to the chevron; select the text again as a reader would.
    select(element('[data-source-id="prose"] p'), element('[data-source-id="prose"] p'));
    const native = new Event("copy", { bubbles: true, cancelable: true });
    await act(async () => {
      element("article").dispatchEvent(native);
    });
    expect(native.defaultPrevented).toBe(true);
    expect(clipboard).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({
      body: expect.stringContaining('"mode":"raw"'),
    });
    window.getSelection()?.removeAllRanges();
    const empty = new Event("copy", { bubbles: true, cancelable: true });
    await act(async () => {
      element("article").dispatchEvent(empty);
    });
    expect(empty.defaultPrevented).toBe(false);
  });

  it("shows stale-source errors without copying an old prompt", async () => {
    copyStatus = 409;
    copyResponse = { error: "Saved source changed. Refresh before copying." };
    await mount();
    await click(element('[data-source-id="prose"] button'));
    expect(element('[role="status"]').textContent).toBe(
      "Saved source changed. Refresh before copying.",
    );
    expect(clipboard).not.toHaveBeenCalled();
    expect(ui.container.querySelector("textarea")).toBeNull();
  });

  it("reports response, network, and clipboard failures", async () => {
    copyStatus = 500;
    copyResponse = {};
    await mount();
    await click(element('[data-source-id="prose"] button'));
    expect(element('[role="status"]').textContent).toBe("Reader action failed.");
    fetchMock.mockRejectedValueOnce("transport unavailable");
    await click(element('[data-source-id="prose"] button'));
    expect(element('[role="status"]').textContent).toBe("transport unavailable");
    copyStatus = 200;
    copyResponse = { text: "Fresh prompt" };
    clipboard.mockRejectedValueOnce(new Error("Clipboard denied"));
    await click(element('[data-source-id="prose"] button'));
    expect(element('[role="status"]').textContent).toBe("Clipboard denied");
  });
  it("handles an empty successful copy response without inventing prompt content", async () => {
    copyResponse = {};
    await mount();
    await click(element('[data-source-id="prose"] button'));
    expect(clipboard).toHaveBeenCalledWith("");
    expect(ui.container.querySelector("textarea")).toBeNull();
  });
  it("keeps selection when its copy button receives mouse down", async () => {
    await mount();
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => {
      element(".tack-copybar button").dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });
  it("supports standalone source controls outside a reader context", async () => {
    await ui.render(
      createElement(
        SourceBlock,
        { id: "standalone", file: "/repo/plain.mdx", version: "v" },
        "Source content",
      ),
    );
    await click(element("button"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ui.container.querySelector('button[title="Copy this section"]')).toBeNull();
  });
  it("does not present a nested visual heading as an authored section", async () => {
    await mount();
    expect(
      element('[data-source-id="chart"]').querySelector('button[title="Copy this section"]'),
    ).toBeNull();
  });
  it("does not invent references when a saved block identity is missing from the view", async () => {
    copyStatus = 409;
    copyResponse = { error: "Source identity changed; refresh the page." };
    await mount();
    const source = element('[data-source-id="prose"]');
    const copy = source.querySelector("button");
    if (copy === null) throw new Error("Missing copy control");
    source.removeAttribute("data-source-id");
    await click(copy);
    expect(copiedRequest()["blocks"]).toEqual([]);
    expect(element('[role="status"]').textContent).toBe(
      "Source identity changed; refresh the page.",
    );
    expect(clipboard).not.toHaveBeenCalled();
  });
  it("marks the blocks a copy control would copy while it is hovered or keyboard focused", async () => {
    await mount();
    const previewed = () =>
      Array.from(ui.container.querySelectorAll<HTMLElement>("[data-source-id]"))
        .filter((block) => block.dataset["preview"] === "true")
        .map((block) => block.dataset["sourceId"]);
    const blockControl = element('[data-source-id="prose"] .tack-cite');
    await act(async () => {
      blockControl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(previewed()).toEqual(["prose"]);
    await act(async () => {
      blockControl.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(previewed()).toEqual([]);
    const sectionControl = element('[data-source-id="next"] button[title="Copy this section"]');
    // jsdom decides :focus-visible from the events before; a keyboard focus is what matters here.
    vi.spyOn(sectionControl, "matches").mockReturnValue(true);
    await act(async () => sectionControl.focus());
    expect(previewed()).toEqual(["next", "opaque", "last"]);
    await act(async () => sectionControl.blur());
    expect(previewed()).toEqual([]);
  });
  it("does not preview on a focus that is not keyboard visible", async () => {
    await mount();
    const blockControl = element('[data-source-id="prose"] .tack-cite');
    vi.spyOn(blockControl, "matches").mockReturnValue(false);
    await act(async () => blockControl.focus());
    expect(element('[data-source-id="prose"]').dataset["preview"]).toBeUndefined();
  });
  it("does not preview from a standalone source control outside a reader context", async () => {
    await ui.render(
      createElement(
        SourceBlock,
        { id: "standalone", file: "/repo/plain.mdx", version: "v" },
        "Source content",
      ),
    );
    await act(async () => {
      element("button").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(element('[data-source-id="standalone"]').dataset["preview"]).toBeUndefined();
  });
  it.each([
    [2, 4, "lines 2–4"],
    [4, 4, "line 4"],
  ])(
    "names the saved lines %i to %i of a block on its copy control",
    async (startLine, endLine, named) => {
      await mount(
        {},
        {
          ...boot,
          documents: [
            {
              ...page,
              blocks: sourceBlocks.map((block) =>
                block.id === "prose"
                  ? { ...block, source: { ...block.source, startLine, endLine } }
                  : block,
              ),
            },
          ],
        },
      );
      const control = element('[data-source-id="prose"] .tack-cite');
      expect(control.getAttribute("aria-label")).toBe(`Copy block, ${named}`);
      expect(control.getAttribute("title")).toBe(`Copy ${named} of page.mdx`);
      expect(control.textContent).toBe(named.replace(/^lines? /, ""));
    },
  );
  it("clears the copied mark and then the copy notice after their display times", async () => {
    vi.useFakeTimers();
    await mount();
    await click(element('[data-source-id="prose"] .tack-cite'));
    expect(element('[data-source-id="prose"]').dataset["copied"]).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(element('[data-source-id="prose"]').dataset["copied"]).toBe("false");
    expect(element('[role="status"]').textContent).toBe("Copied with physical source references.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2400);
    });
    expect(ui.container.querySelector('[role="status"]')).toBeNull();
  });
  it("names the current document's resource in the copy request", async () => {
    const resource = { sourceRegistrationId: "team", name: "guides", sourcePath: "/repo" };
    await mount({}, { ...boot, documents: [{ ...page, resource }] });
    await click(element('[data-source-id="prose"] .tack-cite'));
    expect(copiedRequest()["resource"]).toEqual(resource);
  });
  it("asks for window focus when the browser denies clipboard access", async () => {
    clipboard.mockRejectedValueOnce(
      new DOMException("Document is not focused.", "NotAllowedError"),
    );
    await mount();
    await click(element('[data-source-id="prose"] .tack-cite'));
    expect(element('[role="status"]').textContent).toBe(
      "The browser denied clipboard access. Focus the reader window, then copy again.",
    );
  });
});

describe("reader views and live saved files", () => {
  it("keeps a copy notice when a successful live poll reports no source change", async () => {
    vi.useFakeTimers();
    await mount();
    await click(element('[data-source-id="prose"] button'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(element('[role="status"]').textContent).toBe("Copied with physical source references.");
  });

  it("updates page outlines when walkthrough visibility changes", async () => {
    await mount();
    expect(element(".tack-outline").textContent).not.toContain("Hidden step heading");
    const toggle = [...ui.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Toggle hidden step",
    );
    if (toggle === undefined) throw new Error("Missing step control");
    await click(toggle);
    expect(element(".tack-outline").textContent).toContain("Hidden step heading");
  });

  it("surfaces and clears source validation and polling errors", async () => {
    vi.useFakeTimers();
    const live = () => {
      const status = element(".tack-live");
      return [status.textContent, status.getAttribute("title")];
    };
    liveResponse = { revision: "revision-one", error: "Missing document title" };
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // A failed rebuild joins the issue popover instead of a transient notice.
    expect(ui.container.querySelector('[role="status"]')).toBeNull();
    expect(element(".tack-issue-count").textContent).toBe("Rebuild failed");
    await click(element(".tack-issue-count"));
    expect(element(".tack-issues li").title).toBe("Missing document title");
    expect(element(".tack-project-attention").title).toBe("Rebuild failed");
    expect(live()).toEqual(["Source error", "Saved source has an error"]);
    liveResponse = { revision: "revision-one" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(ui.container.querySelector('[role="status"]')).toBeNull();
    expect(ui.container.querySelector(".tack-issue-count")).toBeNull();
    expect(ui.container.querySelector(".tack-project-attention")).toBeNull();
    expect(live()).toEqual(["Live", "Live from saved files"]);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(element('[role="status"]').textContent).toContain("Refreshing the local reader");
    expect(live()).toEqual(["Reconnecting", "Reconnecting to the local reader"]);
  });
  it("names the project in the header and follows a branch switch from the status check", async () => {
    vi.useFakeTimers();
    await mount();
    expect(element(".tack-monogram").textContent).toBe("TK");
    expect(element(".tack-project-name").textContent).toBe("tack");
    expect(element(".tack-project-place").textContent).toBe("main");
    liveResponse = {
      revision: "revision-one",
      error: "",
      checkout: { kind: "branch", name: "feat/reader-header" },
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(element(".tack-project-place").textContent).toBe("feat/reader-header");
    liveResponse = { revision: "revision-one", error: "", checkout: null };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(element(".tack-project-place").textContent).toBe("repo");
  });
  it("draws a docs Icon from the generation's icon set and lists unknown icons as issues", async () => {
    await mount({}, boot, { house: House });
    expect(element('article svg.lucide-house[role="img"]').getAttribute("aria-label")).toBe("Home");
    expect(element('article aside[data-kind="tip"]').getAttribute("aria-label")).toBe(
      "Tip: Mapped",
    );
    await ui.unmount();
    await mount(
      {},
      {
        ...boot,
        iconIssues: [
          { path: "/repo/page.mdx", line: 4, message: 'unknown icon "home"', suggestions: [] },
        ],
      },
    );
    expect(element("article .tack-icon-missing").dataset["icon"]).toBe("house");
    expect(element(".tack-issue-count").textContent).toBe("1 unknown icon");
    expect(element(".tack-project-attention").title).toBe("1 unknown icon");
    await click(element(".tack-issue-count"));
    expect(element(".tack-issue-name").textContent).toBe("page.mdx:4");
  });
  it("keeps unavailable documentation out of the sidebar and in the issue popover", async () => {
    await mount(
      {},
      {
        ...boot,
        complete: false,
        issues: [
          {
            resource: { sourceRegistrationId: "source", name: "guides" },
            sourcePath: "/repo",
            code: "document-load",
            message: "/repo/guides/broken.mdx: cannot parse authored MDX: Unexpected character",
            path: "/repo/guides/broken.mdx",
          },
        ],
      },
    );
    const sidebar = element("#reader-documents");
    expect(sidebar.textContent).not.toContain("Some documentation is unavailable");
    expect(sidebar.textContent).not.toContain("cannot parse authored MDX");
    expect(element(".tack-project-attention").title).toBe("1 doc skipped");
    expect(element(".tack-issue-count").textContent).toBe("1 doc skipped");
    await click(element(".tack-issue-count"));
    expect(element(".tack-issue-name").textContent).toBe("broken.mdx");
    // The panel renders inside the reader root, so the reader's element defaults style it.
    expect(element(".tack-reader").contains(element(".tack-issues"))).toBe(true);
    expect(element(".tack-live").textContent).toBe("Source error");
    expect(ui.container.querySelector('[role="status"]')).toBeNull();
  });
  it("reports a failed refresh response as a live error", async () => {
    vi.useFakeTimers();
    await mount();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(element('[role="status"]').textContent).toContain("Refreshing the local reader");
  });
  it("reloads into a changed partial corpus instead of retaining stale documents", async () => {
    vi.useFakeTimers();
    await mount();
    const original = window;
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    try {
      liveResponse = { revision: "revision-two", error: "Beta source module cannot be resolved" };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal("window", original);
    }
  });
  it("asks for an available document when a live source disappears from the current route", async () => {
    route.pathname = "/removed";
    await mount();
    expect(ui.container.textContent).toContain("Choose an available document");
    expect(ui.container.textContent).not.toContain("No declared documents");
  });
  it("discards a delayed live response after the reader unmounts", async () => {
    vi.useFakeTimers();
    let complete: (response: Response) => void = () => {
      throw new Error("Poll not started");
    };
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
    );
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await ui.unmount();
    const original = window;
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    await act(async () => {
      complete(new Response(JSON.stringify({ revision: "revision-two" })));
    });
    expect(reload).not.toHaveBeenCalled();
    vi.stubGlobal("window", original);
  });
  it("discards a delayed live rejection after the reader unmounts", async () => {
    vi.useFakeTimers();
    let fail: (reason: Error) => void = () => {
      throw new Error("Poll not started");
    };
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((_resolve, reject) => {
        fail = reject;
      }),
    );
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await ui.unmount();
    await act(async () => {
      fail(new Error("Disconnected"));
    });
    expect(ui.container.textContent).toBe("");
  });

  it("uses repository navigation, per-document layouts, and component overrides", async () => {
    await mount(
      {
        Navigation: ({ children }) => createElement("nav", { "data-repo": "nav" }, children),
        layouts: {
          focus: ({ children }) => createElement("section", { "data-repo": "layout" }, children),
        },
        components: {
          RepositoryComponent: () =>
            createElement("strong", { "data-repo": "component" }, "Repository component"),
        },
      },
      { ...boot, documents: [{ ...page, metadata: { ...page.metadata, layout: "focus" } }] },
    );
    expect(element('[data-repo="nav"]').textContent).toContain("First reader");
    expect(element('[data-repo="layout"]').textContent).toContain("Alpha authored prose");
    expect(element('[data-repo="component"]').textContent).toBe("Repository component");
  });

  it.each(["page.mdx", "guides/page.mdx", "./guides/page.mdx", "/repo/page.mdx"])(
    "filters navigation using a file path from the search URL: %s",
    async (query) => {
      window.history.replaceState({}, "", `/page?${new URLSearchParams({ q: query })}`);
      await mount();
      expect(element<HTMLInputElement>('[aria-label="Search documents"]').value).toBe(query);
      const navigation = element('nav[aria-label="Folders"]');
      expect(navigation.textContent).toContain("First reader");
      expect(navigation.textContent).not.toContain("Cost notes");
      expect(navigation.querySelectorAll("a")).toHaveLength(1);
      expect(element(".tack-file-count").textContent).toBe("1 / 2");
    },
  );

  it("persists filters in URLs and restores filtered views on browser popstate", async () => {
    await mount();
    const input = element<HTMLInputElement>('[aria-label="Search documents"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "hidden alpha",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await change(element<HTMLSelectElement>('[aria-label="Filter by type"]'), "walkthrough");
    await change(element<HTMLSelectElement>('[aria-label="Filter by status"]'), "active");
    await change(element<HTMLSelectElement>('[aria-label="Filter by tag"]'), "skills");
    expect(element('nav[aria-label="Folders"]').textContent).toContain("First reader");
    expect(element('nav[aria-label="Folders"]').textContent).not.toContain("Cost notes");
    expect(window.location.search).toContain("q=hidden+alpha");
    expect(window.location.hash).toBe("#part");
    expect(window.history.state).toEqual({ router: "keep" });
    await act(async () => {
      window.history.replaceState(
        window.history.state,
        "",
        "/page?type=note&status=draft&tag=cost",
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(input.value).toBe("");
    expect(element('nav[aria-label="Folders"]').textContent).toContain("Cost notes");
    await change(element<HTMLSelectElement>('[aria-label="Filter by status"]'), "active");
    expect(element('nav[aria-label="Folders"]').textContent).toContain("No documents match.");
  });
});

it("keeps app appearance separate from document actions", async () => {
  await mount();
  const appearance = element('.tack-sidebar footer [role="group"][aria-label="Appearance"]');
  expect(
    [...appearance.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
  ).toEqual(["System", "Light", "Dark"]);
});

it("toggles inline filters without dismissing them on outside interaction or losing selections", async () => {
  window.history.replaceState({}, "", "/page?q=hidden&type=walkthrough&status=active");
  await mount();
  const toggle = element<HTMLButtonElement>(".tack-filter-toggle");
  const panel = element<HTMLDivElement>("#reader-filters");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.hidden).toBe(true);
  expect(toggle.textContent).toBe("Filters · 2");
  await click(toggle);
  expect(panel.hidden).toBe(false);
  await click(element('[aria-label="Search documents"]'));
  expect(panel.hidden).toBe(false);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await click(toggle);
  expect(panel.hidden).toBe(true);
  expect(element<HTMLSelectElement>('[aria-label="Filter by type"]').value).toBe("walkthrough");
  await click(toggle);
  await click(element("#reader-filters button"));
  expect(window.location.search).toBe("?q=hidden");
  expect(toggle.textContent).toBe("Filters");
  expect(panel.hidden).toBe(false);
});

it("exposes a compact document list with the current page and full titles", async () => {
  const documents = Array.from({ length: 40 }, (_, index) => ({
    ...page,
    id: `doc-${index}`,
    route: `/doc-${index}`,
    title: `Working document ${index}`,
  }));
  route.pathname = "/doc-20";
  await mount({}, { ...boot, documents });
  expect(ui.container.querySelectorAll('nav[aria-label="Folders"] a')).toHaveLength(40);
  expect(
    element('nav[aria-label="Folders"] a[aria-current="page"]').getAttribute("title"),
  ).toContain("Working document 20");
});

describe("document drawer on a narrow viewport", () => {
  /** Matches the reader's narrow-viewport query, the way a phone-width browser does. */
  const narrow = () =>
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(width < 48rem)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  const drawer = () => ui.container.querySelector<HTMLElement>('[role="dialog"]');

  it("keeps the documents out of the page until the Files trigger opens them", async () => {
    narrow();
    await mount();
    const toggle = element<HTMLButtonElement>(".tack-navigation-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(ui.container.querySelector("#reader-documents")).toBeNull();
    await click(toggle);
    await settle();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(drawer()?.id).toBe("reader-documents");
    expect(drawer()?.getAttribute("aria-label")).toBe("Documents");
    expect(document.activeElement).toBe(element('[aria-label="Search documents"]'));
    expect(element("main").closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("traps focus in the open drawer and closes on Escape back on the Files trigger", async () => {
    narrow();
    await mount();
    const toggle = element<HTMLButtonElement>(".tack-navigation-toggle");
    await act(async () => toggle.focus());
    await click(toggle);
    await settle();
    const opened = drawer();
    if (opened === null) throw new Error("Missing drawer");
    await tabOut(opened);
    expect(opened.contains(document.activeElement)).toBe(true);
    await pressKey(document.activeElement, "Escape");
    expect(drawer()).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("dismisses the drawer with a leftward swipe", async () => {
    narrow();
    await mount();
    const toggle = element<HTMLButtonElement>(".tack-navigation-toggle");
    await click(toggle);
    await settle();
    const opened = element("#reader-documents");
    // jsdom has no hit testing; the gesture stays over the drawer throughout.
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => opened,
    });
    try {
      for (const [type, clientX] of [
        ["pointerdown", 240],
        ["pointermove", 220],
        ["pointermove", 120],
        ["pointerup", 120],
      ] as const) {
        await act(async () => {
          opened.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerType: "mouse",
              pointerId: 1,
              button: 0,
              buttons: type === "pointerup" ? 0 : 1,
              clientX,
              clientY: 100,
            }),
          );
        });
      }
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
    await settle();
    expect(drawer()).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("closes from its close button, a press outside it, and a followed document link", async () => {
    narrow();
    await mount();
    const toggle = element<HTMLButtonElement>(".tack-navigation-toggle");
    await click(toggle);
    await settle();
    await click(element(".tack-navigation-close"));
    await settle();
    expect(drawer()).toBeNull();
    await click(toggle);
    await settle();
    await press(element(".tack-navigation-backdrop"));
    expect(drawer()).toBeNull();
    await click(toggle);
    await settle();
    await click(element('#reader-documents nav a[href="/cost"]'));
    await settle();
    expect(drawer()).toBeNull();
    expect(route.navigate).toHaveBeenCalledExactlyOnceWith("/cost");
  });

  it("opens from the slash shortcut with the search focused", async () => {
    narrow();
    await mount();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    });
    await settle();
    expect(drawer()).not.toBeNull();
    expect(document.activeElement).toBe(element('[aria-label="Search documents"]'));
  });
});

describe("sidebar layout", () => {
  const reader = () => element(".tack-reader");
  const handle = () => element('[role="separator"][aria-label="Resize documents"]');
  const width = () => reader().style.getPropertyValue("--tack-sidebar-width");
  const stored = () => JSON.parse(window.localStorage.getItem("tack-reader:sidebar") ?? "null");
  const pointer = async (type: string, clientX: number, init: PointerEventInit = {}) => {
    await act(async () => {
      handle().dispatchEvent(
        new PointerEvent(type, { bubbles: true, clientX, pointerId: 1, button: 0, ...init }),
      );
    });
  };
  const key = async (name: string) => {
    await act(async () => {
      handle().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    });
  };
  const remount = async () => {
    await ui.unmount();
    await mount();
  };

  let capture: ReturnType<typeof vi.fn<(pointerId: number) => void>>;
  beforeEach(() => {
    capture = vi.fn<(pointerId: number) => void>();
    HTMLElement.prototype.setPointerCapture = capture;
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  });

  it("hides and restores the document sidebar and keeps the choice across reloads", async () => {
    await mount();
    const hide = element<HTMLButtonElement>(".tack-sidebar-hide");
    const show = element<HTMLButtonElement>(".tack-sidebar-show");
    expect(reader().dataset["sidebarHidden"]).toBe("false");
    expect(hide.getAttribute("aria-label")).toBe("Hide documents");
    expect(hide.getAttribute("aria-controls")).toBe("reader-documents");
    expect(show.getAttribute("aria-expanded")).toBe("true");
    await click(hide);
    expect(reader().dataset["sidebarHidden"]).toBe("true");
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(show);
    await remount();
    expect(reader().dataset["sidebarHidden"]).toBe("true");
    await click(element(".tack-sidebar-show"));
    expect(reader().dataset["sidebarHidden"]).toBe("false");
    expect(document.activeElement).toBe(element(".tack-sidebar-hide"));
    expect(stored()).toEqual({ width: 284, hidden: false });
  });

  it("reveals a hidden sidebar to search with the slash shortcut", async () => {
    await mount();
    await click(element(".tack-sidebar-hide"));
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true })),
    );
    expect(reader().dataset["sidebarHidden"]).toBe("false");
    expect(document.activeElement).toBe(element('[aria-label="Search documents"]'));
  });

  it("names both sidebar toggles and their shortcut in tooltips, not native titles", async () => {
    await mount();
    for (const selector of [".tack-sidebar-hide", ".tack-sidebar-show"]) {
      expect(element(selector).hasAttribute("title")).toBe(false);
    }
    expect(element(".tack-sidebar-hide").getAttribute("data-reader-tooltip-trigger")).toBe(
      "Hide documents (⌘B)",
    );
    expect(element(".tack-sidebar-show").getAttribute("data-reader-tooltip-trigger")).toBe(
      "Show documents (⌘B)",
    );
  });

  it("toggles the sidebar with Command-B outside editable fields", async () => {
    await mount();
    const keydown = async (target: EventTarget, init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      await act(async () => target.dispatchEvent(event));
      return event.defaultPrevented;
    };
    element<HTMLAnchorElement>('nav[aria-label="Folders"] a').focus();
    expect(await keydown(document, { key: "b", metaKey: true })).toBe(true);
    expect(reader().dataset["sidebarHidden"]).toBe("true");
    expect(document.activeElement).toBe(element(".tack-sidebar-show"));
    expect(await keydown(document, { key: "B", metaKey: true })).toBe(true);
    expect(reader().dataset["sidebarHidden"]).toBe("false");
    expect(document.activeElement).toBe(element(".tack-sidebar-hide"));
    element<HTMLAnchorElement>(".tack-editor-link").focus();
    await keydown(document, { key: "b", metaKey: true });
    await keydown(document, { key: "b", metaKey: true });
    expect(document.activeElement).toBe(element(".tack-editor-link"));
    expect(await keydown(document, { key: "b", metaKey: true, shiftKey: true })).toBe(false);
    expect(await keydown(document, { key: "b", ctrlKey: true })).toBe(false);
    expect(await keydown(document, { key: "b", metaKey: true, altKey: true })).toBe(false);
    expect(
      await keydown(element('[aria-label="Search documents"]'), { key: "b", metaKey: true }),
    ).toBe(false);
    expect(reader().dataset["sidebarHidden"]).toBe("false");
  });

  it("resizes the sidebar by dragging and saves the width once the drag ends", async () => {
    await mount();
    expect(width()).toBe("284px");
    expect(handle().getAttribute("aria-valuenow")).toBe("284");
    expect(handle().getAttribute("aria-valuemin")).toBe("220");
    expect(handle().getAttribute("aria-valuemax")).toBe("624");
    await pointer("pointermove", 500);
    expect(width()).toBe("284px");
    await pointer("pointerdown", 300, { button: 2 });
    await pointer("pointermove", 500);
    expect(width()).toBe("284px");
    await pointer("pointerdown", 300);
    expect(capture).toHaveBeenCalledWith(1);
    expect(reader().dataset["sidebarResizing"]).toBe("true");
    await pointer("pointermove", 360);
    expect(width()).toBe("344px");
    expect(stored()).toEqual({ width: 284, hidden: false });
    await pointer("pointermove", 2000);
    expect(width()).toBe("624px");
    await pointer("pointerup", 2000);
    expect(reader().dataset["sidebarResizing"]).toBe("false");
    expect(stored()).toEqual({ width: 624, hidden: false });
    await pointer("pointerdown", 500);
    await pointer("pointermove", 0);
    await pointer("pointercancel", 0);
    expect(width()).toBe("220px");
    expect(reader().dataset["sidebarResizing"]).toBe("false");
    await remount();
    expect(width()).toBe("220px");
  });

  it("resizes the sidebar from the keyboard and resets it with a double click", async () => {
    await mount();
    await key("ArrowRight");
    expect(handle().getAttribute("aria-valuenow")).toBe("300");
    await key("ArrowLeft");
    await key("ArrowLeft");
    expect(width()).toBe("268px");
    await key("End");
    expect(width()).toBe("624px");
    await key("Enter");
    expect(width()).toBe("624px");
    await act(async () => {
      handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(width()).toBe("284px");
    expect(stored()).toEqual({ width: 284, hidden: false });
  });
});

describe("folder navigation", () => {
  const working = (relativePath: string, title: string, status: string): ReaderDocument => ({
    ...page,
    id: `/repo/${relativePath}`,
    path: `/repo/${relativePath}`,
    relativePath,
    route: `/${relativePath.replace(/\.mdx$/, "")}`,
    title,
    metadata: { title, type: "spec", status, tags: [] },
  });
  const corpus: ReaderBoot = {
    ...boot,
    documents: [
      working("docs/2026-10-19-23:44-index.mdx", "Index", "active"),
      working("docs/archive/decisions/2026-09-18-10:11-layout.mdx", "Symlink layout", "superseded"),
      working("docs/archive/done/todo.mdx", "Skill todo", "complete"),
      working("docs/archive/done/link-layout.mdx", "Link layout notes", "complete"),
      working(
        "docs/specs/2026-09-22-22:44-source-spec/2026-09-22-22:44-model.mdx",
        "Model",
        "draft",
      ),
      working(
        "docs/specs/2026-09-22-22:44-source-spec/2026-10-18-22:15-catalog.mdx",
        "Catalog",
        "active",
      ),
      working("docs/wip/2026-10-18-22:55-qa.mdx", "QA report", "active"),
    ],
    archive: ["docs/archive"],
  };
  const titles = (selector: string) =>
    [...ui.container.querySelectorAll(`${selector} a .tack-entry-title`)].map(
      (title) => title.textContent,
    );
  const folder = (path: string) => element<HTMLButtonElement>(`button[data-folder="${path}"]`);
  const shelf = () => element<HTMLButtonElement>(".tack-archive-toggle");
  const search = async (value: string) => {
    const input = element<HTMLInputElement>('[aria-label="Search documents"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const remount = async () => {
    await ui.unmount();
    await mount({}, corpus);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 19, 12));
    route.pathname = "/docs/specs/2026-09-22-22:44-source-spec/2026-10-18-22:15-catalog";
  });

  it("opens only the current document's folders and keeps the archive on a closed shelf", async () => {
    await mount({}, corpus);
    expect(titles(".tack-tree-active")).toEqual(["Index", "Catalog", "Model"]);
    expect(folder("docs/wip").getAttribute("aria-expanded")).toBe("false");
    expect(folder("docs/wip").textContent).toBe("wip1");
    expect(folder("docs/specs/2026-09-22-22:44-source-spec").textContent).toBe("source spec2");
    expect(shelf().getAttribute("aria-expanded")).toBe("false");
    expect(shelf().textContent).toBe("Archive3");
    expect(titles(".tack-archive")).toEqual([]);
    const current = element('nav[aria-label="Folders"] a[aria-current="page"]');
    expect(current.querySelector(".tack-entry-age")?.textContent).toBe("1d");
    expect(current.getAttribute("title")).toBe("Catalog · spec · active · 2026-10-18");
    expect(element(".tack-tree-active a .tack-entry-age").textContent).toBe("today");
  });

  it("restores folder and shelf choices after a live reload", async () => {
    await mount({}, corpus);
    await click(folder("docs/wip"));
    await click(shelf());
    await click(folder("docs/archive/done"));
    expect(titles(".tack-tree-active")).toContain("QA report");
    expect(titles(".tack-archive")).toEqual(["Link layout notes", "Skill todo"]);
    await remount();
    expect(titles(".tack-tree-active")).toContain("QA report");
    expect(titles(".tack-archive")).toEqual(["Link layout notes", "Skill todo"]);
    await click(folder("docs/wip"));
    await click(shelf());
    await remount();
    expect(titles(".tack-tree-active")).not.toContain("QA report");
    expect(shelf().getAttribute("aria-expanded")).toBe("false");
  });

  it("ignores an unreadable stored navigation state", async () => {
    window.localStorage.setItem("tack-reader:navigation:/repo", "{broken");
    await mount({}, corpus);
    expect(shelf().getAttribute("aria-expanded")).toBe("false");
    window.localStorage.setItem("tack-reader:navigation:/repo", '{"open":7}');
    await remount();
    expect(folder("docs/wip").getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the shelf and folders that hold an archived current document", async () => {
    route.pathname = "/docs/archive/decisions/2026-09-18-10:11-layout";
    await mount({}, corpus);
    expect(shelf().getAttribute("aria-expanded")).toBe("true");
    expect(titles(".tack-archive")).toEqual(["Symlink layout"]);
    expect(element(".tack-archive a").getAttribute("aria-current")).toBe("page");
  });

  it("keys a resource's folders and archive by the resource", async () => {
    const resource = { sourceRegistrationId: "team", name: "guides", sourcePath: "/repo" };
    route.pathname = "/a/one";
    await mount(
      {},
      {
        ...corpus,
        documents: [
          { ...working("a/one.mdx", "One", "active"), resource },
          { ...working("b/two.mdx", "Two", "active"), resource },
          { ...working("archive/old.mdx", "Old", "complete"), resource },
        ],
        archive: ["team:guides:archive"],
      },
    );
    expect(folder("team:guides:a").getAttribute("aria-expanded")).toBe("true");
    expect(folder("team:guides:b").getAttribute("aria-expanded")).toBe("false");
    expect(titles(".tack-tree-active")).toEqual(["One"]);
    expect(shelf().textContent).toBe("Archive1");
    await click(shelf());
    await click(folder("archive"));
    expect(titles(".tack-archive")).toEqual(["Old"]);
  });

  it("brings the current document into view in the index", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      await mount({}, corpus);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(scrollIntoView.mock.contexts[0]).toBe(
        element('nav[aria-label="Folders"] a[aria-current="page"]'),
      );
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("opens matching folders while filtering and points to matches on a closed shelf", async () => {
    await mount({}, corpus);
    await search("qa");
    expect(titles(".tack-tree-active")).toEqual(["QA report"]);
    await click(folder("docs/wip"));
    expect(titles(".tack-tree-active")).toEqual([]);
    await search("q");
    expect(titles(".tack-tree-active")).toEqual(["QA report"]);
    await search("layout");
    expect(titles(".tack-tree-active")).toEqual([]);
    expect(shelf().textContent).toBe("Archive2");
    expect(element(".tack-archive-hint").textContent).toBe("Show 2 archived matches");
    await search("symlink");
    expect(shelf().textContent).toBe("Archive1");
    expect(ui.container.querySelector(".tack-empty")).toBeNull();
    expect(element(".tack-archive-hint").textContent).toBe("Show 1 archived match");
    await click(element(".tack-archive-hint"));
    expect(titles(".tack-archive")).toEqual(["Symlink layout"]);
    expect(ui.container.querySelector(".tack-archive-hint")).toBeNull();
    await search("nothing");
    expect(ui.container.querySelector(".tack-archive")).toBeNull();
    expect(element(".tack-empty").textContent).toBe("No documents match.");
    await search("");
    expect(folder("docs/wip").getAttribute("aria-expanded")).toBe("false");
  });
});
