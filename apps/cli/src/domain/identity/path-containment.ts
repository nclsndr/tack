import { posixPath as path } from "./portable.ts";

/**
 * Lexical relative path from `parent` to `child`, or `undefined` when `child` lies outside
 * `parent`. A segment named `..x` stays inside; only a leading `..` segment leaves.
 */
const relativeWithin = (parent: string, child: string): string | undefined => {
  const relative = path.relative(parent, child);
  return path.isAbsolute(relative) === true ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) === true
    ? undefined
    : relative;
};

/** Whether `child` is `parent` itself or lies below it, compared lexically. */
export const isInside = (parent: string, child: string): boolean =>
  relativeWithin(parent, child) !== undefined;

/** Whether `child` lies below `parent`, excluding `parent` itself, compared lexically. */
export const isStrictlyInside = (parent: string, child: string): boolean => {
  const relative = relativeWithin(parent, child);
  return relative !== undefined && relative.length > 0;
};
