import type { LinkField } from "./link-field.ts";

/** How many links the demo machine holds, and how many the last command made. */
type LinkTally = { readonly total: number; readonly fresh: number };

/** Counts the links in the demo's field; nothing before the machine loads. */
export const tallyLinks = (field: LinkField | undefined): LinkTally => {
  const links = (field?.rows ?? []).flatMap((row) => row.links);
  return {
    total: links.length,
    fresh: links.filter((link) => link.fresh === true).length,
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
