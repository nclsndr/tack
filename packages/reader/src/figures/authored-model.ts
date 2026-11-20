/**
 * The model of an authored figure: the frame's props plus a drawing made of kit elements at
 * explicit positions. The page builds the input from its React children and the figure check
 * builds it from the MDX source; both call `readAuthoredFigure`, so they list the same issues.
 * Boxes size themselves from their text and the kit routes links, so every overlap, overflow and
 * crossing can be checked here, without a browser.
 */
import { type Cubic, edgeOf, fanSpreads, pointAt, type Rect, route } from "./curves.ts";
import {
  claimIssues,
  type FigureIssue,
  idIssues,
  inputIssue,
  layoutIssue,
  list,
  record,
  text,
} from "./issues.ts";
import { figureKinds, type FigureKind } from "./look.ts";
import { maximumHeight } from "./architecture-map-layout.ts";
import type { ReactNode } from "react";

/** The kit elements an author places in a `Drawing`. `raw` is any other SVG shape. */
export const kitElements = ["box", "link", "band", "badge", "note", "label", "raw"] as const;
export type KitElementName = (typeof kitElements)[number];

/** One element of a drawing as data: its kind and its props. */
export type AuthoredElement = {
  readonly element: KitElementName;
  readonly props: Readonly<Record<string, unknown>>;
};

/** What the page and the check pass in: the figure's props and its drawing's elements. */
export type AuthoredInput = Readonly<Record<string, unknown>> & {
  readonly drawing: { readonly height?: unknown; readonly elements: readonly AuthoredElement[] };
};

export const boxShapes = ["plain", "store", "queue", "external", "actor", "sheet"] as const;
export type BoxShape = (typeof boxShapes)[number];
export const linkStyles = ["solid", "dashed", "muted"] as const;
export type LinkStyle = (typeof linkStyles)[number];

/** The props of an authored `Figure`: the frame's, and one `Drawing` as its child. */
export type FigureProps = {
  readonly id: string;
  readonly title: string;
  /** What the figure depicts; it picks the ground. Defaults to `system`. */
  readonly kind?: Exclude<FigureKind, "steps" | "quantities">;
  readonly summary?: string;
  readonly rule?: { readonly title: string; readonly text: string };
  readonly startWith?: readonly string[];
  readonly replays?: readonly {
    readonly id?: string;
    readonly label: string;
    readonly steps: readonly { readonly at: string; readonly note: string }[];
  }[];
  readonly lenses?: readonly {
    readonly id?: string;
    readonly label: string;
    readonly note: string;
    readonly focus?: readonly string[];
    readonly blocked?: readonly string[];
    readonly broken?: readonly string[];
  }[];
  /** Names for what the drawing uses: `solid`, `dashed`, `muted`, `tint-1` to `tint-6`, a shape. */
  readonly legend?: Readonly<Record<string, string>>;
  readonly children?: ReactNode;
};
/** The drawing's width: the document column. */
const drawingWidth = 728;

/** The limits an authored figure is checked against. */
export const authoredBudget = {
  boxes: 24,
  steps: 12,
  /** Links are drawn at rest up to this many boxes, and only on focus above it. */
  linksAtRestUpTo: 12,
} as const;

/** The two text sizes of a drawing, and the advance of one character of each, in px. */
export const authoredText = {
  label: { size: 12.5, char: 7 },
  detail: { size: 11, char: 6.6 },
  small: { size: 11, char: 6.2 },
} as const;

const boxPad = 8;
const minimumBox = 48;
const grid = 4;

/** The size of a box: from its text on the 4 px grid, or the width the author gave. */
export function boxSize(box: {
  readonly label?: string;
  readonly detail?: string;
  readonly shape?: string;
  readonly w?: number;
}): { readonly w: number; readonly h: number } {
  const needed = boxNeeds(box);
  return {
    w: box.w ?? Math.max(minimumBox, Math.ceil(needed / grid) * grid),
    h: box.detail === undefined ? 34 : 46,
  };
}

