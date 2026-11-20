/**
 * The geometry of a `System`. Box sizes derive from text by rule; the layout engine places boxes
 * and group regions, and nothing else. The direction is chosen here: left to right when the whole
 * drawing fits the column with text at full size, top to bottom otherwise, then the same with link
 * labels on two lines. Links are drawn by the kit as curves between the placed boxes, so the look
 * does not depend on the engine.
 */
import { centred, crossesBox, type Cubic, pointAt, type Rect } from "./curves.ts";
import { type FigureIssue, layoutIssue } from "./issues.ts";
import { columnWidth, fitText, maximumHeight, wrapText } from "./architecture-map-layout.ts";
import type { ElkNode, LayoutEngine } from "./layout-engine.ts";
import type { SystemLinkKind, SystemModel, SystemNode, SystemNodeKind } from "./system-model.ts";

/** Every text size drawn in a `System`, in px. None is under 11. */
export const systemDrawingSizes = {
  label: 12.5,
  detail: 11,
  line: 11,
  link: 11,
  group: 11,
  badge: 11,
} as const;

/** Average advance of one character at each text style, for fitting without measuring. */
const charWidth = { label: 7, mono: 6.6, group: 7.6 } as const;
const boxPad = 8;
const minimumBox = 72;
const maximumBox = 240;
const grid = 4;
const lineStep = 15;
/** The room each shape takes beside the text: the slots of a queue, the fold of a sheet. */
const shapeRoom: Readonly<Record<SystemNodeKind, number>> = {
  service: 0,
  store: 0,
  queue: 18,
  external: 0,
  actor: 10,
  artifact: 8,
};
/** A store's rims take room above and below the text. */
const storeTop = 4;

/** The size of a node's box: from its text and shape, on the 4 px grid, within the width cap. */
export function systemBoxSize(node: Pick<SystemNode, "label" | "kind" | "detail" | "lines">): {
  readonly w: number;
  readonly h: number;
} {
  const textWidth = Math.max(
    node.label.length * charWidth.label,
    (node.detail?.length ?? 0) * charWidth.mono,
    ...node.lines.map((line) => line.length * charWidth.mono),
  );
  const wanted = Math.ceil((textWidth + 2 * boxPad + shapeRoom[node.kind]) / grid) * grid;
  const base =
    node.lines.length === 0
      ? node.detail === undefined
        ? 34
        : 46
      : (node.detail === undefined ? 30 : 46) + node.lines.length * lineStep;
  return {
    w: Math.min(maximumBox, Math.max(minimumBox, wanted)),
    h: base + (node.kind === "store" ? 2 * storeTop - 2 : 0),
  };
}

type SystemBox = Rect & {
  readonly id: string;
  readonly kind: SystemNodeKind;
  /** The full label and detail, for the tooltip and assistive technology. */
  readonly label: string;
  readonly detail?: string;
  /** The tint of the node's group; none outside a group. */
  readonly tint?: number;
  /** The label, detail and lines as drawn: truncated to fit the box. */
  readonly text: string;
  readonly detailText?: string;
  readonly lineTexts: readonly string[];
  /** How far a store's text sits below the top, under its rim. */
  readonly top: number;
};
type SystemRegion = Rect & {
  readonly label: string;
  readonly tint: number;
  /** Inside another group. */
  readonly nested: boolean;
};
export type SystemLayout = {
  readonly direction: "right" | "down";
  /** Link labels drawn on two lines. */
  readonly wrapped: boolean;
  /** Whether the drawing fits the width it was laid out for. */
  readonly fits: boolean;
  /** The drawing's width: the room it was laid out for, or more when it does not fit. */
  readonly width: number;
  readonly height: number;
  readonly boxes: ReadonlyMap<string, SystemBox>;
  /** Group regions, outer groups first so an inner region is drawn over its parent's. */
  readonly groups: ReadonlyMap<string, SystemRegion>;
  /** The lines of each link's label, by link id. */
  readonly labels: ReadonlyMap<string, readonly string[]>;
};

/** A link label's lines: one, or, when `wrapped`, two of about equal length. */
export function systemLabelLines(label: string, wrapped: boolean): readonly string[] {
  if (wrapped === false || label.length <= 14) return [label];
  const longest = Math.max(...label.split(" ").map((word) => word.length));
  const lines = wrapText(label, Math.max(longest, Math.ceil(label.length / 2) + 1));
  return lines.length <= 2 ? lines : [lines[0] ?? "", lines.slice(1).join(" ")];
}

