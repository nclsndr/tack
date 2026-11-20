import { describe, expect, it } from "vitest";
import { cubicPath, edgeOf, fanSpreads, labelSpot, pointAt, route } from "./curves.ts";

const box = (x: number, y: number) => ({ x, y, w: 100, h: 30 });

describe("kit curves", () => {
  it("leaves a box by the edge that faces the other box", () => {
    expect(edgeOf(box(0, 0), box(0, 100))).toBe("bottom");
    expect(edgeOf(box(0, 100), box(0, 0))).toBe("top");
    expect(edgeOf(box(0, 0), box(200, 0))).toBe("right");
    expect(edgeOf(box(200, 0), box(0, 0))).toBe("left");
  });

  it("fans links that leave one edge so no two start at the same point", () => {
    const spreads = fanSpreads(box(100, 0), [
      box(0, 100),
      box(100, 100),
      box(200, 100),
      box(300, 0),
    ]);
    expect(new Set(spreads.slice(0, 3)).size).toBe(3);
    expect(spreads[3]).toBe(0);
  });

  it("hops straight to a neighbour in a row, and arcs under the row past one", () => {
    const hop = route(box(0, 0), box(110, 0));
    expect(hop[1]).toBe(hop[7]);
    const arc = route(box(0, 0), box(330, 0));
    expect(arc[3]).toBeGreaterThan(30);
    expect(route(box(330, 0), box(0, 0))[0]).toBe(330);
    expect(route(box(0, 100), box(0, 0))[1]).toBe(100);
  });

  it("places a label clear of lit boxes, or nowhere on a short curve", () => {
    const curve = route(box(0, 0), box(0, 300));
    expect(labelSpot(curve, 6, [])).toEqual(pointAt(curve, 0.62));
    expect(labelSpot(route(box(0, 0), box(0, 40)), 20, [])).toBeUndefined();
    expect(labelSpot(curve, 6, [{ x: -500, y: -500, w: 2000, h: 2000 }])).toBeUndefined();
    expect(cubicPath([0, 0, 1.04, 1, 2, 2, 3, 3])).toBe("M 0 0 C 1 1, 2 2, 3 3");
  });
});
