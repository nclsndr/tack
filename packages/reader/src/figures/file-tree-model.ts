/**
 * The model of a `FileTree`: an annotated tree written as text, one entry per line. Depth is the
 * indentation, `name -> target` is a symlink, `# text` is a note, `[key]`, `[temp]` and `[12 MB]`
 * are marks, and `...` stands for entries left out. Pure functions of the text, so the page and
 * the figure check read the same tree and print the same issues.
 */
import {
  claimIssues,
  type FigureIssue,
  idIssues,
  inputIssue,
  list,
  record,
  text,
} from "./issues.ts";
import { slug } from "./cases.ts";

type TreeSize = { readonly text: string; readonly bytes: number };

export type TreeEntry = {
  /** The path from the top-level entry, as written: `~/.local/share/tack/current`. */
  readonly id: string;
  /** 1-based line in the tree. */
  readonly line: number;
  readonly depth: number;
  /** The name as written, with its trailing slash: `share/tack/`. */
  readonly name: string;
  readonly directory: boolean;
  readonly target?: string;
  readonly note?: string;
  readonly key: boolean;
  readonly temp: boolean;
  readonly size?: TreeSize;
  /** `...`: entries left out. */
  readonly ellipsis: boolean;
  readonly parent?: string;
};

/** Where a symlink's arrow ends, and every entry its target resolves through. */
type TreeLink = { readonly arrow: string; readonly chain: readonly string[] };

export type TreeLens = {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly focus: readonly string[];
  readonly present: readonly string[];
};

export type TreeModel = {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly rule?: { readonly title: string; readonly text: string };
  readonly entries: readonly TreeEntry[];
  /** The resolved symlinks, by the id of the link. */
  readonly links: ReadonlyMap<string, TreeLink>;
  readonly startWith: readonly string[];
  readonly lenses: readonly TreeLens[];
};

export type FileTreeProps = {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly rule?: { readonly title: string; readonly text: string };
  readonly startWith?: readonly string[];
  readonly lenses?: readonly {
    readonly id?: string;
    readonly label: string;
    readonly note: string;
    readonly focus?: readonly string[];
    readonly present?: readonly string[];
  }[];
  /** The tree text. The reader fills it from the ```tree block. */
  readonly source?: string;
};

/** The limits a tree is checked against. */
export const fileTreeBudget = {
  entries: 60,
  /** A chain of links longer than this is a cycle. */
  chain: 8,
} as const;

const units = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 } as const;
const isUnit = (value: string): value is keyof typeof units => Object.hasOwn(units, value);
const sizePattern = /^(\d+(?:\.\d+)?)\s?(B|KB|MB|GB|TB)$/;

/** Bytes of a size mark such as `306 MB`, or `undefined`. Units are powers of 1024. */
export function parseSize(value: string): number | undefined {
  const match = sizePattern.exec(value.trim());
  if (match === null) return undefined;
  const unit = match[2] ?? "";
  return isUnit(unit) ? Number(match[1]) * 1024 ** units[unit] : undefined;
}

/** Without its trailing slash: how ids compare. */
const bare = (path: string): string =>
  path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;

type Line = {
  readonly line: number;
  readonly spaces: number;
  readonly tab: boolean;
  readonly body: string;
};

