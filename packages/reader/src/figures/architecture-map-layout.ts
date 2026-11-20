/**
 * The geometry of an `ArchitectureMap`: tiers as bands, boxes in balanced rows, sibling tiers side
 * by side with a wall. Every size derives from the tiers and their counts, with character-width
 * estimates for text. Nothing is measured, so the page and the figure check agree.
 */
import type { Rect } from "./curves.ts";
import { type FigureIssue, layoutIssue } from "./issues.ts";
import { type ArchitectureModel, type MapTier, tierUses } from "./architecture-map-model.ts";

/** The document column. */
export const columnWidth = 728;
/** The drawing width inside the Expand overlay. */
export const expandedWidth = 1180;
/** The tallest drawing the figure check accepts at column width. */
export const maximumHeight = 1200;

/** Every text size drawn in the map, in px. None is under 11. */
export const drawingFontSizes = {
  label: 12.5,
  detail: 11,
  tier: 11,
  margin: 11,
  link: 11,
  badge: 11,
} as const;

const margin = 120;
const marginText = 14;
const rightPad = 12;
const sidePad = 8;
const gap = 10;
const minBox = 132;
const maxBox = 190;
const boxHeight = 34;
const detailHeight = 46;
const lanePad = 14;
const wallGap = 16;
const barrierRow = 24;
const lineHeight = 14;
const boxPad = 8;
/** Average advance of one character at each text style, for fitting without measuring. */
const charWidth = { label: 7, mono: 6.6, ui: 6.2 } as const;

type HeaderLine = {
  readonly kind: "label" | "path" | "note" | "uses";
  readonly text: string;
  readonly x: number;
  readonly y: number;
};
type LaidBox = Rect & {
  readonly id: string;
  readonly tier: string;
  /** Picks the tint. */
  readonly order: number;
  /** The full label, for the tooltip, the panel and the text equivalent. */
  readonly label: string;
  /** The label as drawn: shortened by the tier path, then truncated to fit. */
  readonly text: string;
  readonly detail?: string;
  readonly detailText?: string;
};
type LaidTier = {
  readonly id: string;
  readonly order: number;
  /** The band, or the band's share for a sibling tier. */
  readonly band: Rect;
  /** The rectangle around the tier's boxes: where a bundled link arrives. */
  readonly area: Rect;
  readonly header: readonly HeaderLine[];
};
type LaidWall = {
  readonly x: number;
  readonly y1: number;
  readonly y2: number;
  readonly label?: string;
  readonly labelY: number;
};
export type ArchitectureLayout = {
  readonly width: number;
  readonly height: number;
  /** The y of each band boundary below the first band. */
  readonly rules: readonly number[];
  readonly tiers: ReadonlyMap<string, LaidTier>;
  readonly boxes: ReadonlyMap<string, LaidBox>;
  readonly walls: readonly LaidWall[];
};

