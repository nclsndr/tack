// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { interactionContext } from "../browser.ts";
import {
  Badge,
  Band,
  Box,
  Drawing,
  Figure,
  type FigureProps,
  Label,
  Link,
  Note,
} from "./figure.tsx";
import { authoredFigureIssues } from "./catalog.ts";
import { issueLine } from "./issues.ts";
import { testRoot } from "../react.test-support.ts";

const ui = testRoot();

beforeEach(() => {
  window.history.replaceState(null, "", "/figure");
});

const frame: Omit<FigureProps, "children"> = {
  id: "pipeline",
  kind: "system",
  title: "Nothing outside staging/ changes until the gate passes",
  rule: { title: "Left to right", text: "Work moves right." },
  startWith: ["export"],
  legend: { dashed: "a copy", "tint-2": "writes outside staging/" },
  replays: [
    {
      id: "good",
      label: "A good update",
      steps: [
        { at: "export", note: "git archive into a clean tree." },
        { at: "gate", note: "The release is run for real." },
        { at: "swap", note: "current moves." },
      ],
    },
  ],
  lenses: [
    {
      id: "fails",
      label: "Gate fails",
      note: "Nothing moves.",
      focus: ["export"],
      broken: ["gate"],
      blocked: ["swap"],
    },
  ],
};

/** The drawing as an author writes it, with a fragment and one raw shape. */
const drawing = (extra: ReactNode = null): ReactNode =>
  createElement(
    Drawing,
    { height: 200 },
    createElement(Band, { x: 16, y: 12, w: 696, h: 176, label: "staging" }),
    createElement(
      Fragment,
      null,
      createElement(Box, {
        id: "export",
        x: 32,
        y: 60,
        label: "git archive",
        detail: "clean tree",
      }),
      createElement(Box, { id: "gate", x: 300, y: 60, label: "gate-release", about: "Runs it." }),
    ),
    createElement(Box, {
      id: "swap",
      x: 560,
      y: 60,
      label: "swap current",
      tint: 2,
      shape: "store",
    }),
    createElement(Link, { from: "export", to: "gate", label: "staging/" }),
    createElement(Link, { from: "gate", to: "swap", style: "dashed" }),
    createElement(Badge, { at: "export", n: 7 }),
    createElement(Note, { x: 300, y: 160, text: "held on failure", to: "gate" }),
    createElement(Label, { x: 32, y: 40, text: "Build", size: "small" }),
    createElement("path", { d: "M 600 150 h 40", className: "tank stroke-muted" }),
    extra,
  );