/** The width a box's text needs, with its padding and the room its shape takes. */
function boxNeeds(box: {
  readonly label?: string;
  readonly detail?: string;
  readonly shape?: string;
}): number {
  const textWidth = Math.max(
    (box.label?.length ?? 0) * authoredText.label.char,
    (box.detail?.length ?? 0) * authoredText.detail.char,
  );
  return textWidth + 2 * boxPad + (box.shape === "queue" ? 16 : 0);
}

type AuthoredBox = Rect & {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly about?: string;
  /** 0 to 5, or none. */
  readonly tint?: number;
  readonly shape: BoxShape;
  /** False for a box without an id: drawn, but in no focus or case. */
  readonly named: boolean;
};
type AuthoredLink = {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly style: LinkStyle;
  readonly curve: Cubic;
};
type AuthoredBand = Rect & { readonly label: string; readonly tint?: number };
type AuthoredBadge = { readonly at: string; readonly n: number };
type AuthoredNote = {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly to?: { readonly x: number; readonly y: number };
};
type AuthoredLabel = {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly size: "large" | "small";
  readonly anchor: "start" | "middle" | "end";
};
export type AuthoredCase =
  | {
      readonly kind: "replay";
      readonly id: string;
      readonly label: string;
      readonly steps: readonly { readonly at: string; readonly note: string }[];
    }
  | {
      readonly kind: "lens";
      readonly id: string;
      readonly label: string;
      readonly note: string;
      readonly focus: readonly string[];
      readonly blocked: readonly string[];
      readonly broken: readonly string[];
    };

export type AuthoredModel = {
  readonly id: string;
  readonly kind: FigureKind;
  readonly title: string;
  readonly summary?: string;
  readonly rule?: { readonly title: string; readonly text: string };
  readonly height: number;
  readonly bands: readonly AuthoredBand[];
  readonly boxes: readonly AuthoredBox[];
  readonly links: readonly AuthoredLink[];
  readonly badges: readonly AuthoredBadge[];
  readonly notes: readonly AuthoredNote[];
  readonly labels: readonly AuthoredLabel[];
  /** The number of raw SVG shapes, which the check cannot verify. */
  readonly raw: number;
  readonly startWith: readonly string[];
  readonly cases: readonly AuthoredCase[];
  /** Names for what the drawing uses: link styles, tints (`tint-1`), shapes. */
  readonly legend: Readonly<Record<string, string>>;
};

/** Whether `value` is one of `options`. */
export const oneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (options as readonly string[]).includes(value);

/** A tint written 1 to 6, as its index 0 to 5; `undefined` for anything else. */
const tintOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 6
    ? value - 1
    : undefined;

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) === true ? value : undefined;

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inside = (rect: Rect, height: number): boolean =>
  rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= drawingWidth && rect.y + rect.h <= height;

/**
 * A link between two boxes: vertical-first between rows, a gentle S between boxes side by side.
 * Never right-angled.
 */
export function linkCurve(a: Rect, b: Rect, spread = 0): Cubic {
  const edge = edgeOf(a, b);
  if (edge === "top" || edge === "bottom") return route(a, b, spread);
  const right = edge === "right";
  const x1 = right ? a.x + a.w : a.x;
  const x2 = right ? b.x - 2 : b.x + b.w + 2;
  const y1 = a.y + a.h / 2 + spread;
  const y2 = b.y + b.h / 2;
  const half = (x2 - x1) / 2;
  return [x1, y1, x1 + half, y1, x2 - half, y2, x2, y2];
}

/** The rectangle a line of text takes, from its baseline. */
const textRect = (
  x: number,
  y: number,
  value: string,
  style: { readonly size: number; readonly char: number },
  anchor: AuthoredLabel["anchor"] = "start",
): Rect => {
  const w = value.length * style.char;
  const left = anchor === "start" ? x : anchor === "middle" ? x - w / 2 : x - w;
  return { x: left, y: y - style.size, w, h: style.size + 3 };
};

