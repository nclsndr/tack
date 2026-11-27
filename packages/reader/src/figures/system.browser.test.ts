// @vitest-environment jsdom
import { resolve } from "node:path";
import { act, createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { interactionContext } from "../browser.ts";
import { System } from "./system.tsx";
import type { SystemProps } from "./system-model.ts";
import { capturePath } from "./system-fixtures.ts";
import { checkFigures, staticFigures } from "./check.ts";
import { NotStatic } from "./static-props.ts";
import { testRoot, waitForReact } from "../react.test-support.ts";

const ui = testRoot();

beforeEach(() => {
  window.history.replaceState(null, "", "/system");
});

const props = {
  ...capturePath,
  rule: { title: "Links follow the data", text: "A link points the way an event moves." },
  startWith: ["redis"],
} satisfies SystemProps;

/** Renders a `System` and waits until its drawing is laid out. */
async function render(input: SystemProps = props): Promise<HTMLElement> {
  await ui.render(createElement(System, input));
  // The first layout loads the engine, which can take a few seconds on a busy machine.
  await waitForReact(
    () => {
      expect(ui.container.querySelector(".tack-system svg.tack-map")).not.toBeNull();
    },
    { timeout: 15_000 },
  );
  const figure = ui.container.querySelector<HTMLElement>("figure.tack-figure");
  if (figure === null) throw new Error("no figure");
  return figure;
}

const box = (id: string): SVGGElement => {
  const found = ui.container.querySelector<SVGGElement>(`.tack-map-box[data-box="${id}"]`);
  if (found === null) throw new Error(`no box ${id}`);
  return found;
};
const link = (id: string): SVGPathElement => {
  const found = ui.container.querySelector<SVGPathElement>(`.tack-map-link[data-link="${id}"]`);
  if (found === null) throw new Error(`no link ${id}`);
  return found;
};
const chip = (name: string): HTMLButtonElement => {
  const found = [...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
};
const click = async (element: Element): Promise<void> => {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};

describe("System", () => {
  it("draws each kind by its shape, groups as tinted regions, and every link at rest", async () => {
    const figure = await render();
    expect(figure.dataset["figureKind"]).toBe("system");
    expect(figure.dataset["ground"]).toBe("quad-ruled");
    expect(
      ["feed", "collector", "redis", "consumer", "pg"].map((id) => box(id).dataset["shape"]),
    ).toEqual(["external", "plain", "queue", "plain", "store"]);
    expect(box("collector").dataset["tint"]).toBe("0");
    expect(box("feed").dataset["tint"]).toBeUndefined();
    expect(ui.container.querySelector(".tack-system-group text")?.textContent).toBe(
      "worker-browser (untrusted)",
    );
    expect(box("pg").querySelector(".tack-map-line")?.textContent).toBe("public.parcel_events");
    expect(
      [...ui.container.querySelectorAll<SVGPathElement>(".tack-map-links .tack-map-link")].map(
        (path) => [path.dataset["link"], path.dataset["kind"], path.dataset["style"]],
      ),
    ).toEqual([
      ["capture", "rest", "solid"],
      ["xadd", "rest", "solid"],
      ["read", "rest", "solid"],
      ["insert", "rest", "solid"],
      ["ack", "rest", "muted"],
    ]);
    // No right angle: every link is one cubic curve.
    for (const path of ui.container.querySelectorAll(".tack-map-links .tack-map-link"))
      expect(path.getAttribute("d")).toMatch(/^M [\d.-]+ [\d.-]+ C [^LHV]+$/);
    expect(
      [...ui.container.querySelectorAll(".tack-map-link-label")].map((label) => label.textContent),
    ).toEqual(["parcel events", "XADD", "XREADGROUP", "INSERT", "ack + delete"]);
    expect(
      [...ui.container.querySelectorAll(".tack-figure-legend li")].map((item) => item.textContent),
    ).toEqual([
      "worker-browser (untrusted)",
      "service",
      "store",
      "queue",
      "external",
      "call",
      "reply",
      "replay path",
      "broken",
    ]);
  });

  it("keeps the style of a link's kind when focus changes its ink", async () => {
    await render({
      ...props,
      links: props.links.map((item) =>
        item.id === "read" ? { ...item, kind: "async" as const } : item,
      ),
    });
    expect(link("read").dataset["style"]).toBe("dashed");
    await click(box("consumer"));
    expect(link("read").dataset).toMatchObject({ kind: "in", style: "dashed" });
    expect(link("insert").dataset).toMatchObject({ kind: "out", style: "solid" });
    expect(link("ack").dataset).toMatchObject({ kind: "out", style: "muted" });
    expect(link("capture").dataset["kind"]).toBe("fade");
    expect(box("consumer").dataset["ink"]).toBe("focus");
    expect(box("redis").dataset["ink"]).toBe("near");
    expect(box("feed").dataset["ink"]).toBe("off");
    expect(new URL(window.location.href).searchParams.get("reader.capture-path.pin")).toBe(
      "consumer",
    );
    const panel = ui.container.querySelector(".tack-figure-panel")?.textContent ?? "";
    expect(panel).toContain("Sends to 2");
    expect(panel).toContain("Receives from 1");
  });

  it("replays one event through nodes and links, and inks only the reply at step 4", async () => {
    const figure = await render();
    await click(chip("One event"));
    expect(box("feed").dataset["ink"]).toBe("focus");
    expect(box("collector").dataset["ink"]).toBe("focus");
    expect(link("capture").dataset).toMatchObject({ kind: "trace", last: "" });
    expect(box("pg").dataset["ink"]).toBe("dim");
    await click(chip("Next"));
    await click(chip("Next"));
    await click(chip("Next"));
    expect(ui.container.querySelector(".tack-figure-count")?.textContent).toBe("Step 4 of 4");
    expect(link("ack").dataset).toMatchObject({ kind: "trace", last: "" });
    expect(link("insert").dataset["kind"]).toBe("trace");
    expect(link("insert").dataset["last"]).toBeUndefined();
    expect(
      ["feed", "collector", "redis", "consumer", "pg"].map((id) => box(id).dataset["ink"]),
    ).toEqual(["visited", "visited", "visited", "visited", "visited"]);
    expect(figure.textContent).toContain("Only then is the entry acknowledged and deleted.");
    // The current link's label stays readable: it is drawn, in the current ink.
    expect(
      ui.container
        .querySelector('.tack-map-link-label[data-link="ack"]')
        ?.getAttribute("data-kind"),
    ).toBe("trace");
    const state = JSON.parse(figure.dataset["readerState"] ?? "{}") as unknown;
    expect(state).toEqual({ pin: null, case: "one-event", step: 4 });
  });

  it("strikes the broken parts of a failure lens and fades the rest", async () => {
    const figure = await render();
    await click(chip("Postgres down"));
    expect(box("pg").dataset["ink"]).toBe("broken");
    expect(link("insert").dataset).toMatchObject({ kind: "broken" });
    expect(link("insert").getAttribute("marker-end")).toMatch(/stop/);
    expect(["collector", "redis"].map((id) => box(id).dataset["ink"])).toEqual(["near", "near"]);
    expect(link("xadd").dataset["kind"]).toBe("rest");
    expect(box("feed").dataset["ink"]).toBe("off");
    expect(link("read").dataset["kind"]).toBe("fade");
    expect(figure.textContent).toContain("Capture continues. Events wait in Redis.");
  });

  it("lets a pointer preview override the active case without changing it", async () => {
    await render();
    await click(chip("Postgres down"));
    await act(async () =>
      box("feed").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
    );
    expect(box("feed").dataset["ink"]).toBe("focus");
    expect(box("pg").dataset["ink"]).toBe("off");
    await act(async () => box("feed").dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
    expect(box("pg").dataset["ink"]).toBe("broken");
  });

  it("carries the text equivalent and the view state into a copied block", async () => {
    const figure = await render();
    await click(box("redis"));
    const context = interactionContext(figure);
    expect(context.readable).toContain("Redis stream -> worker-core: XREADGROUP");
    expect(context.readable).toContain("View: pinned Redis stream");
    expect(context.state).toEqual({ "capture-path": { pin: "redis", case: null, step: null } });
  });

  it("pins a part inside a nested group with its details, and releases it on the ground or Escape", async () => {
    const figure = await render({
      ...props,
      summary: "Redis holds only what Postgres does not have yet.",
      groups: [
        { id: "vps", label: "VPS" },
        { id: "browser", label: "worker-browser (untrusted)", parent: "vps" },
      ],
      nodes: props.nodes.map((node) => (node.id === "redis" ? { ...node, group: "vps" } : node)),
    });
    expect(figure.querySelector(".tack-figure-summary")?.textContent).toBe(
      "Redis holds only what Postgres does not have yet.",
    );
    expect(
      [...ui.container.querySelectorAll(".tack-system-group text")].map((text) => text.textContent),
    ).toEqual(["VPS", "worker-browser (untrusted)"]);
    const panel = (): string => ui.container.querySelector(".tack-figure-panel")?.textContent ?? "";
    await click(box("collector"));
    expect(panel()).toContain("Pinned, a service in worker-browser (untrusted)");
    expect(panel()).toContain("headless browser + WebSocket");
    await click(box("redis"));
    expect(panel()).toContain("Pinned, a queue in VPS");
    expect(panel()).toContain("Holds only the backlog not yet written to Postgres.");
    const drawing = ui.container.querySelector(".tack-system-drawing");
    if (drawing === null) throw new Error("no drawing");
    await click(drawing);
    expect(figure.dataset["readerState"]).toBe('{"pin":null,"case":null,"step":null}');
    await click(box("pg"));
    expect(panel()).toContain("public.parcel_events");
    await act(async () =>
      figure.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(figure.dataset["readerState"]).toBe('{"pin":null,"case":null,"step":null}');
  });

  it("strikes the parts a replay step breaks, also in a step that only breaks parts", async () => {
    await render({
      ...props,
      replays: [
        {
          label: "Postgres fails",
          steps: [
            { at: ["consumer"], broken: ["pg", "insert"], note: "The insert fails." },
            { at: [], broken: ["redis"], note: "Then the buffer fills." },
          ],
        },
      ],
    });
    await click(chip("Postgres fails"));
    expect(box("consumer").dataset["ink"]).toBe("focus");
    expect(box("pg").dataset["ink"]).toBe("broken");
    expect(link("insert").dataset["kind"]).toBe("broken");
    await click(chip("Next"));
    expect(box("redis").dataset["ink"]).toBe("broken");
    expect(box("consumer").dataset["ink"]).toBe("visited");
    expect(box("pg").dataset["ink"]).toBe("dim");
  });

  it("scrolls a drawing that fits no way instead of shrinking it, and says why", async () => {
    const figure = await render({
      id: "wide",
      title: "Every stage hands its batch to every node of the next stage",
      nodes: Array.from({ length: 12 }, (_, index) => ({
        id: `n${index}`,
        label: `stage-${index}`,
        kind: "service" as const,
      })),
      links: Array.from({ length: 27 }, (_, index) => {
        const layer = Math.floor(index / 9);
        return {
          from: `n${layer * 3 + Math.floor((index % 9) / 3)}`,
          to: `n${(layer + 1) * 3 + (index % 3)}`,
          label: "publishes the whole batch to the reader",
        };
      }),
    });
    const svg = figure.querySelector<SVGSVGElement>(".tack-system svg.tack-map");
    expect(svg?.dataset["overflow"]).toBe("");
    expect(Number(svg?.getAttribute("width"))).toBeGreaterThan(728);
    expect(JSON.parse(figure.dataset["figureIssues"] ?? "[]")).toEqual([
      "layout: does not fit the column at a legible size; shorten the link labels or split the figure",
    ]);
  });

  it("lists the same issue lines as the figure check, once laid out", async () => {
    const broken = resolve(import.meta.dirname, "../../fixtures/figures/broken-figures.mdx");
    const figures = await staticFigures(broken);
    const index = figures.findIndex((figure) => figure.component === "System");
    const found = figures[index];
    if (found === undefined || found.props instanceof NotStatic) throw new Error("no System");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Statically read props are untyped by design; the component reads them leniently.
    const figure = await render(found.props as SystemProps);
    const report = await checkFigures([broken]);
    const result = report.documents[0]?.figures[index];
    expect(result?.status).toBe("issues");
    expect(JSON.parse(figure.dataset["figureIssues"] ?? "[]")).toEqual(
      result?.status === "issues" ? result.issues : [],
    );
  });
});
