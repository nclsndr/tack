import { homeRelative, type LinkEdge } from "./machine-view.ts";

/** Who a link serves: one of the three agents, or a project's docs. */
type FieldAgent = "claude" | "codex" | "cursor" | "docs";

/** The agents in the order a place lists its links. */
const agentOrder: ReadonlyArray<FieldAgent> = ["claude", "codex", "cursor", "docs"];

/** The agent folder a link sits in, as each agent names it. */
const agentFolders: ReadonlyArray<readonly [string, FieldAgent]> = [
  ["/.claude/", "claude"],
  ["/.agents/", "codex"],
  ["/.codex/", "codex"],
  ["/.cursor/", "cursor"],
];

/** The agent that reads the link at `path`; a link in no agent's folder is a docs mount. */
export const agentOf = (path: string): FieldAgent =>
  agentFolders.find(([folder]) => path.includes(folder))?.[1] ?? "docs";

/**
 * Where a link sits, without the agent: the folder before the first hidden one, and the entry's
 * name. The same skill linked for three agents in one project is one place.
 */
export const placeOf = (path: string, home: string) =>
  `${scopeOf(path, home)} ${homeRelative(path, home).split("/").at(-1)}`;

/**
 * The folder a link serves, the home or a project: the folder before the first hidden one, or the
 * link's own folder when it sits in none.
 */
export const scopeOf = (path: string, home: string) => {
  const segments = homeRelative(path, home).split("/");
  const hidden = segments.findIndex((segment, index) => index > 0 && segment.startsWith("."));
  return segments.slice(0, hidden === -1 ? -1 : hidden).join("/");
};

/** A real file in a source that links reach, by its path. */
type FieldSource = { readonly key: string };

/** One agent's link at a place, by its path; `fresh` when the last command made it. */
type FieldLink = { readonly key: string; readonly fresh: boolean };

/** A place links sit, with one link per agent that reads it, in the agents' order. */
type FieldRow = {
  readonly key: string;
  /** The home or project the place is in, as `scopeOf` names it. */
  readonly scope: string;
  /** The index in `sources` of the real file its links reach. */
  readonly source: number;
  readonly links: ReadonlyArray<FieldLink>;
};

/** The machine's links as the hero draws them. */
export type LinkField = {
  readonly sources: ReadonlyArray<FieldSource>;
  readonly rows: ReadonlyArray<FieldRow>;
};

/** The keys in `previous` that are still there, in place, then the new ones in the order given. */
const keepOrder = (previous: ReadonlyArray<string>, current: ReadonlyArray<string>) => {
  const present = new Set(current);
  const kept = previous.filter((key) => present.has(key));
  const known = new Set(kept);
  return [...kept, ...new Set(current.filter((key) => known.has(key) === false))];
};

/**
 * The field after a command: each real file the links reach, and a row for each place they sit,
 * with one link per agent that reads it. Files and rows keep their order from the previous field
 * and new ones join at the end, so a command never moves what was already drawn. `fresh` names the
 * links the last command made.
 */
export const nextLinkField = (
  previous: LinkField | undefined,
  edges: ReadonlyArray<LinkEdge>,
  fresh: ReadonlySet<string>,
  home: string,
): LinkField => {
  const sourceKeys = keepOrder(
    previous?.sources.map((source) => source.key) ?? [],
    edges.map((edge) => edge.to),
  );
  const rowKeys = keepOrder(
    previous?.rows.map((row) => row.key) ?? [],
    edges.map((edge) => placeOf(edge.from, home)),
  );
  const rows = rowKeys.map((key) => {
    const linked = edges.filter((edge) => placeOf(edge.from, home) === key);
    return {
      key,
      // Every link at one place is in the same scope, so any of them names it.
      scope: linked.reduce((_, edge) => scopeOf(edge.from, home), ""),
      source: Math.min(...linked.map((edge) => sourceKeys.indexOf(edge.to))),
      links: linked
        .map((edge) => ({ key: edge.from, fresh: fresh.has(edge.from) }))
        .sort((a, b) => agentOrder.indexOf(agentOf(a.key)) - agentOrder.indexOf(agentOf(b.key))),
    };
  });
  return { sources: sourceKeys.map((key) => ({ key })), rows };
};