/** Truncates `value` to the characters that fit `width` at `per` px each, with an ellipsis. */
export function fitText(value: string, width: number, per: number): string {
  const max = Math.max(2, Math.floor(width / per));
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** Greedy word wrap by character count. */
export function wrapText(value: string, max: number): readonly string[] {
  return value
    .split(" ")
    .filter((word) => word !== "")
    .reduce<string[]>((lines, word) => {
      const last = lines.at(-1);
      if (last !== undefined && last.length + 1 + word.length <= max)
        return [...lines.slice(0, -1), `${last} ${word}`];
      return [...lines, word];
    }, []);
}

/** "features/status" in the tier "features/" prints as "status". */
function shortLabel(tier: Pick<MapTier, "path">, label: string): string {
  const prefix = tier.path ?? "";
  return prefix.endsWith("/") === true &&
    label.startsWith(prefix) === true &&
    label.length > prefix.length
    ? label.slice(prefix.length)
    : label;
}

function headerLines(
  model: ArchitectureModel,
  tier: MapTier,
  x: number,
  top: number,
  width: number,
): readonly HeaderLine[] {
  const uses = tierUses(model, tier.id);
  const lines = [
    { kind: "label" as const, text: tier.label },
    ...wrapText(tier.path ?? "", Math.floor(width / charWidth.mono)).map((value) => ({
      kind: "path" as const,
      text: value,
    })),
    ...wrapText(tier.note ?? "", Math.floor(width / charWidth.ui)).map((value) => ({
      kind: "note" as const,
      text: value,
    })),
    ...(uses.length === 0
      ? []
      : wrapText(`uses ${uses.join(", ")}`, Math.floor(width / charWidth.ui)).map((value) => ({
          kind: "uses" as const,
          text: value,
        }))),
  ];
  return lines.map((line, index) => ({ ...line, x, y: top + 11 + index * lineHeight }));
}

const heightOf = (tier: MapTier): number =>
  tier.nodes.some((node) => node.detail !== undefined) === true ? detailHeight : boxHeight;

const rowsOf = (count: number, columns: number): number =>
  count === 0 ? 0 : Math.ceil(count / columns);

function placeBoxes(tier: MapTier, x: number, y: number, columns: number, w: number): LaidBox[] {
  const h = heightOf(tier);
  return tier.nodes.map((node, index) => {
    const short = shortLabel(tier, node.label);
    return {
      id: node.id,
      tier: tier.id,
      order: tier.order,
      x: x + (index % columns) * (w + gap),
      y: y + Math.floor(index / columns) * (h + gap),
      w,
      h,
      label: node.label,
      text: fitText(short, w - boxPad * 2, charWidth.label),
      ...(node.detail === undefined
        ? {}
        : {
            detail: node.detail,
            detailText: fitText(node.detail, w - boxPad * 2, charWidth.mono),
          }),
    };
  });
}

const areaOf = (boxes: readonly LaidBox[], fallback: Rect): Rect => {
  if (boxes.length === 0) return fallback;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  return {
    x: left,
    y: top,
    w: Math.max(...boxes.map((box) => box.x + box.w)) - left,
    h: Math.max(...boxes.map((box) => box.y + box.h)) - top,
  };
};

type Band = {
  readonly y: number;
  readonly height: number;
  readonly tiers: readonly LaidTier[];
  readonly boxes: readonly LaidBox[];
  readonly walls: readonly LaidWall[];
};

/** One tier alone in its band: its text in the left margin, its boxes to the right. */
function singleBand(model: ArchitectureModel, tier: MapTier, y: number, width: number): Band {
  const available = width - margin - rightPad;
  const count = tier.nodes.length;
  const maxColumns = Math.max(1, Math.floor((available + gap) / (minBox + gap)));
  const rows = rowsOf(count, Math.min(Math.max(count, 1), maxColumns));
  const columns = rows === 0 ? 1 : Math.ceil(count / rows);
  const w = Math.min(maxBox, (available - (columns - 1) * gap) / columns);
  const boxes = placeBoxes(tier, margin, y + lanePad, columns, w);
  const header = headerLines(model, tier, marginText, y + lanePad, margin - marginText - 8);
  const boxesHeight = rows * heightOf(tier) + Math.max(0, rows - 1) * gap;
  const height = Math.max(64, lanePad * 2 + boxesHeight, lanePad * 2 + header.length * lineHeight);
  const band = { x: 0, y, w: width, h: height };
  return {
    y,
    height,
    tiers: [{ id: tier.id, order: tier.order, band, area: areaOf(boxes, band), header }],
    boxes,
    walls: [],
  };
}

/**
 * Sibling tiers share a band, side by side. Columns go one at a time to the tier with the most
 * rows while every box keeps the minimum width, so the band is as short as the width allows.
 */
function siblingBand(
  model: ArchitectureModel,
  tiers: readonly MapTier[],
  y: number,
  width: number,
): Band {
  const available = width - sidePad * 2 - (tiers.length - 1) * wallGap;
  const fits = (columns: readonly number[]): boolean =>
    columns.reduce((sum, count) => sum + count * minBox + (count - 1) * gap, 0) <= available;
  const grow = (columns: readonly number[]): readonly number[] => {
    const rows = tiers.map((tier, index) => rowsOf(tier.nodes.length, columns[index] ?? 1));
    const tallest = rows.indexOf(Math.max(...rows));
    if ((rows[tallest] ?? 0) <= 1) return columns;
    const next = columns.map((count, index) => (index === tallest ? count + 1 : count));
    return fits(next) === true ? grow(next) : columns;
  };
  const columns = grow(tiers.map(() => 1)).map((count, index) => {
    const rows = rowsOf(tiers[index]?.nodes.length ?? 0, count);
    return rows === 0 ? 1 : Math.ceil((tiers[index]?.nodes.length ?? 0) / rows);
  });
  const total = columns.reduce((sum, count) => sum + count, 0);
  const w = Math.min(
    maxBox,
    (available - columns.reduce((sum, count) => sum + (count - 1) * gap, 0)) / total,
  );
  const widths = columns.map((count) => count * w + (count - 1) * gap);
  const starts = widths.map(
    (_, index) => sidePad + widths.slice(0, index).reduce((sum, value) => sum + value + wallGap, 0),
  );
  const headers = tiers.map((tier, index) =>
    headerLines(model, tier, starts[index] ?? 0, y + lanePad, widths[index] ?? 0),
  );
  const headerHeight = Math.max(...headers.map((lines) => lines.length)) * lineHeight + 6;
  const boxes = tiers.map((tier, index) =>
    placeBoxes(tier, starts[index] ?? 0, y + lanePad + headerHeight, columns[index] ?? 1, w),
  );
  const boxesHeight = Math.max(
    ...tiers.map((tier, index) => {
      const rows = rowsOf(tier.nodes.length, columns[index] ?? 1);
      return rows * heightOf(tier) + Math.max(0, rows - 1) * gap;
    }),
  );
  const walls = tiers.slice(1).map((tier, index) => {
    const left = tiers[index];
    const barrier = model.barriers.find(
      (item) =>
        (item.between[0] === left?.id && item.between[1] === tier.id) ||
        (item.between[1] === left?.id && item.between[0] === tier.id),
    );
    return {
      x: (starts[index + 1] ?? 0) - wallGap / 2,
      label: barrier?.label,
    };
  });
  const barred = walls.some((wall) => wall.label !== undefined) === true;
  const height = lanePad * 2 + headerHeight + boxesHeight + (barred === true ? barrierRow : 0);
  return {
    y,
    height,
    tiers: tiers.map((tier, index) => {
      const band = {
        x: (starts[index] ?? 0) - sidePad,
        y,
        w: (widths[index] ?? 0) + sidePad * 2,
        h: height,
      };
      return {
        id: tier.id,
        order: tier.order,
        band,
        area: areaOf(boxes[index] ?? [], band),
        header: headers[index] ?? [],
      };
    }),
    boxes: boxes.flat(),
    walls: walls.map((wall) => ({
      x: wall.x,
      y1: y + 6,
      // A labelled wall stops above its label.
      y2: wall.label === undefined ? y + height - 6 : y + height - barrierRow - 4,
      labelY: y + height - lanePad + 2,
      ...(wall.label === undefined ? {} : { label: wall.label }),
    })),
  };
}

/** Lays the map out at `width`: bands top to bottom, boxes sized from counts. */
export function layoutArchitecture(
  model: ArchitectureModel,
  width = columnWidth,
): ArchitectureLayout {
  const bands = model.rows.reduce<{ y: number; bands: Band[] }>(
    (acc, row) => {
      const band =
        row.length === 1 && row[0] !== undefined
          ? singleBand(model, row[0], acc.y, width)
          : siblingBand(model, row, acc.y, width);
      return { y: acc.y + band.height, bands: [...acc.bands, band] };
    },
    { y: 0, bands: [] },
  );
  const tiers = bands.bands.flatMap((band) => band.tiers);
  return {
    width,
    height: bands.y,
    rules: bands.bands.slice(1).map((band) => band.y),
    tiers: new Map(tiers.map((tier) => [tier.id, tier])),
    boxes: new Map(bands.bands.flatMap((band) => band.boxes).map((box) => [box.id, box])),
    walls: bands.bands.flatMap((band) => band.walls),
  };
}

/** The layout issues of a map laid out at column width. */
export function architectureLayoutIssues(layout: ArchitectureLayout): readonly FigureIssue[] {
  return layout.height > maximumHeight
    ? [
        layoutIssue(
          `the drawing is ${Math.round(layout.height).toLocaleString("en-US")} px tall at column width; the limit is ${maximumHeight.toLocaleString("en-US")}. Split the map or raise its level`,
        ),
      ]
    : [];
}
