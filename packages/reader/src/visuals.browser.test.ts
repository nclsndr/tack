// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chart, Walkthrough } from "./visuals.tsx";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({ router: "retained" }, "", "/guide#part");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const element = [...container.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  if (element === undefined) throw new Error(`Missing button: ${label}`);
  return element;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function change(element: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function restore(url: string): Promise<void> {
  await act(async () => {
    window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

describe("reproducible visual interactions", () => {
  it("replays walkthrough URL state on popstate and retains router history data", async () => {
    await act(async () =>
      root.render(
        createElement(Walkthrough, {
          id: "flow",
          steps: [
            { title: "Register", body: "Sources" },
            { title: "Apply", body: "Links" },
          ],
        }),
      ),
    );
    expect(button("Previous step").disabled).toBe(true);
    await click(button("Next step"));
    expect(window.location.search).toBe("?reader.flow.step=2");
    expect(window.location.hash).toBe("#part");
    expect(window.history.state).toEqual({ router: "retained" });
    expect(container.querySelector('section[aria-label="Apply"]')?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(button("Next step").disabled).toBe(true);
    await click(button("Previous step"));
    expect(window.location.search).toBe("?reader.flow.step=1");
    await click(button("2. Apply"));
    await restore("/guide?reader.flow.step=1#part");
    expect(container.querySelector('section[aria-label="Register"]')?.hasAttribute("hidden")).toBe(
      false,
    );
    await restore("/guide?reader.flow.step=999#part");
    expect(container.querySelector("figure")?.getAttribute("data-reader-state")).toBe('{"step":2}');
  });

  it("copies chart scenario and parameter effects from the displayed values", async () => {
    await act(async () =>
      root.render(
        createElement(Chart, {
          id: "cost",
          data: [
            { label: "Page", value: 10 },
            { label: "Shared setup", value: 40 },
          ],
          unit: "lines",
          scenarios: [
            { id: "base", label: "Baseline", multiplier: 1 },
            { id: "double", label: "Double", multiplier: 2 },
          ],
        }),
      ),
    );
    const scenario = container.querySelector<HTMLSelectElement>("select");
    const scale = container.querySelectorAll<HTMLSelectElement>("select")[1];
    const bar = container.querySelector('[aria-label="Page: 10 lines"]');
    if (scenario === null || scale === undefined || bar === null)
      throw new Error("Expected chart controls");
    await change(scenario, "double");
    expect(window.location.search).toContain("reader.cost.scenario=double");
    expect(container.querySelector("figure")?.getAttribute("data-reader-readable")).toContain(
      "Page: 20 lines",
    );
    await change(scale, "sqrt");
    expect(window.location.search).toContain("reader.cost.scale=sqrt");
    expect(bar.querySelectorAll("rect")[1]?.getAttribute("width")).toBe("180");
    await click(bar);
    expect(window.location.search).toContain("reader.cost.selected=Page");
    await click(bar);
    expect(window.location.search).not.toContain("selected");
    await act(async () => {
      bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(window.location.search).toContain("reader.cost.selected=Page");
    await act(async () => {
      bar.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(window.location.search).not.toContain("selected");
    await act(async () => {
      bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => {
      bar.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await act(async () => {
      bar.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    await act(async () => {
      bar.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    await act(async () => {
      bar.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await restore(
      "/guide?reader.cost.multiplier=1.5&reader.cost.scenario=double&reader.cost.scale=sqrt&reader.cost.selected=Page",
    );
    expect(container.querySelector("figure")?.getAttribute("data-reader-readable")).toContain(
      "Page: 30 lines",
    );
    expect(container.querySelector("figure")?.getAttribute("data-reader-state")).toBe(
      '{"scenario":"double","multiplier":1.5,"scale":"sqrt","selected":"Page"}',
    );
    const input = container.querySelector<HTMLInputElement>('input[type="range"]');
    if (input === null) throw new Error("Expected multiplier control");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(window.location.search).toContain("reader.cost.multiplier=2");
  });
});
