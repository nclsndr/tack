// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { CopyControl } from "./copy-control.tsx";
import { pressKey, settle } from "./popover.test-support.ts";
import type { CopyMode } from "./types.ts";
import { testRoot } from "./react.test-support.ts";

const ui = testRoot();
const copy = vi.fn();
const modes = vi.fn();
const implementations = vi.fn();

afterEach(() => {
  vi.clearAllMocks();
});

/** Owns the copy settings the way the reader does, reporting each change to the spies. */
function Harness({ selectedBlocks }: { selectedBlocks: number }) {
  const [mode, setMode] = useState<CopyMode>("readable");
  const [include, setInclude] = useState(false);
  return createElement(CopyControl, {
    selectedBlocks,
    onCopy: copy,
    mode,
    onModeChange: (next: CopyMode) => {
      modes(next);
      setMode(next);
    },
    includeImplementations: include,
    onIncludeImplementationsChange: (next: boolean) => {
      implementations(next);
      setInclude(next);
    },
  });
}

async function mount(selectedBlocks = 0) {
  await ui.render(createElement(Harness, { selectedBlocks }));
}

function parts() {
  const [primary, chevron] = Array.from(ui.container.querySelectorAll("button"));
  if (primary === undefined || chevron === undefined) throw new Error("Missing split button parts");
  return { primary, chevron, open: chevron.getAttribute("aria-expanded") === "true" };
}

/** The accessible name an element takes from the elements its `aria-labelledby` points at. */
function labelled(element: Element, attribute = "aria-labelledby"): string {
  return (element.getAttribute(attribute) ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

/** The open menu's items, which render in a portal outside the container. */
const formats = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
const toggle = () => document.querySelector<HTMLElement>('[role="menuitemcheckbox"]');

async function openMenu() {
  await act(async () => parts().chevron.focus());
  await act(async () => parts().chevron.click());
  await settle();
}

function format(name: string): HTMLElement {
  const item = formats().find((candidate) => labelled(candidate) === name);
  if (item === undefined) throw new Error(`Missing format: ${name}`);
  return item;
}

it("joins the copy action and a chevron-only menu trigger under distinct names", async () => {
  await mount();
  const { primary, chevron } = parts();
  expect(primary.parentElement).toBe(chevron.parentElement);
  expect(primary.parentElement?.getAttribute("role")).toBe("group");
  expect(primary.parentElement?.getAttribute("aria-label")).toBe("Copy");
  expect(primary.textContent).toBe("Copy selection");
  expect(primary.querySelector("svg")).toBeNull();
  expect(chevron.textContent).toBe("");
  expect(chevron.querySelector("svg")).not.toBeNull();
  expect(chevron.getAttribute("aria-label")).toBe("Copy format: Readable + sources");
  expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
  expect(parts().open).toBe(false);
});

it("copies on the primary part and keeps the text selection when pressed", async () => {
  await mount();
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  await act(async () => {
    parts().primary.dispatchEvent(down);
  });
  expect(down.defaultPrevented).toBe(true);
  await act(async () => parts().primary.click());
  expect(copy).toHaveBeenCalledOnce();
  expect(parts().open).toBe(false);
});

it("counts the selected blocks and marks both parts ready together", async () => {
  await mount(2);
  expect(parts().primary.textContent).toBe("Copy selection2 blocks");
  expect(parts().primary.dataset["ready"]).toBe("true");
  expect(parts().chevron.dataset["ready"]).toBe("true");
  await mount(1);
  expect(parts().primary.textContent).toBe("Copy selection1 block");
  await mount(0);
  expect(parts().primary.dataset["ready"]).toBe("false");
  expect(parts().chevron.dataset["ready"]).toBe("false");
});

it("lists every format with a one-line description and checks the current one", async () => {
  await mount();
  await openMenu();
  expect(parts().open).toBe(true);
  expect(formats().map((item) => labelled(item))).toEqual([
    "Readable + sources",
    "Raw source",
    "References only",
  ]);
  expect(formats().every((item) => labelled(item, "aria-describedby").length > 0)).toBe(true);
  expect(formats().map((item) => item.getAttribute("aria-checked"))).toEqual([
    "true",
    "false",
    "false",
  ]);
  expect(format("Readable + sources").querySelector("svg")).not.toBeNull();
  expect(format("Raw source").querySelector("svg")).toBeNull();
  expect(labelled(toggle() ?? document.body)).toBe("Include component implementation");
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  expect(toggle()?.querySelector("svg")).toBeNull();
});

it.each([
  ["Raw source", "raw"],
  ["References only", "reference"],
])("chooses %s, closes the menu and returns focus to the chevron", async (name, value) => {
  await mount();
  await openMenu();
  await act(async () => format(name).click());
  await settle();
  expect(modes).toHaveBeenCalledWith(value);
  expect(parts().open).toBe(false);
  expect(formats()).toEqual([]);
  expect(document.activeElement).toBe(parts().chevron);
  expect(parts().chevron.getAttribute("aria-label")).toBe(`Copy format: ${name}`);
  await openMenu();
  expect(format(name).getAttribute("aria-checked")).toBe("true");
});

it("toggles component implementation in place, keeping the menu open", async () => {
  await mount();
  await openMenu();
  await act(async () => toggle()?.click());
  await settle();
  expect(implementations).toHaveBeenLastCalledWith(true);
  expect(parts().open).toBe(true);
  expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  expect(toggle()?.querySelector("svg")).not.toBeNull();
  await act(async () => toggle()?.click());
  await settle();
  expect(implementations).toHaveBeenLastCalledWith(false);
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
});

it("opens from the keyboard, moves through the options and closes on Escape to the chevron", async () => {
  await mount();
  await act(async () => parts().chevron.focus());
  await pressKey(parts().chevron, "ArrowDown");
  expect(parts().open).toBe(true);
  const first = document.activeElement;
  expect(formats()).toContain(first);
  await pressKey(document.activeElement, "ArrowDown");
  expect(document.activeElement).not.toBe(first);
  await pressKey(document.activeElement, "Escape");
  expect(parts().open).toBe(false);
  expect(formats()).toEqual([]);
  expect(document.activeElement).toBe(parts().chevron);
  expect(copy).not.toHaveBeenCalled();
});
