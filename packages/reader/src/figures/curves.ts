/**
 * The kit's link geometry: smooth cubic curves between boxes, fanned so that links leaving one box
 * never coincide. No measuring: every number derives from box rectangles.
 */

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};
export type Point = readonly [number, number];
/** A cubic curve: start, first control point, second control point, end. */
export type Cubic = readonly [number, number, number, number, number, number, number, number];
export type Edge = "top" | "bottom" | "left" | "right";

/** The edge of `a` that a curve towards `b` leaves from. */
export function edgeOf(a: Rect, b: Rect): Edge {
  if (b.y >= a.y + a.h) return "bottom";
  if (b.y + b.h <= a.y) return "top";
  return b.x > a.x ? "right" : "left";
}

const middle = (box: Rect): Point => [box.x + box.w / 2, box.y + box.h / 2];

/** Offset of item `at` among `count` items spaced `step` apart and centred on zero. */
export const centred = (at: number, count: number, step: number): number =>
  (at - (count - 1) / 2) * step;

/**
 * One spread per box linked to `hub`, so that no two curves coincide. The links on one edge are
 * ranked by direction, leftmost first, so siblings do not cross near the hub, then spaced evenly
 * along that edge.
 */
export function fanSpreads(hub: Rect, others: readonly Rect[]): readonly number[] {
  const [hx, hy] = middle(hub);
  const ranked = others.map((box, at) => {
    const [x, y] = middle(box);
    const edge = edgeOf(hub, box);
    const upright = edge === "top" || edge === "bottom";
    return {
      at,
      edge,
      upright,
      rank: upright ? -Math.atan2(Math.abs(y - hy), x - hx) : Math.abs(x - hx),
    };
  });
  return ranked.map((item) => {
    const group = ranked
      .filter((other) => other.edge === item.edge)
      .toSorted((p, q) => p.rank - q.rank || p.at - q.at);
    const room = item.upright ? hub.w - 28 : hub.h - 22;
    const step = Math.min(item.upright ? 9 : 7, room / Math.max(1, group.length - 1));
    return centred(group.indexOf(item), group.length, step);
  });
}

/**
 * A smooth vertical-first curve from `a` to `b` that ends on the box outlines. `spread` moves the
 * start along the leaving edge; `endShift` moves the arrival along the target edge. Inside a row
 * the link is a straight hop to the next box, or an arc that sags into the gap under the row,
 * deeper for each column it skips.
 */
export function route(a: Rect, b: Rect, spread = 0, endShift = 0): Cubic {
  const edge = edgeOf(a, b);
  if (edge === "top" || edge === "bottom") {
    const down = edge === "bottom";
    const x1 = a.x + a.w / 2 + spread;
    const y1 = down ? a.y + a.h : a.y;
    const x2 = b.x + b.w / 2 + spread * 0.4 + endShift;
    const y2 = down ? b.y - 2 : b.y + b.h + 2;
    const bend = Math.max(24, Math.abs(y2 - y1) * 0.45) * (down ? 1 : -1);
    return [x1, y1, x1, y1 + bend, x2, y2 - bend, x2, y2];
  }
  const right = edge === "right";
  const x1 = right ? a.x + a.w : a.x;
  const x2 = right ? b.x - 2 : b.x + b.w + 2;
  const y1 = a.y + a.h / 2 + spread;
  const y2 = b.y + b.h / 2;
  const run = x2 - x1;
  const skipped = Math.round(Math.abs(b.x - a.x) / a.w) - 1;
  if (skipped <= 0) return [x1, y1, x1 + run / 3, y1, x1 + (run * 2) / 3, y1, x2, y1];
  // One reach for every arc keeps the arcs of one box nested. A cubic whose control points share
  // one y reaches 3/4 of the way to it.
  const reach = Math.sign(run) * Math.min(40, Math.abs(run) * 0.35);
  const sag = (a.y + a.h + 1 + 3 * skipped - (y1 + y2) / 8) / 0.75;
  return [x1, y1, x1 + reach, sag, x2 - reach, sag, x2, y2];
}

/** The point at `t` on a cubic. */
export function pointAt(curve: Cubic, t: number): Point {
  const u = 1 - t;
  const mix = (a: number, b: number, c: number, d: number): number =>
    u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  return [mix(curve[0], curve[2], curve[4], curve[6]), mix(curve[1], curve[3], curve[5], curve[7])];
}

/**
 * Where a link label of `chars` characters sits on its curve: past the middle, away from the fan at
 * the hub, at the first spot clear of every lit box. `undefined` when the curve is too short.
 */
export function labelSpot(curve: Cubic, chars: number, lit: readonly Rect[]): Point | undefined {
  const half = chars * 3.3 + 5;
  if (Math.hypot(curve[6] - curve[0], curve[7] - curve[1]) < half * 2) return undefined;
  const clear = ([x, y]: Point): boolean =>
    lit.every(
      (box) =>
        x + half < box.x || x - half > box.x + box.w || y + 8 < box.y || y - 8 > box.y + box.h,
    );
  return [0.62, 0.74, 0.5, 0.38].map((t) => pointAt(curve, t)).find(clear);
}

/** The SVG path of a cubic, rounded to a tenth of a pixel. */
export function cubicPath(curve: Cubic): string {
  const [x1, y1, ax, ay, bx, by, x2, y2] = curve.map((value) => Math.round(value * 10) / 10);
  return `M ${x1} ${y1} C ${ax} ${ay}, ${bx} ${by}, ${x2} ${y2}`;
}

/** Whether `curve` passes through the inside of `box`, sampled at 41 points. */
export function crossesBox(curve: Cubic, box: Rect): boolean {
  return Array.from({ length: 41 }, (_, step) => pointAt(curve, step / 40)).some(
    ([x, y]) => x > box.x + 2 && x < box.x + box.w - 2 && y > box.y + 2 && y < box.y + box.h - 2,
  );
}
