// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interactionContext } from "../browser.ts";
import { pressKey, settle } from "../popover.test-support.ts";
import { House } from "lucide-react";
import { DocsIconSet } from "../icons/docs-icon.tsx";
import { Callout, Tab, Tabs, Term } from "./components.tsx";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => root.render(element));
  await settle();
}

describe("Callout", () => {
  it("marks its kind with an icon and a title, and copies as kind, title and text", async () => {
    await render(
      createElement(
        Callout,
        { kind: "warning", title: "Breaking" },
        createElement("p", null, "No aliases."),
      ),
    );
    const aside = container.querySelector("aside");
    expect(aside?.getAttribute("data-kind")).toBe("warning");
    expect(aside?.getAttribute("aria-label")).toBe("Warning: Breaking");
    expect(aside?.querySelector("svg.lucide-triangle-alert")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(interactionContext(container).readable).toBe("Warning: Breaking\nNo aliases.");
  });

  it("defaults to a note and names it by its kind without a title", async () => {
    await render(createElement(Callout, null, "Plain."));
    expect(container.querySelector("aside")?.getAttribute("aria-label")).toBe("Note");
    expect(container.querySelector("svg.lucide-info")).not.toBeNull();
    expect(interactionContext(container).readable).toBe("Note\nPlain.");
  });

  it("draws a named docs icon from the icon set in place of its kind's own", async () => {
    await render(
      createElement(
        DocsIconSet.Provider,
        { value: { house: House } },
        createElement(Callout, { kind: "tip", icon: "house" }),
      ),
    );
    expect(container.querySelector("aside svg.lucide-house")).not.toBeNull();
    expect(container.querySelector("aside svg.lucide-lightbulb")).toBeNull();
    expect(interactionContext(container).readable).toBe("Tip");
  });
});

describe("Tabs", () => {
  const tabs = () =>
    createElement(
      Tabs,
      null,
      createElement(Tab, { label: "npm" }, "npm install --global @tackup/cli"),
      createElement(Tab, { label: "Bun" }, "bun add --global @tackup/cli"),
    );
  const tab = (name: string) =>
    Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (candidate) => candidate.textContent === name,
    );

  it("shows the first tab, switches on a tab and with the arrow keys", async () => {
    await render(tabs());
    expect(tab("npm")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toBe(
      "npm install --global @tackup/cli",
    );
    await act(async () => tab("Bun")?.click());
    await settle();
    expect(container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toBe(
      "bun add --global @tackup/cli",
    );
    tab("Bun")?.focus();
    await pressKey(tab("Bun") ?? null, "ArrowLeft");
    expect(document.activeElement).toBe(tab("npm"));
  });

  it("finds Tabs that MDX wrapped in a paragraph", async () => {
    await render(
      createElement(
        Tabs,
        null,
        createElement(
          "p",
          null,
          createElement(Tab, { label: "One" }, "first"),
          createElement(Tab, { label: "Two" }, "second"),
        ),
      ),
    );
    expect(
      Array.from(container.querySelectorAll('[role="tab"]'), (item) => item.textContent),
    ).toEqual(["One", "Two"]);
  });

  it("shows a Tab outside Tabs as its content alone, and ignores text between tabs", async () => {
    await render(createElement(Tab, { label: "Alone" }, "only content"));
    expect(container.innerHTML).toBe("<div>only content</div>");
    await render(
      createElement(Tabs, null, "stray text", createElement(Tab, { label: "One" }, "first")),
    );
    expect(
      Array.from(container.querySelectorAll('[role="tab"]'), (item) => item.textContent),
    ).toEqual(["One"]);
  });

  it("copies every tab, each under its label, whichever is shown", async () => {
    await render(tabs());
    expect(interactionContext(container).readable).toBe(
      "npm\nnpm install --global @tackup/cli\n\nBun\nbun add --global @tackup/cli",
    );
  });
});

describe("Term", () => {
  it("defines a word on hover or focus, and keeps the definition in the text for screen readers", async () => {
    await render(createElement(Term, { title: "A folder of resources Tack reads" }, "source"));
    const dfn = container.querySelector("dfn");
    expect(dfn?.getAttribute("tabindex")).toBe("0");
    expect(dfn?.textContent).toBe("source (A folder of resources Tack reads)");
    expect(dfn?.querySelector(".sr-only")?.textContent).toBe(" (A folder of resources Tack reads)");
  });
});
