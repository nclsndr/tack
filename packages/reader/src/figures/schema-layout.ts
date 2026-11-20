/**
 * The geometry of a `Schema`. Card sizes derive from text by rule; the layout engine packs the
 * cards into their groups and the groups into the column, and nothing else. The packing is chosen
 * here: each group may take one to three cards per row, and the combination that keeps the figure
 * shortest while it fits the column wins. Relations are drawn by the kit as curves between the rows
 * of the columns they join, so the look does not depend on the engine.
 */
import { crossesBox, type Cubic, pointAt, type Rect } from "./curves.ts";
import { type FigureIssue, layoutIssue } from "./issues.ts";
import { columnWidth, fitText, maximumHeight } from "./architecture-map-layout.ts";
import type { ElkNode, LayoutEngine } from "./layout-engine.ts";
import type { SchemaEnd, SchemaModel, SchemaRelation, SchemaTable } from "./schema-model.ts";

/** Every text size drawn in a `Schema`, in px. None is under 11. */
export const schemaDrawingSizes = {
  table: 12.5,
  column: 11,
  type: 11,
  note: 11,
  mark: 11,
  group: 11,
  link: 11,
} as const;

const charWidth = { table: 7, mono: 6.6, ui: 6.2 } as const;
/** The height a schema should keep to, so the reader sees it whole. */
const screenHeight = 900;
const header = 28;
const row = 20;
const noteLine = 14;
const uniqueLine = 16;
const minimumCard = 140;
const maximumCard = 280;
const grid = 4;
/**
 * The space between cards: wider when most relations carry a label, as in a domain model, since
 * labels sit between the cards; foreign keys carry none.
 */
const gapOf = (model: SchemaModel): number =>
  model.relations.filter((relation) => relation.label !== undefined).length * 2 >
  model.relations.length
    ? 44
    : 24;
const groupPad = { top: 32, side: 12 } as const;
/** Room at the right of a card's header for an access stamp. */
const stampRoom = 40;

/** One row of a card: where it starts, its height, and the y a relation attaches at. */
type CardRow = { readonly y: number; readonly h: number; readonly mid: number };
export type CardSize = {
  readonly w: number;
  readonly h: number;
  /** The header's height: the name, and the table note when there is one. */
  readonly head: number;
  /** The width of the key gutter: room for PK, FK and UQ marks, or a margin. */
  readonly gutter: number;
  readonly rows: readonly CardRow[];
};

/**
 * The size of a table's card, from its text by rule. Rows are relative to the card's top. A card
 * of a figure with an access lens keeps room in its header for the stamp.
 */
export function schemaCardSize(table: SchemaTable, stamped = false): CardSize {
  const keyed = table.columns.some((column) => column.key !== undefined || column.foreign);
  const gutter = keyed ? 32 : 10;
  const head = header + (table.note === undefined ? 0 : noteLine);
  const rows = table.columns.reduce<readonly CardRow[]>((done, column) => {
    const y = (done.at(-1)?.y ?? head) + (done.at(-1)?.h ?? 0);
    return [...done, { y, h: row + (column.note === undefined ? 0 : noteLine), mid: y + row / 2 }];
  }, []);
  const body = rows.reduce((sum, item) => sum + item.h, 0);
  const wanted = Math.max(
    20 + table.short.length * charWidth.table + (stamped ? stampRoom : 0),
    (table.note?.length ?? 0) * charWidth.ui + 20,
    ...table.columns.map(
      (column) =>
        gutter +
        (column.name.length + (column.nullable ? 1 : 0)) * charWidth.mono +
        (column.type === undefined ? 0 : 16 + column.type.length * charWidth.mono) +
        10,
    ),
    ...table.columns.map((column) => gutter + (column.note?.length ?? 0) * charWidth.ui + 10),
    ...table.unique.map((set) => 20 + `unique (${set.join(", ")})`.length * charWidth.ui),
  );
  return {
    w: Math.min(maximumCard, Math.max(minimumCard, Math.ceil(wanted / grid) * grid)),
    h: head + body + table.unique.length * uniqueLine + 6,
    head,
    gutter,
    rows,
  };
}

export type SchemaCard = Rect &
  CardSize & {
    readonly table: string;
    /** The name as drawn: the short name, truncated to fit. */
    readonly text: string;
    readonly tint?: number;
  };
