// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppearanceControl } from "./appearance.tsx";
import { testRoot } from "./react.test-support.ts";

const ui = testRoot();

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

async function mount() {
  await ui.render(createElement(AppearanceControl));
}

function button(label: string) {
  const selected = Array.from(ui.container.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (selected === undefined) throw new Error(`Missing appearance button: ${label}`);
  return selected;
}

it("offers system, light and dark and starts with the stored engine preference", async () => {
  localStorage.setItem("rspress-theme-appearance", "dark");
  await mount();
  expect(button("Dark").getAttribute("aria-pressed")).toBe("true");
  expect(button("System").getAttribute("aria-pressed")).toBe("false");
  expect(button("Light").getAttribute("aria-pressed")).toBe("false");
});

it("labels each icon-only choice with a tooltip instead of a native title", async () => {
  await mount();
  for (const label of ["System", "Light", "Dark"]) {
    expect(button(label).hasAttribute("title")).toBe(false);
    // Base UI marks a tooltip trigger; the tooltip itself renders only while shown.
    expect(button(label).getAttribute("data-reader-tooltip-trigger")).toBe(label);
    expect(button(label).querySelector("svg")?.getAttribute("stroke-width")).toBe(
      String((1.4 * 24) / 13),
    );
  }
});

it.each([null, "auto", "invalid"])("uses system for preference %s", async (preference) => {
  if (preference !== null) localStorage.setItem("rspress-theme-appearance", preference);
  await mount();
  expect(button("System").getAttribute("aria-pressed")).toBe("true");
});

it("persists each explicit choice and notifies the engine without reloading", async () => {
  await mount();
  const events: StorageEvent[] = [];
  const listener = (event: StorageEvent) => events.push(event);
  window.addEventListener("storage", listener);
  try {
    for (const [label, preference] of [
      ["Light", "light"],
      ["Dark", "dark"],
      ["System", "auto"],
    ]) {
      if (label === undefined || preference === undefined) throw new Error("Missing fixture");
      await act(async () => button(label).click());
      expect(button(label).getAttribute("aria-pressed")).toBe("true");
      expect(localStorage.getItem("rspress-theme-appearance")).toBe(preference);
      expect(events.at(-1)).toMatchObject({
        key: "rspress-theme-appearance",
        newValue: preference,
      });
    }
  } finally {
    window.removeEventListener("storage", listener);
  }
});

it("reflects preferences changed in another tab and removes its listener on unmount", async () => {
  await mount();
  await act(async () => {
    localStorage.setItem("rspress-theme-appearance", "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
  });
  expect(button("System").getAttribute("aria-pressed")).toBe("true");
  await act(async () =>
    window.dispatchEvent(new StorageEvent("storage", { key: "rspress-theme-appearance" })),
  );
  expect(button("Light").getAttribute("aria-pressed")).toBe("true");
  await act(async () => {
    localStorage.removeItem("rspress-theme-appearance");
    window.dispatchEvent(new StorageEvent("storage", { key: "rspress-theme-appearance" }));
  });
  expect(button("System").getAttribute("aria-pressed")).toBe("true");
  const remove = vi.spyOn(window, "removeEventListener");
  await ui.unmount();
  expect(remove).toHaveBeenCalledWith("storage", expect.any(Function));
  remove.mockRestore();
});
