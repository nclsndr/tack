import { docsIconAliases, docsIconCategories, otherLucideNames } from "./catalog.generated.ts";

export { docsIconCategories, lucideVersion } from "./catalog.generated.ts";

/** A name of the docs icon set: a Lucide icon name the reader bundles for docs. */
export type DocsIconName = (typeof docsIconCategories)[number]["names"][number];

/** Every name of the docs icon set. */
export const docsIconNames: ReadonlySet<string> = new Set(
  docsIconCategories.flatMap(({ names }) => names),
);

/** Whether `name` is in the docs icon set. */
export function isDocsIconName(name: string): name is DocsIconName {
  return docsIconNames.has(name);
}

const outsideTheSet: ReadonlySet<string> = new Set(otherLucideNames.split(" "));
const renamed: Readonly<Record<string, string>> = docsIconAliases;

/** The edit distance between two names (ASCII, as Lucide names are): insertions, deletions and substitutions. */
function distance(left: string, right: string): number {
  const initial = Array.from({ length: right.length + 1 }, (_, index) => index);
  return (
    left.split("").reduce((previous, leftCharacter, row) => {
      return right
        .split("")
        .reduce(
          (current, rightCharacter, column) => [
            ...current,
            Math.min(
              (current[column] ?? 0) + 1,
              (previous[column + 1] ?? 0) + 1,
              (previous[column] ?? 0) + (leftCharacter === rightCharacter ? 0 : 1),
            ),
          ],
          [row + 1],
        );
    }, initial)[right.length] ?? 0
  );
}

/**
 * Up to three names of the set closest to `name`: its lowercase form when that is in the set,
 * else the names sharing its first word, then those a few edits away.
 */
function closest(name: string): readonly string[] {
  const lower = name.toLowerCase();
  if (docsIconNames.has(lower)) return [lower];
  const firstWord = lower.split("-")[0] ?? lower;
  const sameWord = [...docsIconNames].filter((candidate) => candidate.split("-")[0] === firstWord);
  const near = [...docsIconNames]
    .map((candidate) => ({ candidate, edits: distance(lower, candidate) }))
    .filter(({ edits }) => edits <= Math.max(2, Math.floor(lower.length / 4)))
    .toSorted((left, right) => left.edits - right.edits)
    .map(({ candidate }) => candidate);
  return [...new Set([...sameWord, ...near])].slice(0, 3);
}

/** Why a name cannot be a docs icon, and the names of the set to use instead. */
export type IconNameFinding = { readonly message: string; readonly suggestions: readonly string[] };

/**
 * Why `name` cannot be a docs icon, or `undefined` when it can: the current name of an old Lucide
 * name, or the closest names of the set for a Lucide icon outside it and for anything else.
 */
export function iconNameFinding(name: string): IconNameFinding | undefined {
  if (docsIconNames.has(name)) return undefined;
  const current = renamed[name];
  if (current !== undefined)
    return {
      message: `unknown icon "${name}": Lucide renamed it "${current}"`,
      suggestions: [current],
    };
  const suggestions = closest(name);
  const hint =
    suggestions.length === 0
      ? "find one with `tack docs icons <word>`"
      : `closest: ${suggestions.join(", ")}`;
  return {
    message: outsideTheSet.has(name)
      ? `unknown icon "${name}": a Lucide icon outside the docs set; ${hint}`
      : `unknown icon "${name}"; ${hint}`,
    suggestions,
  };
}

/** Why `name` cannot be a docs icon, as one line, or `undefined` when it can. */
export function iconNameIssue(name: string): string | undefined {
  return iconNameFinding(name)?.message;
}

/** One icon a search found, with the old name that matched when it matched by an old name. */
export type DocsIconMatch = {
  readonly name: DocsIconName;
  readonly category: string;
  readonly alias?: string;
};

/**
 * The docs icons whose name contains `word`, whose category has it as a whole word, or whose old
 * Lucide name contains it, in catalog order.
 */
export function searchDocsIcons(word: string): readonly DocsIconMatch[] {
  const query = word.trim().toLowerCase();
  if (query === "") return [];
  const aliasesOf = (name: string) =>
    Object.entries(renamed).flatMap(([alias, current]) => (current === name ? [alias] : []));
  return docsIconCategories.flatMap(({ category, names }) => {
    const inCategory = category.toLowerCase().split(" ").includes(query);
    return names.flatMap((name): readonly DocsIconMatch[] => {
      if (inCategory || name.includes(query)) return [{ name, category }];
      const alias = aliasesOf(name).find((candidate) => candidate.includes(query));
      return alias === undefined ? [] : [{ name, category, alias }];
    });
  });
}
