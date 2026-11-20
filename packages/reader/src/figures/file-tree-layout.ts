/**
 * The geometry of a `FileTree`: one row per entry on the ruled pitch, names indented by depth,
 * symlink arrows in lanes right of every name, an aligned notes column and a size column with
 * bars to scale. Every size derives from the text by character-width estimates; nothing is
 * measured, so the page and the figure check agree.
 */
import { type FigureIssue, layoutIssue } from "./issues.ts";
import { fitText, maximumHeight, wrapText } from "./architecture-map-layout.ts";
import { figureLook } from "./look.ts";
import type { TreeModel } from "./file-tree-model.ts";

/** The tree's measures, in px. */
export const treeGeometry = {
  width: 728,
  /** One ruled line per row: the ground's pitch. */
  pitch: figureLook.ruledPitch,
  pad: 16,
  indent: 16,
  /** From the guide to the first character of a name. */
  inset: 10,
  /** Advance of one character of a 12.5 px mono name, and of an 11 px UI note. */
  nameChar: 7.5,
  noteChar: 6.2,
  lane: 10,
  /** Room the size text and its bar take on the right. */
  sizeColumn: 116,
  bar: 52,
  /** Room the "absent" stamp takes when a lens can show it and there is no size column. */
  stamp: 52,
  /** Notes narrower than this are squeezed. */
  minimumNotes: 140,
  noteLines: 2,
} as const;

type TreeRow = {
  readonly id: string;
  readonly y: number;
  readonly h: number;
  /** Where the row's guide is; the name starts `inset` to the right. */
  readonly x: number;
  /** Where the name and its target text end. */
  readonly nameEnd: number;
  /** The note, wrapped to at most two lines. */
  readonly note: readonly string[];
  /** The width of the size bar, when the entry has a size. */
  readonly bar?: number;
};

export type TreeArrow = {
  readonly from: string;
  readonly to: string;
  /** The x of the lane the arrow runs in. */
  readonly x: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
};

type TreeGuide = {
  readonly x: number;
  readonly y1: number;
  readonly y2: number;
  readonly ticks: readonly number[];
};

export type TreeLayout = {
  readonly width: number;
  readonly height: number;
  readonly rows: ReadonlyMap<string, TreeRow>;
  readonly arrows: readonly TreeArrow[];
  readonly guides: readonly TreeGuide[];
  readonly notesX: number;
  /** Where notes must end. */
  readonly notesEnd: number;
  /** The right edge of the "absent" stamp. */
  readonly stampX: number;
  /** The right edge of the size text, when the tree has sizes. */
  readonly sizeX?: number;
  /** The notes that did not fit two lines. */
  readonly truncated: readonly string[];
};

/** The text drawn on a row: the name, and its target when it is a link. */
export const rowText = (entry: { readonly name: string; readonly target?: string }): string =>
  entry.target === undefined ? entry.name : `${entry.name} -> ${entry.target}`;

