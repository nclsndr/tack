/** The name of the declaration file at the root of every Tack source. */
export const declarationFileName = "tack.yaml";

/**
 * Whether a folder that holds the entries `names` is the root of a source: it holds `tack.yaml`
 * and no `SKILL.md`. A `tack.yaml` inside a skill folder is the skill's content. Walks below a
 * source's root never enter such a folder, because it belongs to another source.
 */
export const marksSourceEdge = (names: ReadonlyArray<string>): boolean =>
  names.includes(declarationFileName) === true && names.includes("SKILL.md") === false;

/**
 * Whether a docs walk passes over a folder entry by its name: dot and underscore names, which hold
 * tool state, drafts and partials, and `node_modules`.
 */
export const docsWalkSkips = (name: string): boolean =>
  name.startsWith(".") === true || name.startsWith("_") === true || name === "node_modules";
