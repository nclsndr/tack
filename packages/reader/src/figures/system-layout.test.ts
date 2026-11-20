import { describe, expect, it } from "vitest";
import { issueLine } from "./issues.ts";
import { loadLayoutEngine } from "./layout-engine.ts";
import { type Cubic, pointAt, type Rect } from "./curves.ts";
import { readSystem } from "./system-model.ts";
import {
  layoutSystem,
  systemBoxSize,
  systemDetour,
  systemLabelLines,
  systemDrawingSizes,
  systemLayoutIssues,
  systemLinkCurves,
} from "./system-layout.ts";
import { capturePath } from "./system-fixtures.ts";

const chain = (count: number, label = "sends") => ({
  id: "chain",
  title: "Each part hands the work to the next one",
  nodes: Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    label: `part-${index}`,
    kind: "service",
  })),
  links: Array.from({ length: count - 1 }, (_, index) => ({
    from: `n${index}`,
    to: `n${index + 1}`,
    label,
  })),
});

/** One source fanning out to `count` workers that all write to one sink. */
const fan = (count: number, label: string) => ({
  id: "fan",
  title: "Every worker writes to the same store",
  nodes: [
    { id: "source", label: "dispatcher", kind: "service" },
    ...Array.from({ length: count }, (_, index) => ({
      id: `w${index}`,
      label: `worker-${index}`,
      kind: "service",
    })),
    { id: "sink", label: "store", kind: "store" },
  ],
  links: [
    ...Array.from({ length: count }, (_, index) => ({ from: "source", to: `w${index}`, label })),
    ...Array.from({ length: count }, (_, index) => ({ from: `w${index}`, to: "sink", label })),
  ],
});

/** `layers` layers of `rows` nodes, each node linked to every node of the next layer. */
const grid = (layers: number, rows: number, label: string) => {
  const id = (layer: number, row: number): string => `n${layer}-${row}`;
  return {
    id: "grid",
    title: "Every stage hands its batch to every node of the next stage",
    nodes: Array.from({ length: layers * rows }, (_, index) => ({
      id: id(Math.floor(index / rows), index % rows),
      label: `stage-${Math.floor(index / rows)}-${index % rows}`,
      kind: "service",
    })),
    links: Array.from({ length: layers - 1 }, (_layerEntry, layer) =>
      Array.from({ length: rows * rows }, (_pairEntry, pair) => ({
        from: id(layer, Math.floor(pair / rows)),
        to: id(layer + 1, pair % rows),
        label,
      })),
    ).flat(),
  };
};

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

async function laid(props: unknown, width?: number) {
  const { model } = readSystem(props);
  const layout = await layoutSystem(model, await loadLayoutEngine(), width);
  return { model, layout };
}

/** Every box inside the drawing, and no two boxes overlapping. */
function expectSound(layout: Awaited<ReturnType<typeof layoutSystem>>): void {
  const boxes = [...layout.boxes.values()];
  for (const box of boxes)
    expect(contains({ x: 0, y: 0, w: layout.width, h: layout.height }, box)).toBe(true);
  boxes.forEach((box, index) =>
    boxes.slice(index + 1).forEach((other) => expect(overlaps(box, other)).toBe(false)),
  );
}

describe("sizing a System box", () => {
  it("derives the size from the text and the shape, never from a measurement", () => {
    expect(systemBoxSize({ label: "redis", kind: "service", lines: [] })).toEqual({ w: 72, h: 34 });
    expect(
      systemBoxSize({
        label: "Redis stream",
        kind: "queue",
        detail: "about 1 day at 3 GB",
        lines: [],
      }),
    ).toEqual({ w: 160, h: 46 });
    expect(
      systemBoxSize({ label: "Postgres", kind: "store", lines: ["public.parcel_events"] }),
    ).toEqual({ w: 148, h: 51 });
  });

  it("stacks the lines under the detail", () => {
    expect(
      systemBoxSize({ label: "web", kind: "service", detail: "nitro", lines: ["ui", "api"] }).h,
    ).toBe(76);
  });

  it("caps the width, so a long label is truncated and not shrunk", () => {
    expect(systemBoxSize({ label: "x".repeat(80), kind: "service", lines: [] }).w).toBe(240);
  });

  it("draws no text under 11 px", () => {
    expect(Math.min(...Object.values(systemDrawingSizes))).toBeGreaterThanOrEqual(11);
  });
});

