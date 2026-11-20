// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { press, pressKey, settle, tabOut } from "../popover.test-support.ts";
import { FigureFrame } from "./frame.tsx";

let container: HTMLDivElement;
let root: Root;
const onEscape = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onEscape.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        "div",
        null,
        createElement("button", { type: "button" }, "Before"),
        createElement(FigureFrame, {
          id: "deploy",
          kind: "system",
          title: "A deploy never skips the queue",
          issues: [],
          readable: "Deploy figure",
          state: {},
          onEscape,
          controls: createElement("button", { type: "button" }, "Lens"),
          drawing: (mode: "column" | "expanded") =>
            createElement("button", { type: "button", "data-mode": mode }, `Box ${mode}`),
        }),
        createElement("button", { type: "button" }, "After"),
      ),
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(name: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === name,
  );
  if (found === undefined) throw new Error(`Missing button: ${name}`);
  return found;
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
async function expand(): Promise<HTMLButtonElement> {
  const trigger = button("Expand");
  await act(async () => trigger.focus());
  await act(async () => trigger.click());
  await settle();
  return trigger;
}

it("opens the drawing as a modal dialog named by the figure's claim, inside the figure", async () => {
  expect(button("Expand").getAttribute("aria-haspopup")).toBe("dialog");
  await expand();
  const opened = dialog();
  expect(opened?.getAttribute("aria-modal")).toBe("true");
  expect(opened?.getAttribute("aria-label")).toBe("A deploy never skips the queue");
  expect(opened?.classList.contains("tack-figure-overlay")).toBe(true);
  expect(document.getElementById("deploy")?.contains(opened ?? null)).toBe(true);
  expect(opened?.querySelector('[data-mode="expanded"]')).not.toBeNull();
  expect(opened?.contains(document.activeElement)).toBe(true);
  expect(button("Expand").getAttribute("aria-expanded")).toBe("true");
  // The page behind the dialog leaves the accessibility tree, the column drawing included.
  expect(button("Before").closest('[aria-hidden="true"]')).not.toBeNull();
  expect(button("Box column").closest('[aria-hidden="true"]')).not.toBeNull();
  expect(opened?.closest('[aria-hidden="true"]')).toBeNull();
});

it("keeps keyboard focus inside the dialog when Tab passes its last control", async () => {
  await expand();
  const opened = dialog();
  if (opened === null) throw new Error("Missing dialog");
  button("Box expanded").focus();
  await tabOut(opened);
  expect(dialog()).not.toBeNull();
  expect(opened.contains(document.activeElement)).toBe(true);
});

it("closes on Escape without releasing the pin, and returns focus to Expand", async () => {
  const trigger = await expand();
  await pressKey(document.activeElement, "Escape");
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(onEscape).not.toHaveBeenCalled();
  await pressKey(trigger, "Escape");
  expect(onEscape).toHaveBeenCalledTimes(1);
});

it("closes from its Close button and returns focus to Expand", async () => {
  const trigger = await expand();
  await act(async () => button("Close").click());
  await settle();
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("stays open on a press inside and closes on a press outside the drawing's sheet", async () => {
  await expand();
  const opened = dialog();
  if (opened === null) throw new Error("Missing dialog");
  await press(opened);
  expect(dialog()).not.toBeNull();
  await press(document.body);
  expect(dialog()).toBeNull();
});