/** Builds an authored figure's model from its props and drawing, with every issue. */
export function readAuthoredFigure(input: unknown): {
  readonly model: AuthoredModel;
  readonly issues: readonly FigureIssue[];
  /** What the check could not verify, such as raw shapes. Not an issue. */
  readonly unchecked: readonly string[];
} {
  const raw = record(input) ?? {};
  const drawing = record(raw["drawing"]);
  const elements = list(drawing?.["elements"]).flatMap((value): AuthoredElement[] => {
    const element = record(value);
    const name = element?.["element"];
    return oneOf(kitElements, name) === true
      ? [{ element: name, props: record(element?.["props"]) ?? {} }]
      : [];
  });
  const of = (name: KitElementName): readonly Readonly<Record<string, unknown>>[] =>
    elements.filter((element) => element.element === name).map((element) => element.props);
  const height = number(drawing?.["height"]);
  const inputs: FigureIssue[] = [];
  const layout: FigureIssue[] = [];

  const authoredKind = text(raw["kind"]);
  const kind: FigureKind = oneOf(figureKinds, authoredKind) === true ? authoredKind : "system";
  if (authoredKind !== undefined && kind !== authoredKind)
    inputs.push(
      inputIssue(
        `kind "${authoredKind}" is unknown; drawn as system. Use architecture, system, schema or tree`,
      ),
    );

  const seen = new Set<string>();
  const boxes = of("box").flatMap((props, index): AuthoredBox[] => {
    const id = text(props["id"]);
    const label = text(props["label"]);
    if (id === undefined)
      inputs.push(inputIssue(`box ${index + 1} has no id; it takes part in no focus or case`));
    if (id !== undefined && seen.has(id) === true) {
      inputs.push(inputIssue(`duplicate id "${id}": box "${label ?? id}" is left out`));
      return [];
    }
    if (id !== undefined) seen.add(id);
    if (label === undefined) inputs.push(inputIssue(`box "${id ?? index + 1}" has no label`));
    const name = id ?? `box ${index + 1}`;
    const tint = tintOf(props["tint"]);
    if (props["tint"] !== undefined && tint === undefined)
      inputs.push(
        inputIssue(
          `box "${name}" has tint ${JSON.stringify(props["tint"])}; use 1 to 6. Drawn with no tint`,
        ),
      );
    const shapeValue = text(props["shape"]);
    const shape: BoxShape = oneOf(boxShapes, shapeValue) === true ? shapeValue : "plain";
    if (shapeValue !== undefined && shape !== shapeValue)
      inputs.push(inputIssue(`box "${name}" has unknown shape "${shapeValue}"; drawn as plain`));
    const detail = text(props["detail"]);
    const about = text(props["about"]);
    const w = number(props["w"]);
    const shown = label ?? id ?? "";
    const size = boxSize({
      label: shown,
      ...(detail === undefined ? {} : { detail }),
      shape,
      ...(w === undefined ? {} : { w }),
    });
    return [
      {
        id: id ?? `box-${index + 1}`,
        named: id !== undefined,
        label: shown,
        ...(detail === undefined ? {} : { detail }),
        ...(about === undefined ? {} : { about }),
        ...(tint === undefined ? {} : { tint }),
        shape,
        x: number(props["x"]) ?? 0,
        y: number(props["y"]) ?? 0,
        ...size,
      },
    ];
  });
  const boxById = new Map(boxes.filter((box) => box.named).map((box) => [box.id, box]));

  const legend = Object.fromEntries(
    Object.entries(record(raw["legend"]) ?? {}).flatMap(([key, value]) => {
      const name = text(value);
      return name === undefined ? [] : [[key, name]];
    }),
  );
  const ends = of("link").flatMap((props, index) => {
    const from = text(props["from"]);
    const to = text(props["to"]);
    if (from === undefined || to === undefined) {
      inputs.push(inputIssue(`link ${index + 1} needs from and to; it is left out`));
      return [];
    }
    const unknown = [from, to].find((id) => boxById.has(id) === false);
    if (unknown !== undefined) {
      inputs.push(inputIssue(`link ${from} -> ${to} names an unknown id "${unknown}"`));
      return [];
    }
    const styleValue = text(props["style"]);
    const style: LinkStyle = oneOf(linkStyles, styleValue) === true ? styleValue : "solid";
    if (styleValue !== undefined && style !== styleValue)
      inputs.push(
        inputIssue(`link ${from} -> ${to} has unknown style "${styleValue}"; drawn solid`),
      );
    const label = text(props["label"]);
    if (label === undefined && legend[style] === undefined)
      inputs.push(
        inputIssue(
          `link ${from} -> ${to} has no label, and its style "${style}" has no legend entry; give one of them`,
        ),
      );
    return [{ from, to, style, ...(label === undefined ? {} : { label }) }];
  });
  // Links that leave one box fan out along its edge, so no two coincide.
  const spreads = new Map(
    [...new Set(ends.map((end) => end.from))].flatMap((from) => {
      const hub = boxById.get(from);
      const own = ends.filter((end) => end.from === from);
      if (hub === undefined) return [];
      const values = fanSpreads(
        hub,
        own.map((end) => boxById.get(end.to) ?? hub),
      );
      return own.map((end, index) => [end, values[index] ?? 0] as const);
    }),
  );
  const links = ends.flatMap((end): AuthoredLink[] => {
    const a = boxById.get(end.from);
    const b = boxById.get(end.to);
    return a === undefined || b === undefined
      ? []
      : [{ ...end, curve: linkCurve(a, b, spreads.get(end) ?? 0) }];
  });

  const bands = of("band").map((props) => {
    const tint = tintOf(props["tint"]);
    return {
      x: number(props["x"]) ?? 0,
      y: number(props["y"]) ?? 0,
      w: number(props["w"]) ?? 0,
      h: number(props["h"]) ?? 0,
      label: text(props["label"]) ?? "",
      ...(tint === undefined ? {} : { tint }),
    };
  });
  const badges = of("badge").flatMap((props, index): AuthoredBadge[] => {
    const at = text(props["at"]) ?? "?";
    if (boxById.has(at) === false) {
      inputs.push(inputIssue(`badge ${index + 1} names an unknown box "${at}"`));
      return [];
    }
    return [{ at, n: number(props["n"]) ?? index + 1 }];
  });
  const notes = of("note").map((props): AuthoredNote => {
    const value = text(props["text"]) ?? "";
    const to = text(props["to"]);
    const target = to === undefined ? undefined : boxById.get(to);
    if (to !== undefined && target === undefined)
      inputs.push(inputIssue(`note "${value}" points at an unknown box "${to}"`));
    const toX = number(props["toX"]);
    const toY = number(props["toY"]);
    const point =
      target !== undefined
        ? { x: target.x + target.w / 2, y: target.y + target.h / 2 }
        : toX !== undefined && toY !== undefined
          ? { x: toX, y: toY }
          : undefined;
    return {
      x: number(props["x"]) ?? 0,
      y: number(props["y"]) ?? 0,
      text: value,
      ...(point === undefined ? {} : { to: point }),
    };
  });
  const labels = of("label").map((props): AuthoredLabel => {
    const anchor =
      props["anchor"] === "middle" || props["anchor"] === "end" ? props["anchor"] : "start";
    return {
      x: number(props["x"]) ?? 0,
      y: number(props["y"]) ?? 0,
      text: text(props["text"]) ?? "",
      size: props["size"] === "small" ? "small" : "large",
      anchor,
    };
  });

  const startWith = list(raw["startWith"]).flatMap((value) => {
    const id = text(value) ?? "?";
    if (boxById.has(id) === true) return [id];
    inputs.push(inputIssue(`startWith names an unknown id "${id}"`));
    return [];
  });
  const usedCaseIds = new Set<string>();
  const caseId = (authored: string | undefined, label: string, fallback: string): string => {
    const base = authored ?? (slug(label) === "" ? fallback : slug(label));
    const id = usedCaseIds.has(base) === true ? `${base}-${usedCaseIds.size + 1}` : base;
    usedCaseIds.add(id);
    return id;
  };
  const replays = list(raw["replays"]).flatMap((value, index): AuthoredCase[] => {
    const replay = record(value) ?? {};
    const label = text(replay["label"]);
    const name = label === undefined ? `replay ${index + 1}` : `replay "${label}"`;
    if (label === undefined) inputs.push(inputIssue(`${name} has no label`));
    const authored = list(replay["steps"]);
    if (authored.length > authoredBudget.steps)
      inputs.push(
        inputIssue(`${name} has ${authored.length} steps; the budget is ${authoredBudget.steps}`),
      );
    const steps = authored.flatMap((entry, step) => {
      const at = text(record(entry)?.["at"]) ?? "?";
      if (boxById.has(at) === false) {
        inputs.push(inputIssue(`${name} step ${step + 1} names an unknown id "${at}"`));
        return [];
      }
      return [{ at, note: text(record(entry)?.["note"]) ?? "" }];
    });
    if (authored.length === 0) inputs.push(inputIssue(`${name} has no steps`));
    const shown = label ?? `Replay ${index + 1}`;
    return steps.length === 0
      ? []
      : [
          {
            kind: "replay",
            id: caseId(text(replay["id"]), shown, `replay-${index + 1}`),
            label: shown,
            steps,
          },
        ];
  });
  const lenses = list(raw["lenses"]).map((value, index): AuthoredCase => {
    const lens = record(value) ?? {};
    const label = text(lens["label"]);
    const note = text(lens["note"]);
    const name = label === undefined ? `lens ${index + 1}` : `lens "${label}"`;
    if (label === undefined) inputs.push(inputIssue(`${name} has no label`));
    if (note === undefined) inputs.push(inputIssue(`${name} has no note`));
    const ids = (key: string): readonly string[] =>
      list(lens[key]).flatMap((entry) => {
        const id = text(entry) ?? "?";
        if (boxById.has(id) === true) return [id];
        inputs.push(inputIssue(`${name} names an unknown id "${id}"`));
        return [];
      });
    const shown = label ?? `Lens ${index + 1}`;
    return {
      kind: "lens",
      id: caseId(text(lens["id"]), shown, `lens-${index + 1}`),
      label: shown,
      note: note ?? "",
      focus: ids("focus"),
      blocked: ids("blocked"),
      broken: ids("broken"),
    };
  });

  if (boxes.length > authoredBudget.boxes)
    inputs.push(
      inputIssue(
        `${boxes.length} boxes; the budget is ${authoredBudget.boxes}. Split the figure or use a figure component`,
      ),
    );

  const drawn = height ?? 0;
  if (drawing === undefined || height === undefined)
    inputs.push(
      inputIssue("the figure has no <Drawing height={...}>; give the drawing and its height"),
    );
  else {
    boxes.forEach((box, index) =>
      boxes.slice(index + 1).forEach((other) => {
        if (overlaps(box, other) === true)
          layout.push(layoutIssue(`boxes "${box.id}" and "${other.id}" overlap`));
      }),
    );
    of("box").forEach((props) => {
      const box = boxes.find((item) => item.id === text(props["id"]));
      const w = number(props["w"]);
      if (box === undefined || w === undefined) return;
      const needs = Math.ceil(boxNeeds(box) / grid) * grid;
      if (needs > w)
        layout.push(
          layoutIssue(
            `the text of box "${box.id}" does not fit its box: it needs ${needs} px, the box is ${w} px`,
          ),
        );
    });
    boxes.forEach((box) => {
      if (inside(box, drawn) === false)
        layout.push(layoutIssue(`box "${box.id}" is outside the drawing`));
    });
    bands.forEach((band) => {
      if (inside(band, drawn) === false)
        layout.push(layoutIssue(`band "${band.label}" is outside the drawing`));
    });
    notes.forEach((note) => {
      if (inside(textRect(note.x, note.y, note.text, authoredText.small), drawn) === false)
        layout.push(layoutIssue(`note "${note.text}" is outside the drawing`));
    });
    labels.forEach((label) => {
      const style = label.size === "small" ? authoredText.small : authoredText.label;
      if (inside(textRect(label.x, label.y, label.text, style, label.anchor), drawn) === false)
        layout.push(layoutIssue(`label "${label.text}" is outside the drawing`));
    });
    links.forEach((link) => {
      const crossed = boxes.find((box) => {
        if (box.id === link.from || box.id === link.to) return false;
        // Sample the curve; a point well inside another box is a crossing.
        return Array.from({ length: 41 }, (_, step) => pointAt(link.curve, step / 40)).some(
          ([x, y]) =>
            x > box.x + 2 && x < box.x + box.w - 2 && y > box.y + 2 && y < box.y + box.h - 2,
        );
      });
      if (crossed !== undefined)
        layout.push(
          layoutIssue(
            `link ${link.from} -> ${link.to} crosses box "${crossed.id}", which is not one of its ends`,
          ),
        );
    });
    if (drawn > maximumHeight)
      layout.push(
        layoutIssue(
          `the drawing is ${drawn} px tall; the budget is ${maximumHeight.toLocaleString("en-US")} px`,
        ),
      );
  }

  const rawCount = of("raw").length;
  const rule = record(raw["rule"]);
  const ruleTitle = text(rule?.["title"]);
  const ruleText = text(rule?.["text"]);
  const summary = text(raw["summary"]);
  return {
    model: {
      id: text(raw["id"]) ?? "figure",
      kind,
      title: text(raw["title"]) ?? "",
      ...(summary === undefined ? {} : { summary }),
      ...(ruleTitle === undefined || ruleText === undefined
        ? {}
        : { rule: { title: ruleTitle, text: ruleText } }),
      height: drawn,
      bands,
      boxes,
      links,
      badges,
      notes,
      labels,
      raw: rawCount,
      startWith,
      cases: [...replays, ...lenses],
      legend,
    },
    issues: [...idIssues(raw["id"]), ...claimIssues(raw["title"]), ...inputs, ...layout],
    unchecked:
      rawCount === 0 ? [] : [`${rawCount} raw ${rawCount === 1 ? "shape" : "shapes"} not checked`],
  };
}