describe("wrapping a link label", () => {
  it("keeps a short label, or any label when wrapping is off, on one line", () => {
    expect(systemLabelLines("XADD", true)).toEqual(["XADD"]);
    expect(systemLabelLines("publishes the batch to every subscriber", false)).toEqual([
      "publishes the batch to every subscriber",
    ]);
  });

  it("splits a long label in two lines of about equal length, never three", () => {
    expect(systemLabelLines("publishes the batch to every subscriber", true)).toEqual([
      "publishes the batch",
      "to every subscriber",
    ]);
    expect(systemLabelLines("acks bbbbbbbbbbbbbbbbbbbbbbbb then", true)).toEqual([
      "acks",
      "bbbbbbbbbbbbbbbbbbbbbbbb then",
    ]);
  });
});

describe("laying out a System", () => {
  it("reads only the positions the engine gives, and leaves out a node it did not place", async () => {
    const { model } = readSystem(capturePath);
    const layout = await layoutSystem(model, {
      layout: async () => ({ id: "root", children: [{ id: "n:feed" }] }),
    });
    expect([...layout.boxes.keys()]).toEqual(["feed"]);
    expect(layout.boxes.get("feed")).toMatchObject({ x: 364, y: 0 });
    expect(layout).toMatchObject({ width: 728, height: 0, fits: true, groups: new Map() });
    expect(systemLinkCurves(model, layout)).toEqual([]);
  });

  it("reports a drawing taller than the limit", async () => {
    const { layout } = await laid(chain(3));
    expect(systemLayoutIssues({ ...layout, height: 1300 }).map(issueLine)).toEqual([
      "layout: the drawing is 1,300 px tall at column width; the limit is 1,200. Split the figure or raise its level",
    ]);
  });

  it("lays a short chain out left to right in the column", async () => {
    const { layout } = await laid(chain(3));
    expect(layout).toMatchObject({ direction: "right", wrapped: false, fits: true, width: 728 });
    expectSound(layout);
    const [a, b, c] = ["n0", "n1", "n2"].map((id) => layout.boxes.get(id));
    expect(a !== undefined && b !== undefined && c !== undefined).toBe(true);
    if (a === undefined || b === undefined || c === undefined) return;
    expect(a.x + a.w).toBeLessThan(b.x);
    expect(b.x + b.w).toBeLessThan(c.x);
    expect(systemLayoutIssues(layout)).toEqual([]);
  });

  it("draws ten nodes in a chain top to bottom at full size, with no issue", async () => {
    const { layout } = await laid(chain(10));
    expect(layout).toMatchObject({ direction: "down", wrapped: false, fits: true, width: 728 });
    expectSound(layout);
    expect(layout.height).toBeLessThanOrEqual(1200);
    expect(systemLayoutIssues(layout)).toEqual([]);
  });

  it("puts the capture path of the brief in the column", async () => {
    const { layout } = await laid(capturePath);
    expect(layout.fits).toBe(true);
    expectSound(layout);
    expect(systemLayoutIssues(layout)).toEqual([]);
  });

  it("lays a reply out like the request it answers, so the queue stays before the consumer", async () => {
    for (const direction of ["right", "down"] as const) {
      const { layout } = await laid(capturePath, direction === "right" ? 4000 : 728);
      const redis = layout.boxes.get("redis");
      const consumer = layout.boxes.get("consumer");
      expect(layout.direction).toBe(direction);
      expect(redis !== undefined && consumer !== undefined).toBe(true);
      if (redis === undefined || consumer === undefined) return;
      if (direction === "right") expect(redis.x + redis.w).toBeLessThan(consumer.x);
      else expect(redis.y + redis.h).toBeLessThan(consumer.y);
    }
  });

  it("keeps the nodes of a group inside its region, and a nested group inside its parent", async () => {
    const { layout } = await laid({
      ...capturePath,
      groups: [
        { id: "vps", label: "VPS" },
        { id: "browser", label: "worker-browser", parent: "vps" },
      ],
      nodes: capturePath.nodes.map((node) =>
        node.id === "redis" || node.id === "consumer" ? { ...node, group: "vps" } : node,
      ),
    });
    const vps = layout.groups.get("vps");
    const browser = layout.groups.get("browser");
    expect(vps !== undefined && browser !== undefined).toBe(true);
    if (vps === undefined || browser === undefined) return;
    expect(contains(vps, browser)).toBe(true);
    for (const id of ["redis", "consumer"])
      expect(contains(vps, layout.boxes.get(id) ?? vps)).toBe(true);
    expect(contains(browser, layout.boxes.get("collector") ?? vps)).toBe(true);
    expect(contains(vps, layout.boxes.get("feed") ?? vps)).toBe(false);
  });

  it("wraps link labels on two lines before it gives up", async () => {
    const { layout } = await laid(fan(3, "publishes the batch to every subscriber"));
    expect(layout.fits).toBe(true);
    expect(layout.wrapped).toBe(true);
    expect([...layout.labels.values()].every((lines) => lines.length === 2)).toBe(true);
  });

  it("reports a drawing that fits no way, and scrolls instead of shrinking the text", async () => {
    const { layout } = await laid(grid(4, 3, "publishes the whole batch to the reader"));
    expect(layout.fits).toBe(false);
    expect(layout.width).toBeGreaterThan(728);
    expect(systemLayoutIssues(layout).map(issueLine)).toEqual([
      "layout: does not fit the column at a legible size; shorten the link labels or split the figure",
    ]);
  });

  it("uses the wider room of the Expand overlay", async () => {
    const { layout } = await laid(chain(6), 1180);
    expect(layout.direction).toBe("right");
    expect(layout.width).toBe(1180);
  });
});