async function render(
  props: Omit<FigureProps, "children">,
  children: ReactNode = drawing(),
): Promise<void> {
  await ui.render(createElement(Figure, props, children));
}
const box = (id: string): SVGGElement => {
  const element = ui.container.querySelector<SVGGElement>(`g.tack-map-box[data-box="${id}"]`);
  if (element === null) throw new Error(`Missing box ${id}`);
  return element;
};
const button = (text: string): HTMLButtonElement => {
  const element = [...ui.container.querySelectorAll("button")].find(
    (item) => item.firstChild?.textContent === text,
  );
  if (element === undefined) throw new Error(`Missing button ${text}`);
  return element;
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
const links = () =>
  [...ui.container.querySelectorAll(".tack-map-links path")].map((path) =>
    path.getAttribute("data-kind"),
  );

describe("an authored figure", () => {
  it("draws its kit elements and raw SVG at rest, with links, a legend and its text equivalent", async () => {
    await render(frame);
    expect(figure().getAttribute("data-ground")).toBe("quad-ruled");
    expect(ui.container.querySelectorAll("g.tack-map-box")).toHaveLength(3);
    expect(box("swap").getAttribute("data-shape")).toBe("store");
    expect(box("swap").getAttribute("data-tint")).toBe("1");
    expect(links()).toEqual(["rest", "rest"]);
    expect(
      [...ui.container.querySelectorAll(".tack-map-link-label")].map((item) => item.textContent),
    ).toEqual(["staging/", "a copy"]);
    expect(ui.container.querySelector(".tack-kit-band text")?.textContent).toBe("staging");
    expect(ui.container.querySelector(".tack-kit-raw path.tank")).not.toBeNull();
    expect(ui.container.querySelector(".tack-kit-note line")).not.toBeNull();
    expect(ui.container.querySelector(".tack-kit-label")?.textContent).toBe("Build");
    expect(ui.container.querySelector(".tack-map-badge text")?.textContent).toBe("7");
    expect(
      [...ui.container.querySelectorAll(".tack-figure-legend li")].map((item) => item.textContent),
    ).toEqual(["writes outside staging/", "a copy", "replay path", "blocked", "broken"]);
    expect(interactionContext(figure()).readable).toContain(
      "git archive -> gate-release: staging/",
    );
    expect(ui.container.querySelector(".tack-figure-issues")).toBeNull();
  });

  it("previews and pins a box with no handler from its author", async () => {
    await render(frame);
    await fire(box("gate"), new MouseEvent("mouseover", { bubbles: true }));
    expect(box("gate").getAttribute("data-ink")).toBe("focus");
    expect(box("export").getAttribute("data-ink")).toBe("near");
    expect(links().toSorted((p, q) => String(p).localeCompare(String(q)))).toEqual(["in", "out"]);
    await fire(box("gate"), new MouseEvent("mouseout", { bubbles: true }));
    await click(box("gate"));
    expect(window.location.search).toBe("?reader.pipeline.pin=gate");
    expect(ui.container.textContent).toContain("Runs it.");
    expect(ui.container.textContent).toContain("Uses 1");
    expect(ui.container.textContent).toContain("Used by 1");
    await click(button("git archive"));
    expect(window.location.search).toBe("?reader.pipeline.pin=export");
    expect(interactionContext(figure()).readable).toContain("View: pinned git archive");
    await fire(box("export"), new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(window.location.search).toBe("");
  });

  it("walks a replay and shows a lens with broken and blocked boxes", async () => {
    await render(frame);
    await click(button("A good update"));
    await click(button("Next"));
    expect(window.location.search).toBe("?reader.pipeline.case=good&reader.pipeline.step=2");
    expect(box("gate").getAttribute("data-ink")).toBe("focus");
    expect(box("export").getAttribute("data-ink")).toBe("visited");
    expect(box("swap").getAttribute("data-ink")).toBe("dim");
    expect(links()).toEqual(["fade", "fade", "step"]);
    expect(ui.container.textContent).toContain("The release is run for real.");
    expect(interactionContext(figure()).readable).toContain(
      "View: replay A good update, step 2 of 3",
    );
    await click(button("Gate fails"));
    expect(box("gate").getAttribute("data-ink")).toBe("broken");
    expect(box("gate").querySelector(".tack-map-strike")).not.toBeNull();
    expect(box("swap").getAttribute("data-ink")).toBe("blocked");
    expect(box("export").getAttribute("data-ink")).toBe("near");
    expect(interactionContext(figure()).readable).toContain("View: lens Gate fails");
  });

  it("hides links at rest in a dense drawing and draws a focus's links only", async () => {
    const many = Array.from({ length: 13 }, (_, index) =>
      createElement(Box, {
        key: index,
        id: `b${index}`,
        x: 16 + (index % 6) * 116,
        y: 16 + Math.floor(index / 6) * 60,
        label: `b${index}`,
      }),
    );
    await render(
      { id: "dense", title: "Thirteen boxes hide their links at rest" },
      createElement(
        Drawing,
        { height: 200 },
        ...many,
        createElement(Link, { from: "b0", to: "b1", label: "uses" }),
        createElement(Link, { from: "b2", to: "b3", label: "uses" }),
      ),
    );
    expect(links()).toEqual([]);
    await fire(box("b0"), new MouseEvent("mouseover", { bubbles: true }));
    expect(links()).toEqual(["out"]);
  });

  it("hides every link of a dense drawing while a lens is shown", async () => {
    const many = Array.from({ length: 13 }, (_, index) =>
      createElement(Box, {
        key: index,
        id: `b${index}`,
        x: 16 + (index % 6) * 116,
        y: 16 + Math.floor(index / 6) * 60,
        label: `b${index}`,
      }),
    );
    await render(
      {
        id: "dense",
        title: "Thirteen boxes hide their links under a lens",
        lenses: [{ id: "first", label: "First box", note: "Only b0.", focus: ["b0"] }],
      },
      createElement(
        Drawing,
        { height: 200 },
        ...many,
        createElement(Link, { from: "b0", to: "b1", label: "uses" }),
      ),
    );
    await click(button("First box"));
    expect(box("b0").getAttribute("data-ink")).toBe("near");
    expect(box("b1").getAttribute("data-ink")).toBe("off");
    expect(links()).toEqual([]);
  });

  it("starts each note's leader at the end of its text nearest the box it points at", async () => {
    await render(
      {
        id: "notes",
        title: "Each note points at the box it explains",
        summary: "Three notes around one box.",
        legend: { store: "a store" },
      },
      createElement(
        Drawing,
        { height: 200 },
        "stray text is not a kit element",
        createElement(Box, { id: "a", x: 300, y: 80, label: "a", shape: "store", tint: 3 }),
        createElement(Box, { id: "b", x: 560, y: 80, label: "b", tint: 1 }),
        createElement(Link, { from: "a", to: "b" }),
        createElement(Note, { x: 32, y: 100, text: "left", to: "a" }),
        createElement(Note, { x: 640, y: 40, text: "right", to: "a" }),
        createElement(Note, { x: 320, y: 30, text: "a note above the box", to: "a" }),
        createElement(Note, { x: 32, y: 180, text: "a free note" }),
      ),
    );
    const leaders = [...ui.container.querySelectorAll(".tack-kit-note")].map((note) => {
      const line = note.querySelector("line");
      return line === null
        ? null
        : [Number(line.getAttribute("x1")), Number(line.getAttribute("y1"))];
    });
    expect(leaders).toHaveLength(4);
    const [left, right, above, free] = leaders;
    expect(left?.[0]).toBeGreaterThan(32);
    expect(left?.[1]).toBe(96);
    expect(right).toEqual([636, 36]);
    expect(above?.[1]).toBe(34);
    expect(free).toBeNull();
    expect(ui.container.querySelector(".tack-figure-summary")?.textContent).toBe(
      "Three notes around one box.",
    );
    expect(
      [...ui.container.querySelectorAll(".tack-figure-legend li")].map((item) => item.textContent),
    ).toEqual(["a store"]);
    expect(ui.container.querySelectorAll(".tack-map-link-label")).toHaveLength(0);
  });

  it("lists unlabelled links in a pinned box's details and releases the pin from the drawing", async () => {
    await render(
      { id: "plain", title: "Plain links connect three boxes" },
      createElement(
        Drawing,
        { height: 120 },
        createElement(Box, { id: "a", x: 32, y: 40, label: "first" }),
        createElement(Box, { id: "b", x: 300, y: 40, label: "second" }),
        createElement(Box, { id: "c", x: 560, y: 40, label: "third" }),
        createElement(Link, { from: "a", to: "b" }),
        createElement(Link, { from: "b", to: "c" }),
      ),
    );
    await click(box("b"));
    expect(window.location.search).toBe("?reader.plain.pin=b");
    expect(button("first")).not.toBeNull();
    expect(button("third")).not.toBeNull();
    const drawn = ui.container.querySelector('svg[role="group"]');
    if (drawn === null) throw new Error("Missing drawing");
    await click(drawn);
    expect(window.location.search).toBe("");
  });

  it("draws a box with a blank id but leaves it out of focus and pinning", async () => {
    await render(
      { id: "unnamed", title: "One named box and one unnamed box sit side by side" },
      createElement(
        Drawing,
        { height: 120 },
        createElement(Box, { id: "a", x: 32, y: 40, label: "named" }),
        createElement(Box, { id: "", x: 300, y: 40, label: "unnamed" }),
      ),
    );
    const unnamed = [...ui.container.querySelectorAll("g.tack-map-box")].find((item) =>
      item.textContent?.includes("unnamed"),
    );
    if (unnamed === undefined) throw new Error("Missing unnamed box");
    expect(unnamed.getAttribute("tabindex")).toBeNull();
    await click(unnamed);
    expect(window.location.search).toBe("");
    expect(box("a").getAttribute("tabindex")).toBe("0");
  });

  it("shows no details for a pinned box the drawing does not have", async () => {
    window.history.replaceState(null, "", "/figure?reader.pipeline.pin=gone");
    await render(frame);
    expect(ui.container.textContent).not.toContain("Uses 1");
    expect(box("gate").getAttribute("data-ink")).toBeNull();
    expect(links()).toEqual(["rest", "rest"]);
  });

  it("renders what it can and lists the same issues the figure check prints", async () => {
    const overlapping = createElement(Box, { id: "over", x: 40, y: 70, label: "over" });
    await render({ ...frame, title: "Broken" }, drawing(overlapping));
    const listed = [...ui.container.querySelectorAll(".tack-figure-issues li")].map(
      (item) => item.textContent,
    );
    expect(listed).toEqual([
      'input: title "Broken" reads as a noun phrase; write the claim the figure proves as a sentence',
      'layout: boxes "export" and "over" overlap',
    ]);
    expect(listed).toEqual(
      authoredFigureIssues({
        ...frame,
        title: "Broken",
        drawing: {
          height: 200,
          elements: [
            { element: "band", props: { x: 16, y: 12, w: 696, h: 176, label: "staging" } },
            {
              element: "box",
              props: { id: "export", x: 32, y: 60, label: "git archive", detail: "clean tree" },
            },
            { element: "box", props: { id: "gate", x: 300, y: 60, label: "gate-release" } },
            {
              element: "box",
              props: { id: "swap", x: 560, y: 60, label: "swap current", tint: 2, shape: "store" },
            },
            { element: "box", props: { id: "over", x: 40, y: 70, label: "over" } },
            { element: "link", props: { from: "export", to: "gate", label: "staging/" } },
            { element: "link", props: { from: "gate", to: "swap", style: "dashed" } },
          ],
        },
      }).map(issueLine),
    );
  });

  it("asks for a drawing when it has none, and a kit element alone draws nothing", async () => {
    await render(
      { id: "empty", title: "This figure forgot its drawing" },
      createElement("p", null, "text"),
    );
    expect(ui.container.textContent).not.toContain("How to read this");
    expect(
      [...ui.container.querySelectorAll(".tack-figure-issues li")].map((item) => item.textContent),
    ).toEqual(["input: the figure has no <Drawing height={...}>; give the drawing and its height"]);
    await ui.render(createElement(Box, { id: "a", x: 0, y: 0, label: "a" }));
    expect(ui.container.innerHTML).toBe("");
    await ui.render(createElement(Drawing, { height: 100 }));
    expect(ui.container.innerHTML).toBe("");
  });

  it("draws every box shape with the kit's outline", async () => {
    const shapes = ["plain", "store", "queue", "external", "actor", "sheet"] as const;
    await render(
      { id: "shapes", title: "Every shape the kit draws is here" },
      createElement(
        Drawing,
        { height: 80 },
        ...shapes.map((shape, index) =>
          createElement(Box, {
            key: shape,
            id: shape,
            x: 16 + index * 116,
            y: 16,
            label: shape,
            shape,
          }),
        ),
      ),
    );
    expect(shapes.map((shape) => box(shape).querySelectorAll(".tack-map-rim").length)).toEqual([
      0, 1, 3, 0, 0, 1,
    ]);
    expect(box("actor").querySelector("rect.tack-map-shape")?.getAttribute("rx")).toBe("16.5");
    expect(box("sheet").querySelector("path.tack-map-shape")).not.toBeNull();
  });
});
