// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pressKey, settle } from "./popover.test-support.ts";
import { ReaderTooltip } from "./tooltip.tsx";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const ref = createRef<HTMLButtonElement>();
const onClick = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onClick.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ReaderTooltip, {
        label: "Hide documents (⌘B)",
        children: createElement("button", {
          ref,
          type: "button",
          "aria-label": "Hide documents",
          onClick,
        }),
      }),
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tip = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-reader-tooltip]")).at(0) ?? null;

async function hover(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent("pointerenter", { bubbles: false, pointerType: "mouse" }),
    );
    target.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
}

it("keeps the trigger's own name, ref and handlers, and shows no native title", async () => {
  const button = ref.current;
  if (button === null) throw new Error("Missing trigger");
  expect(button.getAttribute("aria-label")).toBe("Hide documents");
  expect(button.hasAttribute("title")).toBe(false);
  expect(button.getAttribute("data-reader-tooltip-trigger")).toBe("Hide documents (⌘B)");
  await act(async () => button.click());
  expect(onClick).toHaveBeenCalledOnce();
  expect(tip()).toBeNull();
});

it("shows its label after hovering the trigger and hides it on Escape", async () => {
  const button = ref.current;
  if (button === null) throw new Error("Missing trigger");
  await hover(button);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  await settle();
  expect(tip()?.textContent).toBe("Hide documents (⌘B)");
  await pressKey(button, "Escape");
  expect(tip()).toBeNull();
});
