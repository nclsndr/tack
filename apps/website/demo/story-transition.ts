import type { LinkField } from "./link-field.ts";

/**
 * The ways the landing carries the hero's demo window into the story plate below it: links that
 * run down from the window onto the saddle like reins, a drafting rule that draws the plate in as
 * it scrolls up, or a racetrack laid across the seam that a runner laps one leg per command.
 */
const transitions = ["reins", "plotter", "track"] as const;

/** One way to carry the demo into the story plate. */
export type Transition = (typeof transitions)[number];

/** The direction the landing shows when the address names none. */
export const defaultTransition: Transition = "reins";

/** The letter each direction answers to in `?transition=`, in the order they are listed. */
const letters: ReadonlyArray<readonly [string, Transition]> = transitions.map((name, index) => [
  String.fromCharCode(97 + index),
  name,
]);

/**
 * The direction `?transition=` names in `search`, by letter (`a`, `b`, `c`) or by name, or the
 * default when it names none or one that does not exist.
 */
export const transitionFrom = (search: string): Transition => {
  const value = new URLSearchParams(search).get("transition")?.toLowerCase();
  if (value === undefined) return defaultTransition;
  return (
    letters.find(([letter, name]) => letter === value || name === value)?.[1] ?? defaultTransition
  );
};

/** How many links the demo machine holds, how many the last command made, and the places served. */
type LinkTally = { readonly total: number; readonly fresh: number; readonly scopes: number };

/** Counts the links in the demo's field; nothing before the machine loads. */
export const tallyLinks = (field: LinkField | undefined): LinkTally => {
  const rows = field?.rows ?? [];
  const links = rows.flatMap((row) => row.links);
  return {
    total: links.length,
    fresh: links.filter((link) => link.fresh === true).length,
    scopes: new Set(rows.map((row) => row.scope)).size,
  };
};

/** The most reins drawn at once: past it, more links would only crowd the saddle. */
export const reinCap = 9;

/** The dashed guides drawn before the demo has made a link: the plan, before anything is written. */
export const plannedReins = 5;

/**
 * Where the reins leave the window, in pixels, for a content column `width` wide starting at
 * `left`: across its right part, clear of the story's heading on the left.
 */
export const reinSpan = (left: number, width: number) => ({
  from: left + width * 0.62,
  to: left + width * 0.96,
});

/** One rein: where it leaves the window, and whether it is a planned guide, a link or a new link. */
type Rein = { readonly x: number; readonly state: "planned" | "made" | "fresh" };

/**
 * The reins for `total` links, `fresh` of them new, spread evenly across `span`: one per link up
 * to `reinCap`, the newest last, or the planned guides while there is no link yet.
 */
export const layoutReins = (
  total: number,
  fresh: number,
  span: { readonly from: number; readonly to: number },
): ReadonlyArray<Rein> => {
  const count = total === 0 ? plannedReins : Math.min(total, reinCap);
  const newest = count - Math.min(fresh, count);
  return Array.from({ length: count }, (_, index) => ({
    x: span.from + ((span.to - span.from) * (index + 0.5)) / count,
    state: total === 0 ? "planned" : index >= newest ? "fresh" : "made",
  }));
};

/**
 * A rein's path: straight down from `x` at the top of its box to `bend`, then a curve that lands
 * on `target`, so a rein that starts in the box above it meets it as one line.
 */
export const reinPath = (
  x: number,
  target: { readonly x: number; readonly y: number },
  bend: number,
) => {
  const handle = bend + (target.y - bend) / 2;
  return `M ${x} 0 L ${x} ${bend} C ${x} ${handle}, ${target.x} ${handle}, ${target.x} ${target.y}`;
};

/** How a tick of the plotter's rule reads: one per link, the new ones in brass. */
type Tick = "idle" | "lit" | "fresh";

/** The `count` ticks of the plotter's rule: one lit per link, the fresh ones last. */
export const rulerTicks = (total: number, fresh: number, count: number): ReadonlyArray<Tick> => {
  const lit = Math.min(total, count);
  const newest = lit - Math.min(fresh, lit);
  return Array.from({ length: count }, (_, index) =>
    index >= lit ? "idle" : index >= newest ? "fresh" : "lit",
  );
};

/** The track's lanes: one per place the links serve, the home and each project, up to three. */
export const laneCount = (scopes: number) => Math.min(3, Math.max(1, scopes));

/**
 * A point on the track at `fraction` of a lap, in percentages of the track's box: the lap starts
 * at the bottom and runs clockwise. `inset` shrinks the lane by that share of the outer one.
 */
export const trackPoint = (fraction: number, inset = 0) => {
  const angle = Math.PI / 2 + fraction * 2 * Math.PI;
  const radius = 50 * (1 - inset);
  return { left: 50 + radius * Math.cos(angle), top: 50 + radius * Math.sin(angle) };
};