/** The label of a box id, or the id itself. */
export function authoredLabel(model: AuthoredModel, id: string): string {
  return model.boxes.find((box) => box.id === id)?.label ?? id;
}

/** The text equivalent: claim, summary, rule, bands with their boxes, links, notes, labels, cases. */
export function authoredReadable(model: AuthoredModel): string {
  const named = (box: AuthoredBox): string =>
    `${box.label}${box.detail === undefined ? "" : ` (${box.detail})`}`;
  const centre = (box: AuthoredBox): readonly [number, number] => [
    box.x + box.w / 2,
    box.y + box.h / 2,
  ];
  const within = (band: AuthoredBand, box: AuthoredBox): boolean => {
    const [x, y] = centre(box);
    return x >= band.x && x <= band.x + band.w && y >= band.y && y <= band.y + band.h;
  };
  const loose = model.boxes.filter((box) =>
    model.bands.every((band) => within(band, box) === false),
  );
  const label = (id: string): string => authoredLabel(model, id);
  return [
    model.title,
    ...(model.summary === undefined ? [] : [model.summary]),
    ...(model.rule === undefined ? [] : [`${model.rule.title}. ${model.rule.text}`]),
    ...model.bands.map(
      (band) =>
        `${band.label}: ${model.boxes
          .filter((box) => within(band, box))
          .map(named)
          .join(", ")}`,
    ),
    ...(loose.length === 0 ? [] : [`Boxes: ${loose.map(named).join(", ")}`]),
    ...model.links.map(
      (link) =>
        `${label(link.from)} -> ${label(link.to)}${
          (link.label ?? model.legend[link.style]) === undefined
            ? ""
            : `: ${link.label ?? model.legend[link.style]}`
        }`,
    ),
    ...model.notes.map((note) => `Note: ${note.text}`),
    ...model.labels.map((item) => item.text),
    ...model.cases.map((item) =>
      item.kind === "replay"
        ? `Replay ${item.label}: ${item.steps.map((step, index) => `${index + 1}. ${label(step.at)}: ${step.note}`).join(" ")}`
        : [
            `Lens ${item.label}: ${item.note}`,
            [
              ...(item.focus.length === 0 ? [] : [`Focus: ${item.focus.map(label).join(", ")}`]),
              ...(item.blocked.length === 0
                ? []
                : [`Blocked: ${item.blocked.map(label).join(", ")}`]),
              ...(item.broken.length === 0 ? [] : [`Broken: ${item.broken.map(label).join(", ")}`]),
            ].join(". "),
          ]
            .filter((part) => part !== "")
            .join(" "),
    ),
  ].join("\n");
}
