// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorControl } from "./editor.tsx";
import { pressKey, settle } from "./popover.test-support.ts";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function mount(path: string | undefined = "/repo/page.mdx") {
  await act(async () => root.render(createElement(EditorControl, { path })));
}

function controls() {
  const link = container.querySelector("a");
  const trigger = container.querySelector("button");
  if (link === null || trigger === null) throw new Error("Missing editor controls");
  return { link, trigger, open: trigger.getAttribute("aria-expanded") === "true" };
}

/** The editor choices of the open menu, which renders in a portal outside the container. */
const choices = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));

async function openMenu() {
  const { trigger } = controls();
  await act(async () => trigger.focus());
  await act(async () => trigger.click());
  await settle();
}

async function choose(label: string) {
  await openMenu();
  const item = choices().find((candidate) => candidate.textContent === label);
  if (item === undefined) throw new Error(`Missing editor: ${label}`);
  await act(async () => item.click());
  await settle();
  return label;
}

it("offers Zed, Cursor and VSCode in order, with Zed selected by default", async () => {
  await mount();
  expect(controls().trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(controls().link.textContent).toBe("Open in Zed");
  expect(controls().link.getAttribute("href")).toBe("zed://file/repo/page.mdx:1");
  expect(controls().link.querySelector("svg")).toBeNull();
  await openMenu();
  expect(choices().map((item) => item.textContent)).toEqual(["Zed", "Cursor", "VSCode"]);
  expect(choices().map((item) => item.getAttribute("aria-checked"))).toEqual([
    "true",
    "false",
    "false",
  ]);
});

it("moves between editors with the arrow keys and closes on Escape, back on its trigger", async () => {
  await mount();
  await openMenu();
  const first = document.activeElement;
  await pressKey(document.activeElement, "ArrowDown");
  expect(document.activeElement).not.toBe(first);
  expect(choices()).toContain(document.activeElement);
  await pressKey(document.activeElement, "Escape");
  expect(controls().open).toBe(false);
  expect(choices()).toEqual([]);
  expect(document.activeElement).toBe(controls().trigger);
});

it.each([
  ["Zed", "zed"],
  ["Cursor", "cursor"],
  ["VSCode", "vscode"],
])("remembers %s across remounts and uses its encoded file URL", async (label, value) => {
  const path = "/repo/notes/00:19 a#b?c%dé.mdx";
  await mount(path);
  await choose(label);
  expect(controls().open).toBe(false);
  expect(document.activeElement).toBe(controls().trigger);
  expect(localStorage.getItem("tack-reader-editor")).toBe(value);
  await openMenu();
  expect(document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toBe(
    label,
  );
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount(path);
  expect(controls().link.textContent).toBe(`Open in ${label}`);
  expect(controls().link.getAttribute("href")).toBe(
    `${value}://file/repo/notes/00%3A19%20a%23b%3Fc%25d%C3%A9.mdx:1`,
  );
});

it("keeps the selected editor when the current document changes", async () => {
  await mount();
  await choose("Cursor");
  await mount("/repo/next.mdx");
  expect(controls().link.getAttribute("href")).toBe("cursor://file/repo/next.mdx:1");
});

it("falls back to Zed for an unsupported saved preference", async () => {
  localStorage.setItem("tack-reader-editor", "unsupported");
  await mount();
  expect(controls().link.textContent).toBe("Open in Zed");
});

it("allows editor selection when browser storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Storage unavailable", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage unavailable", "SecurityError");
  });
  await mount();
  await choose("VSCode");
  expect(controls().link.getAttribute("href")).toBe("vscode://file/repo/page.mdx:1");
});

it("disables opening when there is no current document", async () => {
  await act(async () => root.render(createElement(EditorControl, { path: undefined })));
  expect(controls().link.hasAttribute("href")).toBe(false);
  expect(controls().link.getAttribute("aria-disabled")).toBe("true");
});