/** Splits a line into its name, link target, note and marks. Unknown brackets stay as text. */
function readBody(body: string): {
  readonly name: string;
  readonly target?: string;
  readonly note?: string;
  readonly key: boolean;
  readonly temp: boolean;
  readonly size?: TreeSize;
} {
  const marks: string[] = [];
  const stripped = body.replace(
    /(^|\s)\[([^\]\s][^\]]*)\](?=\s|$)/g,
    (whole, space: string, mark: string) => {
      if (mark === "key" || mark === "temp" || parseSize(mark) !== undefined) {
        marks.push(mark);
        return space;
      }
      return whole;
    },
  );
  const hash = stripped.search(/(^|\s)#\s/);
  const head = (hash === -1 ? stripped : stripped.slice(0, hash)).trim();
  const note = hash === -1 ? undefined : text(stripped.slice(hash).replace(/^\s*#/, ""));
  const arrow = head.indexOf(" -> ");
  const name = (arrow === -1 ? head : head.slice(0, arrow)).trim();
  const target = arrow === -1 ? undefined : text(head.slice(arrow + 4));
  const sizeMark = marks.find((mark) => parseSize(mark) !== undefined);
  const bytes = sizeMark === undefined ? undefined : parseSize(sizeMark);
  return {
    name,
    ...(target === undefined ? {} : { target }),
    ...(note === undefined ? {} : { note }),
    key: marks.includes("key"),
    temp: marks.includes("temp"),
    ...(sizeMark === undefined || bytes === undefined
      ? {}
      : { size: { text: sizeMark.replace(/^(\d+(?:\.\d+)?)\s?/, "$1 "), bytes } }),
  };
}

/** Reads the entries of a tree, with one issue per line that cannot be read as written. */
export function parseTree(source: string): {
  readonly model: Pick<TreeModel, "entries">;
  readonly issues: readonly FigureIssue[];
} {
  const lines = source.split(/\r?\n/).flatMap((raw, index): Line[] => {
    if (raw.trim() === "") return [];
    const indent = /^[ \t]*/.exec(raw)?.[0] ?? "";
    return [
      {
        line: index + 1,
        spaces: indent.replaceAll("\t", "  ").length,
        tab: indent.includes("\t"),
        body: raw.slice(indent.length),
      },
    ];
  });
  const state = lines.reduce<{
    entries: TreeEntry[];
    issues: FigureIssue[];
    /** The id of the entry open at each depth. */
    stack: string[];
    seen: Set<string>;
  }>(
    (acc, line) => {
      if (line.tab === true)
        acc.issues.push(
          inputIssue(`line ${line.line}: a tab in the indentation; use two spaces per level`),
        );
      else if (line.spaces % 2 !== 0)
        acc.issues.push(
          inputIssue(
            `line ${line.line}: odd indentation (${line.spaces} spaces); use two per level`,
          ),
        );
      const written = Math.floor(line.spaces / 2);
      const depth = Math.min(written, acc.stack.length);
      if (written > acc.stack.length)
        acc.issues.push(
          inputIssue(
            `line ${line.line}: indented more than one level below the line above; drawn one level below it`,
          ),
        );
      acc.stack = acc.stack.slice(0, depth);
      const parent = acc.stack.at(-1);
      const parsed = readBody(line.body);
      const ellipsis = parsed.name === "..." || parsed.name === "…";
      const prefix = parent === undefined ? "" : parent.endsWith("/") ? parent : `${parent}/`;
      const id = ellipsis ? `${prefix}...` : `${prefix}${parsed.name}`;
      if (ellipsis === false && acc.seen.has(bare(id)) === true) {
        acc.issues.push(
          inputIssue(`line ${line.line}: duplicate entry "${bare(id)}"; it is left out`),
        );
        return acc;
      }
      acc.seen.add(bare(id));
      // A parent written without a slash is a directory once it has a child.
      if (parent !== undefined) {
        const at = acc.entries.findIndex((item) => item.id === parent);
        const owner = acc.entries[at];
        if (owner !== undefined && owner.directory === false)
          acc.entries[at] = { ...owner, directory: true };
      }
      acc.entries.push({
        id,
        line: line.line,
        depth,
        name: parsed.name,
        directory: parsed.name.endsWith("/"),
        ...(parsed.target === undefined ? {} : { target: parsed.target }),
        ...(parsed.note === undefined ? {} : { note: parsed.note }),
        key: parsed.key,
        temp: parsed.temp,
        ...(parsed.size === undefined ? {} : { size: parsed.size }),
        ellipsis,
        ...(parent === undefined ? {} : { parent }),
      });
      if (ellipsis === false) acc.stack.push(id);
      return acc;
    },
    { entries: [], issues: [], stack: [], seen: new Set() },
  );
  return { model: { entries: state.entries }, issues: state.issues };
}

/** The segments of a path, with `.` and `..` applied. */
function segments(path: string): readonly string[] {
  return path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .reduce<string[]>((acc, part) => (part === ".." ? acc.slice(0, -1) : [...acc, part]), []);
}

/**
 * Resolves every symlink of the tree. An arrow ends on the first link the target path passes
 * through, as on disk, or on the entry the path names. A target that names no entry has no arrow.
 */
function resolveLinks(entries: readonly TreeEntry[]): ReadonlyMap<string, TreeLink> {
  const byPath = new Map(
    entries.flatMap((item) =>
      item.ellipsis ? [] : [[segments(item.id).join("/"), item] as const],
    ),
  );
  /** The first entry along `path`: a link passed through, or the entry the whole path names. */
  const step = (
    path: readonly string[],
  ): { entry: TreeEntry; rest: readonly string[] } | undefined =>
    path
      .map((_, index) => ({ entry: byPath.get(path.slice(0, index + 1).join("/")), at: index + 1 }))
      .flatMap(({ entry, at }) =>
        entry !== undefined && (at === path.length || entry.target !== undefined)
          ? [{ entry, rest: path.slice(at) }]
          : [],
      )[0];
  const absolute = (link: TreeEntry, target: string): readonly string[] => {
    // `~` and `/` start from the top of the tree; anything else from the link's own directory.
    if (target.startsWith("/")) return ["", ...segments(target)];
    if (target === "~" || target.startsWith("~/")) return segments(target);
    return segments(`${link.parent ?? ""}/${target}`);
  };
  const rooted = (path: readonly string[]): readonly string[] =>
    // The tree keys absolute paths without their leading slash.
    path[0] === "" ? path.slice(1) : path;
  return new Map(
    entries.flatMap((link) => {
      if (link.target === undefined) return [];
      const first = step(rooted(absolute(link, link.target)));
      if (first === undefined) return [];
      const follow = (
        current: { entry: TreeEntry; rest: readonly string[] },
        chain: readonly string[],
      ): readonly string[] => {
        const next = [...chain, current.entry.id];
        if (current.entry.target === undefined || next.length >= fileTreeBudget.chain) return next;
        const onward = step(
          rooted([...absolute(current.entry, current.entry.target), ...current.rest]),
        );
        if (onward === undefined || next.includes(onward.entry.id) === true) return next;
        return follow(onward, next);
      };
      const tail = first.rest.length === 0 ? [] : first.rest;
      return [
        [
          link.id,
          { arrow: first.entry.id, chain: follow({ entry: first.entry, rest: tail }, []) },
        ] as const,
      ];
    }),
  );
}

/** Builds a tree's model from the props and the tree text, with every input issue. */
export function readFileTree(props: unknown): {
  readonly model: TreeModel;
  readonly issues: readonly FigureIssue[];
} {
  const raw = record(props) ?? {};
  const source = typeof raw["source"] === "string" ? raw["source"] : "";
  const { model: parsed, issues: grammar } = parseTree(source);
  const entries = parsed.entries;
  const byBare = new Map(
    entries.flatMap((item) => (item.ellipsis ? [] : [[bare(item.id), item] as const])),
  );
  const issues: FigureIssue[] = [];
  const known = (value: unknown, where: string): readonly string[] => {
    const id = text(value) ?? "?";
    const found = byBare.get(bare(id));
    if (found !== undefined) return [found.id];
    issues.push(inputIssue(`${where} names an unknown entry "${id}"`));
    return [];
  };
  const startWith = list(raw["startWith"]).flatMap((value) => known(value, "startWith"));
  const usedIds = new Set<string>();
  const lenses = list(raw["lenses"]).flatMap((value, index): TreeLens[] => {
    const lens = record(value) ?? {};
    const label = text(lens["label"]);
    const note = text(lens["note"]);
    const name = label === undefined ? `lens ${index + 1}` : `lens "${label}"`;
    const present = list(lens["present"]).flatMap((id) => known(id, name));
    present.forEach((id) => {
      if (byBare.get(bare(id))?.temp !== true)
        issues.push(
          inputIssue(`${name} lists "${bare(id)}" as present, but it is not marked [temp]`),
        );
    });
    const focus = list(lens["focus"]).flatMap((id) => known(id, name));
    if (label === undefined) issues.push(inputIssue(`${name} has no label`));
    if (note === undefined) issues.push(inputIssue(`${name} has no note`));
    const shown = label ?? `Lens ${index + 1}`;
    const base = text(lens["id"]) ?? (slug(shown) === "" ? `lens-${index + 1}` : slug(shown));
    const id = usedIds.has(base) === true ? `${base}-${index + 1}` : base;
    usedIds.add(id);
    return [{ id, label: shown, note: note ?? "", focus, present }];
  });
  const rule = record(raw["rule"]);
  const ruleTitle = text(rule?.["title"]);
  const ruleText = text(rule?.["text"]);
  const summary = text(raw["summary"]);
  return {
    model: {
      id: text(raw["id"]) ?? "file-tree",
      title: text(raw["title"]) ?? "",
      ...(summary === undefined ? {} : { summary }),
      ...(ruleTitle === undefined || ruleText === undefined
        ? {}
        : { rule: { title: ruleTitle, text: ruleText } }),
      entries,
      links: resolveLinks(entries),
      startWith,
      lenses,
    },
    issues: [
      ...idIssues(raw["id"]),
      ...claimIssues(raw["title"]),
      ...(entries.length === 0
        ? [inputIssue("the tree is empty; write one entry per line in a ```tree block")]
        : []),
      ...grammar,
      ...(entries.length > fileTreeBudget.entries
        ? [
            inputIssue(
              `${entries.length} entries; the budget is ${fileTreeBudget.entries}. Fold entries the claim does not need into ...`,
            ),
          ]
        : []),
      ...issues,
    ],
  };
}

/** One entry as a line of text: indentation, name, target, marks and note. */
function entryText(entry: TreeEntry): string {
  const marks = [
    ...(entry.key ? ["[key]"] : []),
    ...(entry.temp ? ["[temp]"] : []),
    ...(entry.size === undefined ? [] : [`[${entry.size.text}]`]),
  ];
  return [
    `${"  ".repeat(entry.depth)}${entry.name}${entry.target === undefined ? "" : ` -> ${entry.target}`}`,
    ...(marks.length === 0 ? [] : [marks.join(" ")]),
    ...(entry.note === undefined ? [] : [`# ${entry.note}`]),
  ].join("  ");
}

/** The text equivalent: claim, summary, rule, the tree as indented text, then each lens. */
export function fileTreeReadable(model: TreeModel): string {
  return [
    model.title,
    ...(model.summary === undefined ? [] : [model.summary]),
    ...(model.rule === undefined ? [] : [`${model.rule.title}. ${model.rule.text}`]),
    ...model.entries.map(entryText),
    ...model.lenses.map(
      (lens) =>
        `Lens ${lens.label}: ${lens.note}${lens.present.length === 0 ? "" : ` Present: ${lens.present.join(", ")}`}${lens.focus.length === 0 ? "" : ` Focus: ${lens.focus.join(", ")}`}`,
    ),
  ].join("\n");
}