type SchemaRegion = Rect & {
  readonly label: string;
  readonly note?: string;
  readonly tint: number;
};
export type SchemaLayout = {
  /** Whether the drawing fits the width it was laid out for. */
  readonly fits: boolean;
  readonly width: number;
  readonly height: number;
  readonly cards: ReadonlyMap<string, SchemaCard>;
  readonly groups: ReadonlyMap<string, SchemaRegion>;
  /** How many times a relation runs through a card, its own two included, away from its ends. */
  readonly crossings: number;
};

/**
 * Tables in an order that keeps related ones near each other: start at the edge of the relations,
 * with the least related table that has a relation, then take the table most related to the last one
 * taken, then to any taken, then the most related, so a hub sits between the tables it joins.
 */
export function packingOrder(
  tables: readonly SchemaTable[],
  relations: readonly SchemaRelation[],
): readonly SchemaTable[] {
  const pairs = relations.map((relation) => [relation.from.table, relation.to.table] as const);
  const between = (a: string, b: string): number =>
    pairs.filter(([x, y]) => (x === a && y === b) || (x === b && y === a)).length;
  const degree = (name: string): number =>
    tables.reduce((sum, other) => sum + (other.name === name ? 0 : between(name, other.name)), 0);
  return tables.reduce<readonly SchemaTable[]>((taken) => {
    const left = tables.filter((table) => taken.includes(table) === false);
    const last = taken.at(-1);
    const score = (table: SchemaTable): readonly number[] => [
      last === undefined
        ? degree(table.name) === 0
          ? -Infinity
          : -degree(table.name)
        : between(table.name, last.name),
      taken.reduce((sum, other) => sum + between(table.name, other.name), 0),
      degree(table.name),
    ];
    const best = left.reduce<SchemaTable | undefined>((winner, table) => {
      if (winner === undefined) return table;
      const [a, b, c] = score(table);
      const [x, y, z] = score(winner);
      return (a ?? 0) > (x ?? 0) ||
        (a === x && (b ?? 0) > (y ?? 0)) ||
        (a === x && b === y && (c ?? 0) > (z ?? 0))
        ? table
        : winner;
    }, undefined);
    return best === undefined ? taken : [...taken, best];
  }, []);
}

/** The engine's graph: groups packed in their own rows, then groups and loose cards in the column. */
function engineGraph(
  model: SchemaModel,
  ordered: readonly SchemaTable[],
  sizes: ReadonlyMap<string, CardSize>,
  columns: ReadonlyMap<string, number>,
  room: number,
): ElkNode {
  const gap = gapOf(model);
  const leaf = (table: SchemaTable): ElkNode => {
    const size = sizes.get(table.name);
    return { id: `t:${table.name}`, width: size?.w ?? minimumCard, height: size?.h ?? header };
  };
  const packing = (target: number): Readonly<Record<string, string>> => ({
    "elk.algorithm": "rectpacking",
    "elk.rectpacking.widthApproximation.strategy": "TARGET_WIDTH",
    "elk.rectpacking.widthApproximation.targetWidth": String(target),
    "elk.spacing.nodeNode": String(gap),
  });
  const firstIndex = (group: string): number => ordered.findIndex((table) => table.group === group);
  const blocks = [
    ...model.groups.map((group) => ({ at: firstIndex(group.id), group: group.id })),
    ...ordered.flatMap((table, at) => (table.group === undefined ? [{ at, table }] : [])),
  ].toSorted((a, b) => a.at - b.at);
  return {
    id: "root",
    layoutOptions: {
      ...packing(room - 2 * groupPad.side),
      "elk.padding": `[top=${groupPad.side},left=${groupPad.side},bottom=${groupPad.side},right=${groupPad.side}]`,
    },
    children: blocks.map((block): ElkNode => {
      if ("table" in block) return leaf(block.table);
      const members = ordered.filter((table) => table.group === block.group);
      const widest = Math.max(...members.map((table) => sizes.get(table.name)?.w ?? minimumCard));
      const count = columns.get(block.group) ?? 1;
      return {
        id: `g:${block.group}`,
        layoutOptions: {
          ...packing(count * widest + (count - 1) * gap),
          "elk.padding": `[top=${groupPad.top},left=${groupPad.side},bottom=${groupPad.side},right=${groupPad.side}]`,
        },
        children: members.map(leaf),
      };
    }),
  };
}