describe("the links of a System", () => {
  it("draws every link as one curve that starts and ends on the outline of its boxes", async () => {
    const { model, layout } = await laid(capturePath);
    const curves = systemLinkCurves(model, layout);
    expect(curves.map((curve) => curve.id)).toEqual(model.links.map((link) => link.id));
    for (const { id, curve } of curves) {
      const link = model.links.find((candidate) => candidate.id === id);
      const from = layout.boxes.get(link?.from ?? "");
      const to = layout.boxes.get(link?.to ?? "");
      expect(from !== undefined && to !== undefined).toBe(true);
      if (from === undefined || to === undefined) return;
      const onOutline = (x: number, y: number, box: Rect): boolean =>
        x >= box.x - 3 &&
        x <= box.x + box.w + 3 &&
        y >= box.y - 3 &&
        y <= box.y + box.h + 3 &&
        (Math.abs(x - box.x) <= 3 ||
          Math.abs(x - box.x - box.w) <= 3 ||
          Math.abs(y - box.y) <= 3 ||
          Math.abs(y - box.y - box.h) <= 3);
      expect(onOutline(curve[0], curve[1], from), `${id} start`).toBe(true);
      expect(onOutline(curve[6], curve[7], to), `${id} end`).toBe(true);
    }
  });

  it("fans out the two links between one pair of nodes, so they never coincide", async () => {
    const { model, layout } = await laid(capturePath);
    const curves = systemLinkCurves(model, layout);
    const read = curves.find((curve) => curve.id === "read");
    const ack = curves.find((curve) => curve.id === "ack");
    expect(read !== undefined && ack !== undefined).toBe(true);
    if (read === undefined || ack === undefined) return;
    expect(Math.hypot(read.curve[0] - ack.curve[6], read.curve[1] - ack.curve[7])).toBeGreaterThan(
      8,
    );
    const box = ({ label }: typeof read): Rect => ({
      x: label.x - label.w / 2,
      y: label.y - label.h / 2,
      w: label.w,
      h: label.h,
    });
    expect(overlaps(box(read), box(ack))).toBe(false);
  });

  it("keeps the labels of links that leave one node apart from each other", async () => {
    const { model, layout } = await laid(fan(4, "sends a batch"));
    const labels = systemLinkCurves(model, layout).map(({ label }) => ({
      x: label.x - label.w / 2,
      y: label.y - label.h / 2,
      w: label.w,
      h: label.h,
    }));
    labels.forEach((label, index) =>
      labels.slice(index + 1).forEach((other) => expect(overlaps(label, other)).toBe(false)),
    );
  });

  it("puts every label clear of every box", async () => {
    const { model, layout } = await laid(capturePath);
    for (const { label } of systemLinkCurves(model, layout)) {
      const rect = { x: label.x - label.w / 2, y: label.y - label.h / 2, w: label.w, h: label.h };
      for (const box of layout.boxes.values()) expect(overlaps(rect, box)).toBe(false);
    }
  });

  it("takes a link that would cross another box around the side of the boxes in between", async () => {
    const { model, layout } = await laid({
      ...chain(3),
      links: [...chain(3).links, { from: "n0", to: "n2", label: "skips" }],
    });
    const skip = systemLinkCurves(model, layout).at(-1);
    const middle = layout.boxes.get("n1");
    expect(skip !== undefined && middle !== undefined).toBe(true);
    if (skip === undefined || middle === undefined) return;
    const crosses = Array.from({ length: 41 }, (_, step) => pointAt(skip.curve, step / 40)).some(
      ([x, y]) =>
        x > middle.x + 2 &&
        x < middle.x + middle.w - 2 &&
        y > middle.y + 2 &&
        y < middle.y + middle.h - 2,
    );
    expect(crosses).toBe(false);
  });

  it("bows several skipping links of a top-to-bottom chain around the boxes they pass", async () => {
    const skips = [
      { from: "n0", to: "n2", label: "skips" },
      { from: "n2", to: "n4", label: "skips" },
      { from: "n4", to: "n6", label: "skips" },
    ];
    const { model, layout } = await laid({ ...chain(10), links: [...chain(10).links, ...skips] });
    expect(layout.direction).toBe("down");
    const curves = systemLinkCurves(model, layout).slice(-skips.length);
    const routes = curves.map((curve) => curve.route);
    expect(routes.every((route) => route === "left" || route === "right")).toBe(true);
    ["n1", "n3", "n5"].forEach((id, index) => {
      const middle = layout.boxes.get(id);
      const curve = curves[index];
      if (middle === undefined || curve === undefined) throw new Error(`Missing ${id}`);
      const crosses = Array.from({ length: 41 }, (_, step) => pointAt(curve.curve, step / 40)).some(
        ([x, y]) =>
          x > middle.x + 2 &&
          x < middle.x + middle.w - 2 &&
          y > middle.y + 2 &&
          y < middle.y + middle.h - 2,
      );
      expect(crosses, id).toBe(false);
    });
  });

  it("ends a link that points back against the flow on the outline too, in both directions", async () => {
    const right = await laid({
      ...chain(3),
      links: [...chain(3).links, { from: "n2", to: "n0", label: "retries" }],
    });
    const down = await laid({
      ...chain(10),
      links: [...chain(10).links, { from: "n1", to: "n0", label: "retries" }],
    });
    expect(right.layout.direction).toBe("right");
    expect(down.layout.direction).toBe("down");
    for (const { model, layout } of [right, down]) {
      const back = systemLinkCurves(model, layout).at(-1);
      const from = layout.boxes.get(model.links.at(-1)?.from ?? "");
      const to = layout.boxes.get(model.links.at(-1)?.to ?? "");
      expect(back !== undefined && from !== undefined && to !== undefined).toBe(true);
      if (back === undefined || from === undefined || to === undefined) return;
      const near = (x: number, y: number, box: Rect): boolean =>
        x >= box.x - 3 && x <= box.x + box.w + 3 && y >= box.y - 3 && y <= box.y + box.h + 3;
      expect(near(back.curve[0], back.curve[1], from)).toBe(true);
      expect(near(back.curve[6], back.curve[7], to)).toBe(true);
    }
  });

  it("bows a detour out on any side, past the boxes in between", () => {
    const room = { width: 728, height: 600 };
    const clear = (curve: Cubic, box: Rect): boolean =>
      Array.from({ length: 41 }, (_, step) => pointAt(curve, step / 40)).every(
        ([x, y]) => x <= box.x || x >= box.x + box.w || y <= box.y || y >= box.y + box.h,
      );
    const column = { a: { x: 300, y: 0, w: 100, h: 40 }, b: { x: 300, y: 200, w: 100, h: 40 } };
    const row = { a: { x: 0, y: 300, w: 100, h: 40 }, b: { x: 400, y: 300, w: 100, h: 40 } };
    const inColumn = { x: 300, y: 100, w: 100, h: 40 };
    const inRow = { x: 200, y: 300, w: 100, h: 40 };
    for (const side of ["left", "right"] as const) {
      const curve = systemDetour(column.a, column.b, side, [inColumn], room, 22, 0);
      expect(clear(curve, inColumn), side).toBe(true);
    }
    for (const side of ["top", "bottom"] as const) {
      const curve = systemDetour(row.a, row.b, side, [inRow], room, 22, 8);
      expect(clear(curve, inRow), side).toBe(true);
      expect(curve[0]).toBe(58);
    }
  });

  it("draws a link to its own node as a loop beside the node", async () => {
    const { model, layout } = await laid({
      ...chain(2),
      links: [...chain(2).links, { from: "n1", to: "n1", label: "retries" }],
    });
    const loop = systemLinkCurves(model, layout).at(-1);
    const box = layout.boxes.get("n1");
    expect(loop !== undefined && box !== undefined).toBe(true);
    if (loop === undefined || box === undefined) return;
    expect(loop.curve[2]).toBeGreaterThan(box.x + box.w);
    expect(loop.label.anchor).toBe("start");
  });
});
