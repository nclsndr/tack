// @vitest-environment jsdom
import { act, createElement } from "react";
import { beforeEach, expect, it } from "vitest";
import { menuPanel, menuTrigger, ReaderPopover } from "./menu.tsx";
import { press, pressKey, settle, tabOut } from "./popover.test-support.ts";
import { testRoot } from "./react.test-support.ts";

const ui = testRoot();
beforeEach(async () => {
  await ui.render(
    createElement(
      "div",
      null,
      createElement(ReaderPopover, {
        summary: "Options",
        summaryClassName: menuTrigger,
        panelClassName: menuPanel,
        children: createElement("input", { "aria-label": "Option" }),
      }),
      createElement(ReaderPopover, {
        summary: "Other",
        summaryClassName: menuTrigger,
        panelClassName: menuPanel,
        children: createElement("input", { "aria-label": "Other option" }),
      }),
      createElement("button", { type: "button" }, "Outside"),
    ),
  );
});
function trigger(name: string): HTMLButtonElement {
  const found = Array.from(ui.container.querySelectorAll("button")).find(
    (button) => button.textContent === name,
  );
  if (found === undefined) throw new Error(`Missing trigger: ${name}`);
  return found;
}
/** The open panel, which Base UI renders in a portal outside the trigger's container. */
const panel = () => document.querySelector<HTMLElement>('[role="dialog"]');
const input = (label: string) =>
  document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
async function open(name: string) {
  await act(async () => trigger(name).click());
  await settle();
}

it("starts closed with a button trigger that names the panel it opens", () => {
  expect(trigger("Options").getAttribute("aria-expanded")).toBe("false");
  expect(trigger("Options").getAttribute("aria-haspopup")).toBe("dialog");
  expect(panel()).toBeNull();
});

it("opens a floating panel on the trigger and moves keyboard focus into it", async () => {
  await open("Options");
  expect(trigger("Options").getAttribute("aria-expanded")).toBe("true");
  expect(panel()?.contains(input("Option"))).toBe(true);
  expect(panel()?.contains(document.activeElement)).toBe(true);
  expect(ui.container.contains(panel())).toBe(false);
});

it("keeps the panel open for inside interaction and closes on an outside pointer", async () => {
  await open("Options");
  const option = input("Option");
  if (option === null) throw new Error("Missing option");
  await press(option);
  expect(panel()).not.toBeNull();
  await press(document.body);
  expect(panel()).toBeNull();
  expect(trigger("Options").getAttribute("aria-expanded")).toBe("false");
});

it("closes on Escape and restores keyboard focus to the trigger", async () => {
  await open("Options");
  input("Option")?.focus();
  await pressKey(document.activeElement, "Escape");
  expect(panel()).toBeNull();
  expect(document.activeElement).toBe(trigger("Options"));
});

it("dismisses when keyboard focus tabs out of the panel, on to the next control", async () => {
  await act(async () => trigger("Options").focus());
  await open("Options");
  const opened = panel();
  if (opened === null) throw new Error("Missing panel");
  await tabOut(opened);
  expect(panel()).toBeNull();
  expect(document.activeElement).toBe(trigger("Other"));
});

it("opens one reader popover at a time", async () => {
  await open("Options");
  await press(trigger("Other"));
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(panel()?.contains(input("Other option"))).toBe(true);
});