/** Every card and group rectangle of the engine's result, in drawing coordinates. */
function placed(result: ElkNode): ReadonlyMap<string, Rect> {
  const walk = (node: ElkNode, dx: number, dy: number): readonly (readonly [string, Rect])[] =>
    (node.children ?? []).flatMap((child) => {
      const x = dx + (child.x ?? 0);
      const y = dy + (child.y ?? 0);
      return [
        [child.id, { x, y, w: child.width ?? 0, h: child.height ?? 0 }] as const,
        ...walk(child, x, y),
      ];
    });
  return new Map(walk(result, 0, 0));
}

/** Every combination of cards per row, one to three per group; only the widest when too many. */
function combinations(model: SchemaModel): readonly ReadonlyMap<string, number>[] {
  const options = model.groups.map((group) => {
    const count = model.tables.filter((table) => table.group === group.id).length;
    return Array.from({ length: Math.min(3, count) }, (_, index) => index + 1);
  });
  const total = options.reduce((product, values) => product * values.length, 1);
  const lists = total > 64 ? options.map((values) => values.slice(-1)) : options;
  return lists
    .reduce<readonly (readonly number[])[]>(
      (sets, values) => sets.flatMap((set) => values.map((value) => [...set, value])),
      [[]],
    )
    .map((set) => new Map(model.groups.map((group, index) => [group.id, set[index] ?? 1])));
}

/** Whether a figure's cards keep room for an access stamp: it has a lens with access. */
const stampedModel = (model: SchemaModel): boolean =>
  model.cases.some((item) => item.kind === "lens" && item.access !== undefined);

/**
 * The engine's graph for a figure without groups, as an alternative to packing: layered along its
 * relations, so related cards sit in neighbouring layers and relations rarely cross a card.
 */
function layeredGraph(
  model: SchemaModel,
  sizes: ReadonlyMap<string, CardSize>,
  direction: "DOWN" | "RIGHT",
): ElkNode {
  const gap = gapOf(model);
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.spacing.nodeNode": String(gap),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(gap + 32),
      "elk.padding": `[top=${groupPad.side},left=${groupPad.side},bottom=${groupPad.side},right=${groupPad.side}]`,
    },
    children: model.tables.map((table) => ({
      id: `t:${table.name}`,
      width: sizes.get(table.name)?.w ?? minimumCard,
      height: sizes.get(table.name)?.h ?? header,
    })),
    edges: model.relations.map((relation) => ({
      id: relation.id,
      sources: [`t:${relation.from.table}`],
      targets: [`t:${relation.to.table}`],
    })),
  };
}

async function attempt(
  model: SchemaModel,
  engine: LayoutEngine,
  graph: ElkNode,
  room: number,
): Promise<SchemaLayout> {
  const stamped = stampedModel(model);
  const sizes = new Map(model.tables.map((table) => [table.name, schemaCardSize(table, stamped)]));
  const result = await engine.layout(graph);
  const rects = placed(result);
  const natural = Math.ceil(result.width ?? 0);
  const fits = natural <= room;
  const shift = fits ? Math.floor((room - natural) / 2) : 0;
  const move = (rect: Rect): Rect => ({ ...rect, x: rect.x + shift });
  const cards = model.tables.flatMap((table): (readonly [string, SchemaCard])[] => {
    const rect = rects.get(`t:${table.name}`);
    const size = sizes.get(table.name);
    if (rect === undefined || size === undefined) return [];
    const tint = model.groups.find((group) => group.id === table.group)?.tint;
    return [
      [
        table.name,
        {
          ...move(rect),
          ...size,
          table: table.name,
          text: fitText(table.short, size.w - 20 - (stamped ? stampRoom : 0), charWidth.table),
          ...(tint === undefined ? {} : { tint }),
        },
      ],
    ];
  });
  const laid = {
    fits,
    width: fits ? room : natural,
    height: Math.ceil(result.height ?? 0),
    crossings: 0,
    cards: new Map(cards),
    groups: new Map(
      model.groups.flatMap((group): (readonly [string, SchemaRegion])[] => {
        const rect = rects.get(`g:${group.id}`);
        return rect === undefined
          ? []
          : [
              [
                group.id,
                {
                  ...move(rect),
                  label: group.label,
                  ...(group.note === undefined ? {} : { note: group.note }),
                  tint: group.tint,
                },
              ],
            ];
      }),
    ),
  };
  const cardList = [...laid.cards.values()];
  return {
    ...laid,
    crossings: schemaRelationCurves(model, laid).reduce(
      (sum, curve) =>
        sum + cardList.filter((card) => crossesBox(curve.curve, card) === true).length,
      0,
    ),
  };
}

