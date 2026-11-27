// @vitest-environment jsdom
import { act, createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { links as tackLinks } from "../../fixtures/figures/cli-imports.ts";
import { interactionContext } from "../browser.ts";
import { ArchitectureMap } from "./architecture-map.tsx";
import type { ArchitectureMapProps } from "./architecture-map-model.ts";
import { architectureMapIssues } from "./catalog.ts";
import { issueLine } from "./issues.ts";
import { testRoot } from "../react.test-support.ts";

const ui = testRoot();

beforeEach(() => {
  window.history.replaceState(null, "", "/map");
});

const small: ArchitectureMapProps = {
  id: "web-map",
  title: "A page never reads the database: it asks an API route",
  summary: "Each box is one folder.",
  rule: { title: "Imports point down", text: "An import points down the map." },
  tiers: [
    { id: "pages", label: "Pages", path: "pages/", nodes: [{ id: "home", label: "pages/home" }] },
    [
      {
        id: "api",
        label: "API",
        nodes: [{ id: "orders", label: "orders", detail: "route", about: "Owns every query." }],
      },
      { id: "jobs", label: "Jobs", nodes: [{ id: "billing", label: "billing" }] },
    ],
    { id: "data", label: "Data", nodes: [{ id: "db", label: "db" }] },
  ],
  barriers: [{ between: ["api", "jobs"], label: "share nothing" }],
  links: [
    { from: "home", to: "orders", label: "POST" },
    { from: "orders", to: "db", label: "INSERT" },
    { from: "billing", to: "db" },
  ],
  startWith: ["home"],
  replays: [
    {
      id: "order",
      label: "Place an order",
      steps: [
        { at: "home", note: "Posts the form." },
        { at: "orders", note: "Opens a transaction." },
        { at: "db", note: "Inserts the row." },
      ],
    },
  ],
  lenses: [
    {
      id: "db-down",
      label: "Database down",
      note: "Orders fail.",
      focus: ["orders"],
      blocked: ["db"],
    },
  ],
};

async function render(props: ArchitectureMapProps): Promise<void> {
  await ui.render(createElement(ArchitectureMap, props));
}

const box = (label: string): SVGGElement => {
  const element = ui.container.querySelector<SVGGElement>(`g.tack-map-box[aria-label^="${label}"]`);
  if (element === null) throw new Error(`Missing box ${label}`);
  return element;
};
const button = (text: string): HTMLButtonElement => {
  const element = [...ui.container.querySelectorAll("button")].find(
    (item) => item.textContent === text || item.firstChild?.textContent === text,
  );
  if (element === undefined) throw new Error(`Missing button ${text}`);
  return element;
};
const required = (selector: string): Element => {
  const found = ui.container.querySelector(selector);
  if (found === null) throw new Error(`Missing ${selector}`);
  return found;
};
const figure = (): HTMLElement => {
  const element = ui.container.querySelector("figure");
  if (element === null) throw new Error("Missing figure");
  return element;
};
async function fire(element: Element, event: Event): Promise<void> {
  await act(async () => {
    element.dispatchEvent(event);
  });
}
const click = (element: Element) => fire(element, new MouseEvent("click", { bubbles: true }));
const key = (element: Element, value: string) =>
  fire(element, new KeyboardEvent("keydown", { key: value, bubbles: true }));
const links = () =>
  [...ui.container.querySelectorAll("path.tack-map-link")].map((path) =>
    path.getAttribute("data-kind"),
  );

describe("ArchitectureMap", () => {
  it("draws boxes and no links at rest, on the architecture ground, as text on the page", async () => {
    await render(small);
    expect(figure().getAttribute("data-ground")).toBe("quad-ruled");
    expect(figure().getAttribute("data-card")).toBe("none");
    expect(figure().querySelector("figcaption")?.textContent).toBe(small.title);
    expect(ui.container.querySelectorAll("g.tack-map-box")).toHaveLength(4);
    expect(links()).toEqual([]);
    expect(ui.container.querySelector(".tack-map-wall text")?.textContent).toBe("share nothing");
    expect(ui.container.querySelector(".tack-figure-issues")).toBeNull();
    expect(ui.container.textContent).toContain("Point at a box to see its links.");
  });

  it("previews a box on pointer and keyboard focus, and pins it in the URL", async () => {
    await render(small);
    await fire(box("orders"), new MouseEvent("mouseover", { bubbles: true }));
    expect(box("orders").getAttribute("data-ink")).toBe("focus");
    expect(box("pages/home").getAttribute("data-ink")).toBe("near");
    expect(box("billing").getAttribute("data-ink")).toBe("off");
    expect(links().toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual(["in", "out"]);
    await fire(box("orders"), new MouseEvent("mouseout", { bubbles: true }));
    expect(links()).toEqual([]);
    await fire(box("pages/home"), new FocusEvent("focusin", { bubbles: true }));
    expect(links()).toEqual(["out", "onward"]);
    await key(box("pages/home"), "Enter");
    await fire(box("pages/home"), new FocusEvent("focusout", { bubbles: true }));
    expect(window.location.search).toBe("?reader.web-map.pin=home");
    expect(box("pages/home").getAttribute("aria-pressed")).toBe("true");
    expect(ui.container.textContent).toContain("Pinned, in Pages");
    expect(interactionContext(figure()).state).toEqual({
      "web-map": { pin: "home", case: null, step: null },
    });
    expect(interactionContext(figure()).readable).toContain("View: pinned pages/home");
    await click(button("orders"));
    expect(window.location.search).toBe("?reader.web-map.pin=orders");
    expect(ui.container.textContent).toContain("Owns every query.");
    await key(box("orders"), "Escape");
    expect(window.location.search).toBe("");
    await click(button("pages/home"));
    await click(required("svg.tack-map"));
    expect(window.location.search).toBe("");
    await key(box("db"), " ");
    await key(box("db"), "Enter");
    await key(box("db"), "a");
    expect(window.location.search).toBe("");
  });

  it("walks a replay with badges, a path drawn once and the step in the URL", async () => {
    await render(small);
    await click(button("Place an order"));
    expect(window.location.search).toBe("?reader.web-map.case=order&reader.web-map.step=1");
    expect(button("Previous").disabled).toBe(true);
    await click(button("Next"));
    await click(button("Next"));
    expect(button("Next").disabled).toBe(true);
    expect(ui.container.querySelector(".tack-figure-count")?.textContent).toBe("Step 3 of 3");
    expect(
      [...ui.container.querySelectorAll(".tack-map-badge text")].map((text) => text.textContent),
    ).toEqual(["1", "2", "3"]);
    expect(links()).toEqual(["step", "step"]);
    expect(box("db").getAttribute("data-ink")).toBe("focus");
    expect(box("billing").getAttribute("data-ink")).toBe("dim");
    expect(ui.container.textContent).toContain("Inserts the row.");
    expect(interactionContext(figure()).state).toEqual({
      "web-map": { pin: null, case: "order", step: 3 },
    });
    await fire(box("billing"), new MouseEvent("mouseover", { bubbles: true }));
    expect(box("billing").getAttribute("data-ink")).toBe("focus");
    expect(window.location.search).toContain("case=order");
    await fire(box("billing"), new MouseEvent("mouseout", { bubbles: true }));
    await click(button("Previous"));
    expect(window.location.search).toContain("step=2");
    await click(button("Place an order"));
    expect(window.location.search).toBe("");
  });

  it("shows a lens with its note and a hatched blocked box", async () => {
    await render(small);
    await click(button("Database down"));
    expect(box("orders").getAttribute("data-ink")).toBe("near");
    expect(box("db").getAttribute("data-ink")).toBe("blocked");
    expect(box("db").querySelector(".tack-map-blocked")).not.toBeNull();
    expect(box("pages/home").getAttribute("data-ink")).toBe("off");
    expect(ui.container.textContent).toContain("Orders fail.");
    expect(interactionContext(figure()).readable).toContain("View: lens Database down");
    const legend = [...ui.container.querySelectorAll(".tack-figure-legend li")].map(
      (item) => item.textContent,
    );
    expect(legend).toEqual(
      expect.arrayContaining(["Pages", "uses", "used by", "replay path", "blocked"]),
    );
  });

  it("opens the drawing in an overlay with the panel beside it, and Escape returns focus", async () => {
    await render(small);
    const expand = button("Expand");
    await click(expand);
    const overlay = ui.container.querySelector(".tack-figure-overlay");
    expect(overlay?.getAttribute("role")).toBe("dialog");
    expect(ui.container.querySelectorAll("svg.tack-map")).toHaveLength(2);
    expect(overlay?.querySelector(".tack-figure-panel")).not.toBeNull();
    await key(required(".tack-figure-overlay"), "Escape");
    expect(ui.container.querySelector(".tack-figure-overlay")).toBeNull();
    expect(document.activeElement).toBe(expand);
    await click(button("Expand"));
    await click(button("Close"));
    expect(ui.container.querySelector(".tack-figure-overlay")).toBeNull();
  });

  it("bundles a hub's links per tier and lists every one in the panel", async () => {
    window.history.replaceState(null, "", "/map?reader.cli-map.pin=cli-host");
    const ids = [...new Set(tackLinks.flatMap((link) => [link.from, link.to]))];
    const tier = (id: string) => ({
      id,
      label: id,
      nodes: ids
        .filter((node) => node.startsWith(`${id}-`) || node === id)
        .map((node) => ({ id: node, label: node })),
    });
    await render({
      id: "cli-map",
      title: "Every tier imports only the tiers below it",
      rule: { title: "Imports point down", text: "Down only." },
      tiers: [
        tier("bootstrap"),
        tier("cli"),
        [tier("features"), tier("platform")],
        tier("services"),
        tier("domain"),
      ],
      links: tackLinks,
    });
    expect(links().filter((kind) => kind === "bundle")).toHaveLength(3);
    expect(
      [...ui.container.querySelectorAll(".tack-map-link-label")].map((label) => label.textContent),
    ).toEqual(expect.arrayContaining(["16 uses", "7 uses", "13 uses"]));
    expect(ui.container.textContent).toContain("Uses 37");
  });

  it("bundles a hub's incoming links from another tier as its users", async () => {
    window.history.replaceState(null, "", "/map?reader.users-map.pin=hub");
    const callers = Array.from({ length: 25 }, (_, index) => `caller-${index + 1}`);
    await render({
      id: "users-map",
      title: "Every caller imports the one core hub",
      rule: { title: "Imports point down", text: "Down only." },
      tiers: [
        { id: "callers", label: "Callers", nodes: callers.map((id) => ({ id, label: id })) },
        { id: "core", label: "Core", nodes: [{ id: "hub", label: "hub" }] },
      ],
      links: callers.map((from) => ({ from, to: "hub" })),
    });
    expect(links()).toEqual(["bundle"]);
    expect(
      [...ui.container.querySelectorAll(".tack-map-link-label")].map((label) => label.textContent),
    ).toEqual(["25 users"]);
  });

  it("renders what it can and lists the same issues the figure check prints", async () => {
    const broken = {
      ...small,
      title: "CLI architecture",
      links: [
        ...small.links,
        { from: "db", to: "home" },
        { from: "orders", to: "billing" },
        { from: "x", to: "db" },
      ],
    };
    await render(broken);
    const listed = [...ui.container.querySelectorAll(".tack-figure-issues li")].map(
      (item) => item.textContent,
    );
    expect(listed).toEqual(architectureMapIssues(broken).map(issueLine));
    expect(listed).toHaveLength(4);
    await fire(box("db"), new MouseEvent("mouseover", { bubbles: true }));
    expect(ui.container.querySelector('path.tack-map-link[data-warning="up"]')).not.toBeNull();
    const legend = [...ui.container.querySelectorAll(".tack-figure-legend li")].map(
      (item) => item.textContent,
    );
    expect(legend).toContain("against the rule");
  });
});