/** Lays the tree out at column width. */
export function layoutFileTree(model: TreeModel): TreeLayout {
  const g = treeGeometry;
  const nameX = (depth: number): number => g.pad + depth * g.indent;
  const nameEnds = new Map(
    model.entries.map((entry) => [
      entry.id,
      nameX(entry.depth) + g.inset + rowText(entry).length * g.nameChar,
    ]),
  );
  const lanesX = Math.max(g.pad, ...nameEnds.values()) + g.lane;
  const index = new Map(model.entries.map((entry, at) => [entry.id, at]));
  // Shorter arrows take inner lanes; an arrow takes the first lane free over its whole span.
  const spans = [...model.links]
    .flatMap(([from, link]) => {
      const a = index.get(from);
      const b = index.get(link.arrow);
      return a === undefined || b === undefined || a === b
        ? []
        : [{ from, to: link.arrow, low: Math.min(a, b), high: Math.max(a, b) }];
    })
    .toSorted((p, q) => p.high - p.low - (q.high - q.low) || p.low - q.low);
  const lanes = spans.reduce<{ readonly low: number; readonly high: number }[][]>((acc, span) => {
    const free = acc.findIndex((lane) =>
      lane.every((other) => span.high < other.low || span.low > other.high),
    );
    if (free === -1) return [...acc, [span]];
    return acc.map((lane, at) => (at === free ? [...lane, span] : lane));
  }, []);
  const laneOf = (span: (typeof spans)[number]): number =>
    lanes.findIndex((lane) => lane.includes(span));
  const notesX = lanesX + (lanes.length === 0 ? 0 : lanes.length * g.lane + g.lane);
  const hasSizes = model.entries.some((entry) => entry.size !== undefined);
  const hasStamps = model.lenses.length > 0 && model.entries.some((entry) => entry.temp === true);
  const sizeX = hasSizes ? g.width - g.pad - g.bar - 8 : undefined;
  // The "absent" stamp sits in the size column when there is one, else it takes its own room.
  const notesEnd = hasSizes
    ? g.width - g.pad - g.sizeColumn
    : g.width - g.pad - (hasStamps ? g.stamp : 0);
  const perLine = Math.max(8, Math.floor((notesEnd - notesX) / g.noteChar));
  const largest = Math.max(0, ...model.entries.map((entry) => entry.size?.bytes ?? 0));
  const truncated: string[] = [];
  const rows = model.entries.reduce<{ readonly y: number; readonly rows: TreeRow[] }>(
    (acc, entry) => {
      const wrapped = entry.note === undefined ? [] : wrapText(entry.note, perLine);
      const fits = wrapped.length <= g.noteLines;
      if (fits === false) truncated.push(entry.id);
      const note = fits
        ? wrapped
        : [
            ...wrapped.slice(0, g.noteLines - 1),
            fitText(wrapped.slice(g.noteLines - 1).join(" "), perLine * g.noteChar, g.noteChar),
          ];
      const h = Math.max(1, note.length) * g.pitch;
      const row: TreeRow = {
        id: entry.id,
        y: acc.y,
        h,
        x: nameX(entry.depth),
        nameEnd: nameEnds.get(entry.id) ?? 0,
        note,
        ...(entry.size === undefined || largest === 0
          ? {}
          : { bar: Math.max(2, (g.bar * entry.size.bytes) / largest) }),
      };
      return { y: acc.y + h, rows: [...acc.rows, row] };
    },
    { y: 0, rows: [] },
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const middle = (row: TreeRow): number => row.y + g.pitch / 2;
  const arrows = spans.flatMap((span): TreeArrow[] => {
    const from = byId.get(span.from);
    const to = byId.get(span.to);
    if (from === undefined || to === undefined) return [];
    return [
      {
        from: span.from,
        to: span.to,
        x: lanesX + laneOf(span) * g.lane + g.lane / 2,
        x1: from.nameEnd + 6,
        y1: middle(from),
        x2: to.nameEnd + 6,
        y2: middle(to),
      },
    ];
  });
  const guides = model.entries.flatMap((entry): TreeGuide[] => {
    const row = byId.get(entry.id);
    const children = model.entries.filter((child) => child.parent === entry.id);
    const last = byId.get(children.at(-1)?.id ?? "");
    if (row === undefined || last === undefined) return [];
    return [
      {
        x: row.x + 4,
        y1: row.y + g.pitch - 5,
        y2: middle(last),
        ticks: children.flatMap((child) => {
          const at = byId.get(child.id);
          return at === undefined ? [] : [middle(at)];
        }),
      },
    ];
  });
  return {
    width: g.width,
    height: rows.y,
    rows: byId,
    arrows,
    guides,
    notesX,
    notesEnd,
    stampX: sizeX ?? g.width - g.pad,
    ...(sizeX === undefined ? {} : { sizeX }),
    truncated,
  };
}

/** Defects only the layout shows: squeezed notes, a note over two lines, a tree too tall. */
export function fileTreeLayoutIssues(layout: TreeLayout): readonly FigureIssue[] {
  const room = Math.round(layout.notesEnd - layout.notesX);
  const hasNotes = [...layout.rows.values()].some((row) => row.note.length > 0);
  return [
    ...(hasNotes && room < treeGeometry.minimumNotes
      ? [layoutIssue(`the names leave ${room} px for notes; shorten the longest name or target`)]
      : []),
    ...layout.truncated.map((id) =>
      layoutIssue(`the note of "${id}" does not fit two lines; shorten it`),
    ),
    ...(layout.height > maximumHeight
      ? [
          layoutIssue(
            `the tree is ${layout.height} px tall; the budget is ${maximumHeight.toLocaleString("en-US")} px. Fold entries into ...`,
          ),
        ]
      : []),
  ];
}