/**
 * Lays a `Schema` out for `room` px. Every packing of one to three cards per row in each group is
 * tried, with the tables in their packing order and in reverse; a figure without groups is also
 * laid out in layers along its relations, down and across. Of the layouts that fit, the one
 * whose relations cross fewest cards wins, then the shortest; when none fits the narrowest is kept
 * and scrolls.
 */
export async function layoutSchema(
  model: SchemaModel,
  engine: LayoutEngine,
  room = columnWidth,
): Promise<SchemaLayout> {
  const order = packingOrder(model.tables, model.relations);
  const stamped = stampedModel(model);
  const sizes = new Map(model.tables.map((table) => [table.name, schemaCardSize(table, stamped)]));
  const pack = (ordered: readonly SchemaTable[], columns: ReadonlyMap<string, number>) =>
    attempt(model, engine, engineGraph(model, ordered, sizes, columns, room), room);
  /**
   * Short before symmetric: a layout that fits a screen beats a taller one. Then crossings weigh
   * more than height: one card crossed costs as much as 200 px.
   */
  const cost = (layout: SchemaLayout): number =>
    layout.fits
      ? (layout.height > screenHeight ? 10_000 : 0) + layout.crossings * 200 + layout.height
      : Number.POSITIVE_INFINITY;
  const better = (a: SchemaLayout, b: SchemaLayout): SchemaLayout => {
    if (a.fits !== b.fits) return a.fits ? a : b;
    if (a.fits) return cost(a) < cost(b) ? a : b;
    return a.width < b.width ? a : b;
  };
  const tried = await Promise.all(
    [order, order.toReversed()].flatMap((ordered) =>
      combinations(model).map(async (columns) => ({
        ordered,
        columns,
        layout: await pack(ordered, columns),
      })),
    ),
  );
  const layered = await Promise.all(
    model.groups.length > 0
      ? []
      : (["DOWN", "RIGHT"] as const).map((direction) =>
          attempt(model, engine, layeredGraph(model, sizes, direction), room),
        ),
  );
  const ranked = tried.toSorted((a, b) => cost(a.layout) - cost(b.layout));
  /**
   * While the best packings still cross a card, swap two tables of one group at a time and keep
   * any swap that lowers the cost: four rounds on the eight best packings.
   */
  const improve = async (start: (typeof tried)[number], rounds: number): Promise<SchemaLayout> => {
    if (rounds === 0 || start.layout.crossings === 0) return start.layout;
    const swaps = start.ordered.flatMap((a, i) =>
      start.ordered
        .slice(i + 1)
        .flatMap((b, offset) => (a.group === b.group ? [[i, i + 1 + offset] as const] : [])),
    );
    const candidates = await Promise.all(
      swaps.map(async ([i, j]) => {
        const ordered = start.ordered.map((table, index) =>
          index === i
            ? (start.ordered[j] ?? table)
            : index === j
              ? (start.ordered[i] ?? table)
              : table,
        );
        return {
          ordered,
          columns: start.columns,
          layout: await pack(ordered, start.columns),
        };
      }),
    );
    const best = candidates.reduce(
      (winner, item) => (cost(item.layout) < cost(winner.layout) ? item : winner),
      start,
    );
    return best === start ? start.layout : improve(best, rounds - 1);
  };
  const improved = await Promise.all(ranked.slice(0, 8).map((item) => improve(item, 4)));
  // There is always one packing at least: the first order with one card per row.
  return [...tried.map((item) => item.layout), ...improved, ...layered].reduce(better);
}

/** The layout issues of a `Schema` laid out at column width. */
export function schemaLayoutIssues(layout: SchemaLayout): readonly FigureIssue[] {
  return [
    ...(layout.fits
      ? []
      : [
          layoutIssue(
            "does not fit the column at a legible size; shorten the column names or split the figure by group",
          ),
        ]),
    ...(layout.height > maximumHeight
      ? [
          layoutIssue(
            `the drawing is ${layout.height.toLocaleString("en-US")} px tall at column width; the limit is ${maximumHeight.toLocaleString("en-US")}. Split the figure by group`,
          ),
        ]
      : []),
  ];
}

/** Where a relation attaches to a card: the row of its column, or the header for a table. */
export function anchorY(card: SchemaCard, model: SchemaModel, end: SchemaEnd): number {
  const table = model.tables.find((candidate) => candidate.name === end.table);
  const index = table?.columns.findIndex((column) => column.name === end.column) ?? -1;
  const target = card.rows[index];
  return target === undefined ? card.y + card.head / 2 : card.y + target.mid;
}

