import type { LinkField } from "./link-field.ts";

/** A real file as a flat arc over the origin. */
export type ArcFile = {
  readonly key: string;
  /** Its half width, in pixels. */
  readonly radius: number;
  /** Its height over its half width. */
  readonly flat: number;
  /** Whether the last command made some of its links. */
  readonly fresh: boolean;
  /** Whether some of its links were there before the last command. */
  readonly kept: boolean;
};

/** A link as a mark on its real file's arc. */
export type ArcMark = {
  readonly key: string;
  readonly fresh: boolean;
  /** The index of its file's arc. */
  readonly file: number;
  /** Pixels from the page's left edge, and above the origin (negative). */
  readonly x: number;
  readonly y: number;
  /** When it lands among the command's new marks, from 0, or -1 when it is not new. */
  readonly order: number;
};

/** How flat the arcs are: an arc's height over its half width. */
const flat = 0.42;

/** How many links a scope's sector makes room for before its marks crowd. */
const sectorRoom = 10;

/**
 * The links as marks on arcs fanned over one origin at the page's middle: each real file is an
 * arc, wider for each file, and each link a mark on its file's arc. The home, then each project,
 * owns a sector of the fan, left to right, and a link's place in its sector is the order it was
 * made in, so a mark never moves once drawn. A command's new marks land inner arc first, then left
 * to right.
 */
export const layoutArcs = (
  field: LinkField,
  width: number,
): { readonly arcs: ReadonlyArray<ArcFile>; readonly marks: ReadonlyArray<ArcMark> } => {
  const scopes = [...new Set(field.rows.map((row) => row.scope))];
  const links = field.rows.flatMap((row) =>
    row.links.map((link) => ({
      key: link.key,
      fresh: link.fresh,
      scope: scopes.indexOf(row.scope),
      file: row.source,
    })),
  );
  const sector = Math.PI / Math.max(3, scopes.length);
  const radiusOf = (file: number) => width * (0.16 + 0.07 * file);

  const placed = links.map((link, index) => {
    const slot = links.slice(0, index).filter((before) => before.scope === link.scope).length;
    const angle = Math.PI - sector * (link.scope + (slot + 0.5) / sectorRoom);
    const radius = radiusOf(link.file);
    return {
      key: link.key,
      fresh: link.fresh,
      file: link.file,
      x: width / 2 + radius * Math.cos(angle),
      y: -radius * flat * Math.sin(angle),
    };
  });
  const rank = (mark: (typeof placed)[number]) => mark.file * 1e6 + Math.round(mark.x);
  const ranked = placed
    .filter((mark) => mark.fresh)
    .map(rank)
    .sort((a, b) => a - b);
  const marks = placed.map((mark) => ({
    ...mark,
    order: mark.fresh ? ranked.indexOf(rank(mark)) : -1,
  }));

  const arcs = field.sources.map((source, index) => {
    const own = links.filter((link) => link.file === index);
    return {
      key: source.key,
      radius: radiusOf(index),
      flat,
      fresh: own.some((link) => link.fresh),
      kept: own.some((link) => link.fresh === false),
    };
  });
  return { arcs, marks };
};