const labelBox = (lines: readonly string[]): { readonly w: number; readonly h: number } => ({
  w: Math.ceil(Math.max(...lines.map((line) => line.length)) * charWidth.mono + 10),
  h: lines.length * 13 + 3,
});

/** The engine's options. Spacing is read per compound node, so groups repeat it. */
function spacing(direction: "right" | "down"): Readonly<Record<string, string>> {
  return {
    "elk.layered.spacing.nodeNodeBetweenLayers": direction === "right" ? "28" : "24",
    "elk.layered.spacing.edgeNodeBetweenLayers": "10",
    "elk.spacing.nodeNode": direction === "right" ? "20" : "28",
    "elk.spacing.edgeNode": "12",
    "elk.spacing.edgeEdge": "10",
    "elk.spacing.edgeLabel": "4",
    "elk.spacing.labelNode": "6",
  };
}

/** The engine's graph: groups as compound nodes, links in the direction of the request. */
function engineGraph(model: SystemModel, direction: "right" | "down", wrapped: boolean): ElkNode {
  const looped = new Set(
    model.links.filter((link) => link.from === link.to).map((link) => link.from),
  );
  const leaf = (node: SystemNode): ElkNode => {
    const size = systemBoxSize(node);
    // A loop needs room beside its node.
    return {
      id: `n:${node.id}`,
      width: size.w + (looped.has(node.id) === true ? 44 : 0),
      height: size.h,
    };
  };
  const group = (id: string): ElkNode => {
    const label = model.groups.find((candidate) => candidate.id === id)?.label ?? id;
    return {
      id: `g:${id}`,
      layoutOptions: {
        ...spacing(direction),
        "elk.padding": "[top=30,left=14,bottom=14,right=14]",
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${Math.ceil(label.length * charWidth.group + 28)},40)`,
      },
      children: [
        ...model.groups.filter((inner) => inner.parent === id).map((inner) => group(inner.id)),
        ...model.nodes.filter((node) => node.group === id).map(leaf),
      ],
    };
  };
  return {
    id: "root",
    layoutOptions: {
      ...spacing(direction),
      "elk.algorithm": "layered",
      "elk.direction": direction === "right" ? "RIGHT" : "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
      "elk.edgeLabels.placement": "CENTER",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.thoroughness": "24",
      "elk.padding": "[top=16,left=16,bottom=16,right=16]",
    },
    children: [
      ...model.groups.filter((item) => item.parent === undefined).map((item) => group(item.id)),
      ...model.nodes.filter((node) => node.group === undefined).map(leaf),
    ],
    // A reply is laid out like the request it answers, so it never reverses the layers.
    edges: model.links
      .filter((link) => link.from !== link.to)
      .map((link) => {
        const [source, target] =
          link.kind === "reply" ? [link.to, link.from] : [link.from, link.to];
        const size = labelBox(systemLabelLines(link.label, wrapped));
        return {
          id: `l:${link.id}`,
          sources: [`n:${source}`],
          targets: [`n:${target}`],
          labels: [{ id: `t:${link.id}`, text: link.label, width: size.w, height: size.h }],
        };
      }),
  };
}

/** Reads the engine's result: every node and group rectangle, in drawing coordinates. */
function placed(result: ElkNode): {
  readonly nodes: ReadonlyMap<string, Rect>;
  readonly groups: ReadonlyMap<string, Rect>;
} {
  const walk = (node: ElkNode): readonly (readonly [string, Rect])[] =>
    (node.children ?? []).flatMap((child) => [
      [
        child.id,
        { x: child.x ?? 0, y: child.y ?? 0, w: child.width ?? 0, h: child.height ?? 0 },
      ] as const,
      ...walk(child),
    ]);
  const all = walk(result);
  const named = (prefix: string): ReadonlyMap<string, Rect> =>
    new Map(
      all.flatMap(([id, rect]) =>
        id.startsWith(prefix) === true ? [[id.slice(prefix.length), rect] as const] : [],
      ),
    );
  return { nodes: named("n:"), groups: named("g:") };
}

async function attempt(
  model: SystemModel,
  engine: LayoutEngine,
  direction: "right" | "down",
  wrapped: boolean,
  room: number,
): Promise<SystemLayout> {
  const result = await engine.layout(engineGraph(model, direction, wrapped));
  const { nodes, groups } = placed(result);
  const natural = Math.ceil(result.width ?? 0);
  const fits = natural <= room;
  // A drawing that fits is centred in the room; one that does not keeps its own width and scrolls.
  const shift = fits ? Math.floor((room - natural) / 2) : 0;
  const move = (rect: Rect): Rect => ({ ...rect, x: rect.x + shift });
  const boxes = model.nodes.flatMap((node): (readonly [string, SystemBox])[] => {
    const rect = nodes.get(node.id);
    if (rect === undefined) return [];
    const size = systemBoxSize(node);
    const textRoom = size.w - 2 * boxPad - shapeRoom[node.kind];
    const tint = model.groups.find((group) => group.id === node.group)?.tint;
    return [
      [
        node.id,
        {
          ...move(rect),
          ...size,
          id: node.id,
          kind: node.kind,
          label: node.label,
          ...(node.detail === undefined ? {} : { detail: node.detail }),
          ...(tint === undefined ? {} : { tint }),
          text: fitText(node.label, textRoom, charWidth.label),
          ...(node.detail === undefined
            ? {}
            : { detailText: fitText(node.detail, textRoom, charWidth.mono) }),
          lineTexts: node.lines.map((line) => fitText(line, textRoom, charWidth.mono)),
          top: node.kind === "store" ? storeTop : 0,
        },
      ],
    ];
  });
  return {
    direction,
    wrapped,
    fits,
    width: fits ? room : natural,
    height: Math.ceil(result.height ?? 0),
    boxes: new Map(boxes),
    groups: new Map(
      model.groups
        .toSorted((a, b) => Number(a.parent !== undefined) - Number(b.parent !== undefined))
        .flatMap((group): (readonly [string, SystemRegion])[] => {
          const rect = groups.get(group.id);
          return rect === undefined
            ? []
            : [
                [
                  group.id,
                  {
                    ...move(rect),
                    label: group.label,
                    tint: group.tint,
                    nested: group.parent !== undefined,
                  },
                ],
              ];
        }),
    ),
    labels: new Map(model.links.map((link) => [link.id, systemLabelLines(link.label, wrapped)])),
  };
}

/**
 * Lays a `System` out for `room` px: left to right, then top to bottom, then both again with link
 * labels on two lines. The first that fits wins; when none does, the narrowest is kept and the
 * drawing scrolls sideways rather than shrink its text.
 */
export async function layoutSystem(
  model: SystemModel,
  engine: LayoutEngine,
  room = columnWidth,
): Promise<SystemLayout> {
  const tries = [
    ["right", false],
    ["down", false],
    ["right", true],
    ["down", true],
  ] as const;
  const tried = await tries.reduce<Promise<readonly SystemLayout[]>>(
    async (previous, [direction, wrapped]) => {
      const done = await previous;
      if (done.some((layout) => layout.fits === true) === true) return done;
      return [...done, await attempt(model, engine, direction, wrapped, room)];
    },
    Promise.resolve([]),
  );
  const fitting = tried.find((layout) => layout.fits === true);
  // The first attempt always runs, so `tried` is never empty.
  return (
    fitting ??
    tried.reduce((narrowest, layout) => (layout.width < narrowest.width ? layout : narrowest))
  );
}

/** The layout issues of a `System` laid out at column width. */
export function systemLayoutIssues(layout: SystemLayout): readonly FigureIssue[] {
  return [
    ...(layout.fits
      ? []
      : [
          layoutIssue(
            "does not fit the column at a legible size; shorten the link labels or split the figure",
          ),
        ]),
    ...(layout.height > maximumHeight
      ? [
          layoutIssue(
            `the drawing is ${layout.height.toLocaleString("en-US")} px tall at column width; the limit is ${maximumHeight.toLocaleString("en-US")}. Split the figure or raise its level`,
          ),
        ]
      : []),
  ];
}

type Side = "left" | "right" | "top" | "bottom";
const normal: Readonly<Record<Side, readonly [number, number]>> = {
  left: [-1, 0],
  right: [1, 0],
  top: [0, -1],
  bottom: [0, 1],
};
const opposite: Readonly<Record<Side, Side>> = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
};

/** The sides a link leaves and enters by: along the flow when the boxes are apart along it. */
function sidesOf(a: Rect, b: Rect, direction: "right" | "down"): readonly [Side, Side] {
  const across: Side | undefined =
    b.x >= a.x + a.w ? "right" : b.x + b.w <= a.x ? "left" : undefined;
  const along: Side | undefined =
    b.y >= a.y + a.h ? "bottom" : b.y + b.h <= a.y ? "top" : undefined;
  const first = direction === "right" ? (across ?? along) : (along ?? across);
  // Coverage skip: laid-out boxes never overlap, so one axis always separates them.
  /* v8 ignore next -- @preserve */
  const side = first ?? "right";
  return [side, opposite[side]];
}

/** Where a link label sits: its centre, its size, and which way its text runs from there. */
type SystemLabelSpot = {
  /** The label's lines: one, or two when the layout wraps labels. */
  readonly lines: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly anchor: "middle" | "start";
};
export type SystemCurve = {
  readonly id: string;
  readonly kind: SystemLinkKind;
  readonly curve: Cubic;
  readonly label: SystemLabelSpot;
  /** `direct` between the facing sides, or the side a detour takes around the boxes in between. */
  readonly route: "direct" | Side;
};

/**
 * A curve from `a` to `b` that bows out on `side`, past every box between them. Its control
 * points sit where the curve's furthest point clears those boxes by `clearance`, within the drawing.
 */
export function systemDetour(
  a: Rect,
  b: Rect,
  side: Side,
  boxes: readonly Rect[],
  layout: Pick<SystemLayout, "width" | "height">,
  clearance: number,
  shift: number,
): Cubic {
  const upright = side === "left" || side === "right";
  const [x1, y1] = upright
    ? [side === "right" ? a.x + a.w : a.x, a.y + a.h / 2 + shift]
    : [a.x + a.w / 2 + shift, side === "bottom" ? a.y + a.h : a.y];
  const gap = side === "right" || side === "bottom" ? 2 : -2;
  const [x2, y2] = upright
    ? [side === "right" ? b.x + b.w + gap : b.x + gap, b.y + b.h / 2 + shift]
    : [b.x + b.w / 2 + shift, side === "bottom" ? b.y + b.h + gap : b.y + gap];
  const low = (rect: Rect): number => (upright ? rect.y : rect.x);
  const high = (rect: Rect): number => (upright ? rect.y + rect.h : rect.x + rect.w);
  const from = Math.min(low(a), low(b));
  const to = Math.max(high(a), high(b));
  const between = [a, b, ...boxes.filter((box) => high(box) > from && low(box) < to)];
  const outward = side === "right" || side === "bottom";
  const edge = outward
    ? Math.max(...between.map((box) => (upright ? box.x + box.w : box.y + box.h))) + clearance
    : Math.min(...between.map((box) => (upright ? box.x : box.y))) - clearance;
  const limit = upright ? layout.width : layout.height;
  const peak = Math.min(limit - 4, Math.max(4, edge));
  // A cubic whose control points share one coordinate reaches 3/4 of the way to it.
  const ends = upright ? (x1 + x2) / 8 : (y1 + y2) / 8;
  const control = (peak - ends) / 0.75;
  return upright
    ? [x1, y1, control, y1, control, y2, x2, y2]
    : [x1, y1, x1, control, x2, control, x2, y2];
}

const clear = (spot: SystemLabelSpot, boxes: readonly Rect[]): boolean =>
  boxes.every(
    (box) =>
      spot.x + spot.w / 2 < box.x ||
      spot.x - spot.w / 2 > box.x + box.w ||
      spot.y + spot.h / 2 < box.y ||
      spot.y - spot.h / 2 > box.y + box.h,
  );

/**
 * Every link of a `System` as one smooth curve between the outlines of its boxes. The links on one
 * side of a box are ranked by where their other end is and spread along that side, so no two
 * coincide. Each label sits on its curve, at the first spot clear of every box.
 */
export function systemLinkCurves(model: SystemModel, layout: SystemLayout): readonly SystemCurve[] {
  const drawn = model.links.flatMap((link) => {
    const from = layout.boxes.get(link.from);
    const to = layout.boxes.get(link.to);
    return from === undefined || to === undefined ? [] : [{ link, from, to }];
  });
  const ends = drawn.flatMap(({ link, from, to }, index) => {
    if (link.from === link.to) return [];
    const [leave, enter] = sidesOf(from, to, layout.direction);
    return [
      { index, end: "from" as const, box: from, side: leave, other: to },
      { index, end: "to" as const, box: to, side: enter, other: from },
    ];
  });
  const offsets = new Map(
    ends.map((end) => {
      const upright = end.side === "left" || end.side === "right";
      const centre = (rect: Rect): number => (upright ? rect.y + rect.h / 2 : rect.x + rect.w / 2);
      const peers = ends
        .filter((other) => other.box === end.box && other.side === end.side)
        .toSorted(
          (p, q) =>
            centre(p.other) - centre(q.other) || p.index - q.index || (p.end === "from" ? -1 : 1),
        );
      const room = (upright ? end.box.h : end.box.w) - 12;
      const step = Math.min(upright ? 12 : 16, room / Math.max(1, peers.length - 1));
      return [`${end.index}:${end.end}`, centred(peers.indexOf(end), peers.length, step)] as const;
    }),
  );
  const boxes = [...layout.boxes.values()];
  // Labels are placed in link order; each one keeps clear of the boxes and of the labels before it.
  return drawn.reduce<readonly SystemCurve[]>((placedCurves, { link, from, to }, index) => {
    const taken = [
      ...boxes,
      ...placedCurves.map(({ label }) => ({
        x: label.x - label.w / 2,
        y: label.y - label.h / 2,
        w: label.w,
        h: label.h,
      })),
    ];
    const lines = layout.labels.get(link.id) ?? [link.label];
    const size = labelBox(lines);
    if (link.from === link.to) {
      const right = from.x + from.w;
      const middle = from.y + from.h / 2;
      const loop: SystemCurve = {
        id: link.id,
        kind: link.kind,
        curve: [
          right,
          middle - 7,
          right + 34,
          middle - 24,
          right + 34,
          middle + 24,
          right + 2,
          middle + 7,
        ],
        label: { lines, x: right + 30, y: middle, w: size.w, h: size.h, anchor: "start" },
        route: "right",
      };
      return [...placedCurves, loop];
    }
    const [leave, enter] = sidesOf(from, to, layout.direction);
    const point = (
      box: Rect,
      side: Side,
      offset: number,
      gap: number,
    ): readonly [number, number] => {
      switch (side) {
        case "left":
          return [box.x - gap, box.y + box.h / 2 + offset];
        case "right":
          return [box.x + box.w + gap, box.y + box.h / 2 + offset];
        case "top":
          return [box.x + box.w / 2 + offset, box.y - gap];
        case "bottom":
          return [box.x + box.w / 2 + offset, box.y + box.h + gap];
        // Coverage skip: the compiler proves every side is handled; this arm cannot run.
        /* v8 ignore next 4 -- @preserve */
        default: {
          const exhaustive: never = side;
          return exhaustive;
        }
      }
    };
    const [x1, y1] = point(from, leave, offsets.get(`${index}:from`) ?? 0, 0);
    // The arrowhead needs two pixels in front of the target.
    const [x2, y2] = point(to, enter, offsets.get(`${index}:to`) ?? 0, 2);
    const reach = Math.max(
      18,
      (leave === "left" || leave === "right" ? Math.abs(x2 - x1) : Math.abs(y2 - y1)) * 0.5,
    );
    const [ax, ay] = normal[leave];
    const [bx, by] = normal[enter];
    const direct: Cubic = [
      x1,
      y1,
      x1 + ax * reach,
      y1 + ay * reach,
      x2 + bx * reach,
      y2 + by * reach,
      x2,
      y2,
    ];
    const others = boxes.filter((box) => box !== from && box !== to);
    const blocked = (candidate: Cubic): number =>
      others.filter((box) => crossesBox(candidate, box) === true).length;
    // A link that would run through another box bows out around the boxes in between instead.
    const sides: readonly Side[] =
      blocked(direct) === 0
        ? []
        : layout.direction === "down"
          ? ["right", "left"]
          : ["bottom", "top"];
    const { route, curve } = sides
      .map((side) => {
        // Each further detour on a side runs a little wider, and its ends move off the middle.
        const before = placedCurves.filter((earlier) => earlier.route === side).length;
        const shift = (before % 2 === 0 ? 1 : -1) * Math.ceil(before / 2) * 8;
        return {
          route: side,
          curve: systemDetour(from, to, side, others, layout, 22 + 12 * before, shift),
        };
      })
      .reduce<{ readonly route: "direct" | Side; readonly curve: Cubic }>(
        (best, option) => (blocked(option.curve) < blocked(best.curve) ? option : best),
        { route: "direct", curve: direct },
      );
    const spotAt = (t: number): SystemLabelSpot => {
      const [x, y] = pointAt(curve, t);
      return { lines, x, y, w: size.w, h: size.h, anchor: "middle" };
    };
    const middle = spotAt(0.5);
    const spots = [middle, ...[0.4, 0.6, 0.3, 0.7, 0.22, 0.78].map(spotAt)];
    // Clear of every box and every earlier label; else clear of the boxes; else on the middle.
    const label =
      spots.find((spot) => clear(spot, taken)) ??
      spots.find((spot) => clear(spot, boxes)) ??
      middle;
    return [...placedCurves, { id: link.id, kind: link.kind, curve, label, route }];
  }, []);
}