export type SchemaCurve = {
  readonly id: string;
  /** Across the gap between two cards, an arc beside them, or under or over the cards between. */
  readonly route: "across" | "beside" | "under" | "over";
  readonly tables: readonly [string, string];
  readonly curve: Cubic;
  /** Crow's feet and bars at the ends, from the cardinality, as one path. */
  readonly marks: string;
  /** The label's centre, for a relation that has one. */
  readonly label?: { readonly x: number; readonly y: number };
};

/** A crow's foot (many) or a bar (one) at `x`, `y` on a side whose outward normal is `n`. */
function mark(x: number, y: number, n: number, many: boolean): string {
  if (many) {
    const q = x + n * 12;
    return `M ${q} ${y} L ${x} ${y - 6} M ${q} ${y} L ${x} ${y} M ${q} ${y} L ${x} ${y + 6}`;
  }
  const b = x + n * 7;
  return `M ${b} ${y - 6} L ${b} ${y + 6}`;
}

/** Which ends of a relation are "many": from the cardinality. */
const manyEnds = (relation: SchemaRelation): readonly [boolean, boolean] | undefined => {
  switch (relation.cardinality) {
    case "many-to-one":
      return [true, false];
    case "one-to-many":
      return [false, true];
    case "many-to-many":
      return [true, true];
    case "one-to-one":
      return [false, false];
    case undefined:
      return undefined;
    // Coverage skip: the compiler proves every cardinality is handled; this arm cannot run.
    /* v8 ignore next 4 -- @preserve */
    default: {
      const exhaustive: never = relation.cardinality;
      return exhaustive;
    }
  }
};

/**
 * Every relation as one smooth curve from the row of its column to the row of the column it joins,
 * leaving and entering a card at its side. Cards side by side are joined across the gap; cards one
 * above the other are joined by an arc on the side nearer the drawing's edge, wider for each arc
 * already on that side of the card.
 */
