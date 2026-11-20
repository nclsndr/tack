/**
 * The look choices of every figure, in one place: a figure is not a filled card, boxes have a 3 px
 * radius, and the drawing's ground depends on what the figure depicts. The ground per kind is a
 * default the reader picks, not a rule for authors.
 *
 * Change a value here and both the drawing geometry and the stylesheet follow: the frame writes
 * these values onto the figure as CSS custom properties and data attributes.
 */

/** What a figure depicts. Each kind picks its ground. */
export const figureKinds = [
  "architecture",
  "system",
  "schema",
  "tree",
  "steps",
  "quantities",
] as const;
export type FigureKind = (typeof figureKinds)[number];

/** The backgrounds a drawing can sit on. `figures.css` draws each one. */
const grounds = ["quad-ruled", "ruled-lines", "dot-grid", "none"] as const;
export type Ground = (typeof grounds)[number];

/** The shape of the look settings. Annotated, not inferred, so each value stays a setting. */
export type FigureLook = {
  readonly filledCard: boolean;
  readonly boxRadius: number;
  readonly boxStroke: number;
  readonly ruledPitch: number;
  readonly groundByKind: Readonly<Record<FigureKind, Ground>>;
};

export const figureLook: FigureLook = {
  /** `false`: the caption and summary are text on the page, and only the ground is filled. */
  filledCard: false,
  /** Corner radius of boxes and of the ground, in px. */
  boxRadius: 3,
  /** Border width of boxes at rest, in px. Focus and pin add to it. */
  boxStroke: 1,
  /** The line spacing of the ruled-lines ground, in px. A tree draws one entry per line. */
  ruledPitch: 24,
  /** The default ground of each figure kind. */
  groundByKind: {
    architecture: "quad-ruled",
    system: "quad-ruled",
    schema: "dot-grid",
    tree: "ruled-lines",
    steps: "none",
    quantities: "none",
  },
};

/** The CSS custom properties and attributes a figure of `kind` carries. */
export function lookAttributes(kind: FigureKind): {
  readonly "data-figure-kind": FigureKind;
  readonly "data-ground": Ground;
  readonly "data-card": "filled" | "none";
  readonly style: Readonly<Record<`--${string}`, string>>;
} {
  return {
    "data-figure-kind": kind,
    "data-ground": figureLook.groundByKind[kind],
    "data-card": figureLook.filledCard === true ? "filled" : "none",
    style: {
      "--figure-box-radius": `${figureLook.boxRadius}px`,
      "--figure-box-stroke": `${figureLook.boxStroke}px`,
      "--figure-ruled-pitch": `${figureLook.ruledPitch}px`,
    },
  };
}