export function schemaRelationCurves(
  model: SchemaModel,
  layout: SchemaLayout,
): readonly SchemaCurve[] {
  const cards = [...layout.cards.values()];
  const labelHeight = 14;
  const labelBox = (curve: SchemaCurve): readonly Rect[] => {
    const text = model.relations.find((relation) => relation.id === curve.id)?.label;
    if (curve.label === undefined || text === undefined) return [];
    const w = text.length * charWidth.mono + 10;
    return [{ x: curve.label.x - w / 2, y: curve.label.y - labelHeight / 2, w, h: labelHeight }];
  };
  return model.relations.reduce<readonly SchemaCurve[]>((done, relation) => {
    const from = layout.cards.get(relation.from.table);
    const to = layout.cards.get(relation.to.table);
    if (from === undefined || to === undefined) return done;
    const y1 = anchorY(from, model, relation.from);
    const y2 = anchorY(to, model, relation.to);
    const apart = to.x >= from.x + from.w ? 1 : to.x + to.w <= from.x ? -1 : 0;
    const nearer = (from.x + from.w / 2 + to.x + to.w / 2) / 2 < layout.width / 2 ? -1 : 1;
    // A curve crosses no card, its own two included: it leaves and enters them at their edge.
    const blocked = (candidate: Cubic): number =>
      cards.filter((card) => crossesBox(candidate, card) === true).length;
    const arcs = done.filter(
      (other) =>
        other.route === "beside" &&
        other.tables.some((name) => name === relation.from.table || name === relation.to.table),
    ).length;
    type Option = {
      readonly route: SchemaCurve["route"];
      readonly curve: Cubic;
      readonly n1: number;
      readonly n2: number;
    };
    /** An arc beside both cards on `side`, reaching `reach` px out. */
    const beside = (side: number, reach: number): Option => {
      const x1 = side > 0 ? from.x + from.w : from.x;
      const x2 = side > 0 ? to.x + to.w : to.x;
      const out = side > 0 ? Math.max(x1, x2) + reach : Math.min(x1, x2) - reach;
      return { route: "beside", curve: [x1, y1, out, y1, out, y2, x2, y2], n1: side, n2: side };
    };
    /** Straight across the gap between two cards side by side. */
    const across = (): Option => {
      const x1 = apart > 0 ? from.x + from.w : from.x;
      const x2 = apart > 0 ? to.x : to.x + to.w;
      const reach = Math.max(24, Math.abs(x2 - x1) / 2);
      return {
        route: "across",
        curve: [x1, y1, x1 + apart * reach, y1, x2 - apart * reach, y2, x2, y2],
        n1: apart,
        n2: -apart,
      };
    };
    /** Under or over the cards between, leaving each card at the side that faces the other. */
    const sag = (under: boolean, start: Option): Option => {
      const [x1, , , , , , x2] = start.curve;
      const top = Math.min(from.y, to.y);
      const bottom = Math.max(from.y + from.h, to.y + to.h);
      const between = cards.filter(
        (card) =>
          card.x < Math.max(x1, x2) &&
          card.x + card.w > Math.min(x1, x2) &&
          card.y < bottom &&
          card.y + card.h > top,
      );
      const edge = under
        ? Math.min(
            layout.height - 4,
            Math.max(bottom, ...between.map((card) => card.y + card.h)) + 14,
          )
        : Math.max(4, Math.min(top, ...between.map((card) => card.y)) - 14);
      // A cubic whose two controls share a y peaks at 1/8 of the ends and 3/4 of the controls.
      const control = (edge - (y1 + y2) / 8) / 0.75;
      return {
        route: under ? "under" : "over",
        curve: [x1, y1, x1 + start.n1 * 24, control, x2 + start.n2 * 24, control, x2, y2],
        n1: start.n1,
        n2: start.n2,
      };
    };
    const first =
      apart === 0
        ? [nearer, -nearer].flatMap((side) =>
            [26 + 10 * arcs, 16, 10].map((reach) => beside(side, reach)),
          )
        : [across()];
    const start = first[0] ?? across();
    const options = [...first, sag(true, start), sag(false, start)];
    // The first option, in order of preference, that crosses no card; else the one crossing fewest.
    const chosen =
      options.find((option) => blocked(option.curve) === 0) ??
      options.reduce((best, option) =>
        blocked(option.curve) < blocked(best.curve) ? option : best,
      );
    const { curve, n1, n2, route } = chosen;
    const ends = manyEnds(relation);
    const marks =
      ends === undefined
        ? ""
        : `${mark(curve[0], curve[1], n1, ends[0])} ${mark(curve[6], curve[7], n2, ends[1])}`;
    return [
      ...done,
      {
        id: relation.id,
        route,
        tables: [relation.from.table, relation.to.table],
        curve,
        marks,
        ...(relation.label === undefined
          ? {}
          : {
              label: labelSpot(
                curve,
                relation.label,
                [...cards, ...done.flatMap(labelBox)],
                layout,
              ),
            }),
      },
    ];
  }, []);
}

/**
 * Where a relation's label sits: the first point along its curve, from the middle out, where the
 * label covers no card and no earlier label; else just above or below the cards at its ends; else
 * the middle of the curve.
 */
function labelSpot(
  curve: Cubic,
  label: string,
  cards: readonly Rect[],
  layout: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  const w = label.length * charWidth.mono + 10;
  const h = 14;
  const free = ([x, y]: readonly [number, number]): boolean =>
    x - w / 2 >= 0 &&
    x + w / 2 <= layout.width &&
    y - h / 2 >= 0 &&
    y + h / 2 <= layout.height &&
    cards.every(
      (card) =>
        x + w / 2 <= card.x ||
        x - w / 2 >= card.x + card.w ||
        y + h / 2 <= card.y ||
        y - h / 2 >= card.y + card.h,
    );
  const along = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8].map((t) => pointAt(curve, t));
  const [mx] = pointAt(curve, 0.5);
  const ends = [curve[1], curve[7]];
  // The cards the label would sit on at the middle, at the height of either end.
  const touching = cards.filter(
    (card) =>
      card.x < mx + w / 2 &&
      card.x + card.w > mx - w / 2 &&
      ends.some((y) => y >= card.y && y <= card.y + card.h),
  );
  const clear = [
    ...along,
    [mx, Math.min(...touching.map((card) => card.y), ...ends) - 10] as const,
    [mx, Math.max(...touching.map((card) => card.y + card.h), ...ends) + 10] as const,
  ];
  const [x, y] = clear.find(free) ?? pointAt(curve, 0.5);
  // A label that finds no free spot still stays inside the drawing.
  return { x: Math.min(Math.max(x, w / 2), layout.width - w / 2), y };
}
