import type { ChoiceNamespace } from "../../../../domain/choices/choice-schema.ts";
import type { ResourceAddress } from "../../../../domain/sources/catalog-schema.ts";
import type { ExplorerActivity } from "./activity.ts";
import type { DestinationMenu, DestinationOption, OpenableDestination } from "./destination.ts";
import { stepDestination } from "./destination.ts";
import { stageFolder, undoFolder } from "./folder.ts";
import {
  initialEditState,
  stageChange,
  stageKeys,
  undoChange,
  undoKeys,
  type EditState,
  type Editable,
  type ExplorerReview,
  type PendingChange,
} from "./edit.ts";

export type ExplorerEntry = {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly description: string;
  readonly tags: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [string, string]>;
  readonly preview?: {
    readonly kind: "file" | "docs";
    readonly path: string;
    readonly sourcePath?: string;
    readonly sourceRegistrationId?: string;
    readonly name?: string;
    readonly readerConfig?: { readonly kind: "source"; readonly path: string };
  };
  readonly address?: ResourceAddress;
  /** Present in edit mode for locked built-ins, choices, and docs attachments. */
  readonly editable?: Editable;
  /** Whether the edited destination delivers the resource, and why; absent without one. */
  readonly activity?: ExplorerActivity;
  readonly issue: boolean;
  /**
   * Where the entry sits under its source: the folders above its own directory, optionally led by
   * the source label when the section spans several sources. Absent entries are listed flat.
   */
  readonly tree?: { readonly source?: string; readonly folders: ReadonlyArray<string> };
};

type ExplorerPreview = {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  readonly offset: number;
};

export type ExplorerState = {
  readonly heading: string;
  readonly entries: ReadonlyArray<ExplorerEntry>;
  readonly query: string;
  readonly filtering: boolean;
  /** Index into {@link visibleRows}. */
  readonly cursor: number;
  readonly preview: ExplorerPreview | undefined;
  /** Keys of the folders the operator collapsed. Folders start expanded. */
  readonly collapsed: ReadonlySet<string>;
  /** Present only when the session was opened for one namespace; absent means read-only. */
  readonly edit?: EditState;
  readonly destinations?: ReadonlyArray<DestinationOption>;
  readonly destinationMenu?: DestinationMenu;
};

export type ExplorerRow =
  | {
      readonly kind: "folder";
      readonly section: string;
      readonly key: string;
      readonly path: ReadonlyArray<string>;
      readonly label: string;
      readonly depth: number;
      readonly expanded: boolean;
      readonly count: number;
      /** All descendants, including folded and filtered-out resources. */
      readonly entries: ReadonlyArray<ExplorerEntry>;
    }
  | {
      readonly kind: "entry";
      readonly section: string;
      readonly entry: ExplorerEntry;
      readonly depth: number;
    };

export type ExplorerKey = {
  readonly name: string;
  readonly input?: string | undefined;
  readonly ctrl: boolean;
};
export type ExplorerStep =
  | {
      readonly _tag: "destination";
      readonly state: ExplorerState;
      readonly destination: OpenableDestination;
    }
  | { readonly _tag: "next"; readonly state: ExplorerState }
  | { readonly _tag: "open"; readonly state: ExplorerState; readonly entry: ExplorerEntry }
  /** The operator asked to see what the staged changes would do. */
  | { readonly _tag: "review"; readonly state: ExplorerState }
  /** The operator confirmed the review; the session applies the staged changes. */
  | { readonly _tag: "apply"; readonly state: ExplorerState }
  | { readonly _tag: "quit" }
  | { readonly _tag: "interrupt" };

/** Creates a session with the first catalog entry selected; `fixedBy` makes the selection read-only. */
export const initialExplorerState = (
  heading: string,
  entries: ReadonlyArray<ExplorerEntry>,
  namespace?: ChoiceNamespace,
  fixedBy?: string,
): ExplorerState => ({
  heading,
  entries,
  query: "",
  filtering: false,
  cursor: 0,
  preview: undefined,
  collapsed: new Set(),
  ...(namespace === undefined ? {} : { edit: initialEditState(namespace, fixedBy) }),
});

/** The staged changes in a stable order, ready to preview or apply. */
export const pendingChanges = (state: ExplorerState): ReadonlyArray<PendingChange> => [
  ...(state.edit?.pending.values() ?? []),
];

/** Filters in catalog order, requiring every typed word to match some visible fact. */
export const visibleEntries = (state: ExplorerState): ReadonlyArray<ExplorerEntry> => {
  const words = state.query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  return words.length === 0
    ? state.entries
    : state.entries.filter((entry) => {
        const text = [entry.section, entry.title, entry.description, ...entry.tags]
          .join(" ")
          .toLocaleLowerCase();
        return words.every((word) => text.includes(word));
      });
};

type TreeNode = {
  readonly segment: string;
  readonly key: string;
  readonly isSource: boolean;
  readonly children: Array<TreeNode>;
  readonly entries: Array<ExplorerEntry>;
};

const folderNode = (segment: string, key: string, isSource: boolean): TreeNode => ({
  segment,
  key,
  isSource,
  children: [],
  entries: [],
});

/** Builds one section's folder tree from every entry, so its shape does not depend on the filter. */
const sectionTree = (section: string, entries: ReadonlyArray<ExplorerEntry>): TreeNode => {
  const root = folderNode("", section, false);
  for (const entry of entries) {
    const segments =
      entry.tree === undefined
        ? []
        : [...(entry.tree.source === undefined ? [] : [entry.tree.source]), ...entry.tree.folders];
    let node = root;
    segments.forEach((segment, index) => {
      const key = `${section}\u0000${segments.slice(0, index + 1).join("\u0000")}`;
      let child = node.children.find((candidate) => candidate.key === key);
      if (child === undefined) {
        child = folderNode(segment, key, index === 0 && entry.tree?.source !== undefined);
        node.children.push(child);
      }
      node = child;
    });
    node.entries.push(entry);
  }
  return root;
};

const countVisible = (node: TreeNode, visible: ReadonlySet<ExplorerEntry>): number =>
  node.entries.filter((entry) => visible.has(entry)).length +
  node.children.reduce((total, child) => total + countVisible(child, visible), 0);

const descendants = (node: TreeNode): ReadonlyArray<ExplorerEntry> => [
  ...node.entries,
  ...node.children.flatMap((child) => descendants(child)),
];

/**
 * Lists the rows the explorer shows: sections in catalog order, each a folder tree that follows the
 * source layout. Folders that only lead to one more folder merge into a single `a/b` row, except a
 * source row. Folders come before the entries beside them. A filter keeps matching entries with
 * their folders, all expanded.
 */
export const visibleRows = (state: ExplorerState): ReadonlyArray<ExplorerRow> => {
  const visible = new Set(visibleEntries(state));
  const filtering = state.query.trim().length > 0;
  const sections = new Map<string, Array<ExplorerEntry>>();
  for (const entry of state.entries) {
    const bucket = sections.get(entry.section);
    if (bucket === undefined) sections.set(entry.section, [entry]);
    else bucket.push(entry);
  }
  const rows: Array<ExplorerRow> = [];
  const walk = (node: TreeNode, section: string, depth: number, parent: ReadonlyArray<string>) => {
    for (const child of node.children) {
      const path = [...parent, child.segment];
      let target = child;
      let only = target.children[0];
      while (
        only !== undefined &&
        !target.isSource &&
        target.entries.length === 0 &&
        target.children.length === 1
      ) {
        target = only;
        path.push(target.segment);
        only = target.children[0];
      }
      const count = countVisible(target, visible);
      if (count === 0) continue;
      const expanded = filtering || !state.collapsed.has(target.key);
      rows.push({
        kind: "folder",
        section,
        key: target.key,
        path,
        label: path.slice(parent.length).join("/"),
        depth,
        expanded,
        count,
        entries: descendants(target),
      });
      if (expanded) walk(target, section, depth + 1, path);
    }
    for (const entry of node.entries)
      if (visible.has(entry)) rows.push({ kind: "entry", section, entry, depth });
  };
  for (const [section, entries] of sections) walk(sectionTree(section, entries), section, 0, []);
  return rows;
};

/** The selected visible row: a folder or a resource or issue. */
export const selectedRow = (state: ExplorerState): ExplorerRow | undefined =>
  visibleRows(state)[state.cursor];

const next = (state: ExplorerState): ExplorerStep => ({ _tag: "next", state });
const at = (state: ExplorerState, cursor: number): ExplorerStep =>
  next({ ...state, cursor: Math.max(0, Math.min(cursor, visibleRows(state).length - 1)) });
/** Puts the cursor on the first resource or issue, so a filter lands on a match, not a folder. */
const atFirstEntry = (state: ExplorerState): ExplorerStep => {
  const first = visibleRows(state).findIndex((row) => row.kind === "entry");
  return at(state, Math.max(0, first));
};
const withCollapsed = (state: ExplorerState, key: string, collapsed: boolean): ExplorerStep => {
  const keys = new Set(state.collapsed);
  if (collapsed) keys.add(key);
  else keys.delete(key);
  return next({ ...state, collapsed: keys });
};
const pageSize = 10;

/** Shown when the operator tries to leave with staged changes; asking again discards them. */
const discardNotice = "Staged changes will be discarded. Press q again to quit, c to review.";

/** Applies one decoded key to the latest state. Input bursts are split by the session. */
export const stepExplorer = (state: ExplorerState, key: ExplorerKey): ExplorerStep => {
  const step = stepKey(state, key);
  // A notice answers the key that raised it; the next key clears it unless it raised it again.
  const notice = state.edit?.notice;
  if (notice !== undefined && step._tag !== "quit" && step._tag !== "interrupt") {
    const edit = step.state.edit;
    if (edit?.notice === notice && edit === state.edit)
      return { ...step, state: { ...step.state, edit: { ...edit, notice: undefined } } };
  }
  return step;
};

const stepKey = (state: ExplorerState, key: ExplorerKey): ExplorerStep => {
  if (key.ctrl && key.name === "c") return { _tag: "interrupt" };
  if (key.ctrl && key.name === "d") return { _tag: "quit" };
  const destination = stepDestination(state, key);
  if (destination !== undefined) return destination;
  const edit = state.edit;
  if (edit?.review !== undefined) {
    const review = edit.review;
    const close = { ...state, edit: { ...edit, review: undefined, notice: undefined } };
    if (review.phase === "preview") {
      if (key.name === "return" || key.input === "y") return { _tag: "apply", state };
      if (["escape", "left"].includes(key.name) || key.input === "n" || key.input === "q")
        return next(close);
    } else if (["escape", "left", "return"].includes(key.name) || key.input === "q")
      return next(close);
    const delta =
      key.name === "up" || key.input === "k"
        ? -1
        : key.name === "down" || key.input === "j"
          ? 1
          : key.name === "pageup"
            ? -pageSize
            : key.name === "pagedown" || key.name === "space" || key.input === " "
              ? pageSize
              : 0;
    return next({
      ...state,
      edit: {
        ...edit,
        review: {
          ...review,
          offset: Math.max(0, Math.min(review.offset + delta, review.lines.length - 1)),
        },
      },
    });
  }
  if (state.preview !== undefined) {
    if (["escape", "left", "return"].includes(key.name) || key.input === "q")
      return next({ ...state, preview: undefined });
    const delta =
      key.name === "up" || key.input === "k"
        ? -1
        : key.name === "down" || key.input === "j"
          ? 1
          : key.name === "pageup"
            ? -pageSize
            : key.name === "pagedown" || key.name === "space" || key.input === " "
              ? pageSize
              : 0;
    return next({
      ...state,
      preview: {
        ...state.preview,
        offset: Math.max(0, Math.min(state.preview.offset + delta, state.preview.lines.length - 1)),
      },
    });
  }
  if (state.filtering) {
    if (key.name === "escape") return next({ ...state, filtering: false, query: "", cursor: 0 });
    if (["return", "up", "down"].includes(key.name)) return next({ ...state, filtering: false });
    if (key.name === "backspace")
      return at({ ...state, query: state.query.slice(0, -1) }, state.cursor);
    if (!key.ctrl && key.input !== undefined && key.input >= " ")
      return atFirstEntry({ ...state, query: state.query + key.input });
    return next(state);
  }
  if (key.name === "up" || key.input === "k") return at(state, state.cursor - 1);
  if (key.name === "down" || key.input === "j") return at(state, state.cursor + 1);
  if (key.name === "pageup") return at(state, state.cursor - pageSize);
  if (key.name === "pagedown") return at(state, state.cursor + pageSize);
  if (key.name === "home" || key.input === "g") return at(state, 0);
  if (key.name === "end" || key.input === "G") return at(state, visibleRows(state).length - 1);
  if (key.input === "/") return next({ ...state, filtering: true });
  if (key.input === "d" && state.destinations !== undefined)
    return next({
      ...state,
      destinationMenu:
        state.edit !== undefined &&
        (state.edit.pending.size > 0 ||
          (state.edit.namespace._tag === "profile" &&
            (state.edit.namespace.create || state.edit.namespace.seed !== undefined)) ||
          state.edit.namespace._tag === "copy")
          ? { phase: "pending" }
          : { phase: "choose", cursor: 0 },
    });
  if (key.name === "escape" && state.query.length > 0)
    return next({ ...state, query: "", cursor: 0 });
  if (key.name === "escape" || key.input === "q") {
    const staged = state.edit;
    if (staged !== undefined && staged.pending.size > 0 && staged.notice !== discardNotice)
      return next({ ...state, edit: { ...staged, notice: discardNotice } });
    return { _tag: "quit" };
  }
  const rows = visibleRows(state);
  const row = rows[state.cursor];
  const filtered = state.query.trim().length > 0;
  if (row?.kind === "folder") {
    const toggles = key.name === "return" || key.name === "space" || key.input === " ";
    if (toggles) return filtered ? next(state) : withCollapsed(state, row.key, row.expanded);
    if ((key.name === "right" || key.input === "l") && !row.expanded)
      return withCollapsed(state, row.key, false);
    if ((key.name === "right" || key.input === "l") && row.expanded)
      return at(state, state.cursor + 1);
  }
  if (key.name === "left" || key.input === "h") {
    if (row?.kind === "folder" && row.expanded && !filtered)
      return withCollapsed(state, row.key, true);
    const parent = rows.findLastIndex(
      (candidate, index) =>
        index < state.cursor && candidate.kind === "folder" && candidate.depth < (row?.depth ?? 0),
    );
    return parent < 0 ? next(state) : at(state, parent);
  }
  const entry = row?.kind === "entry" ? row.entry : undefined;
  if (edit !== undefined) {
    const request = stageKeys.find(([input]) => input === key.input)?.[1];
    if (request !== undefined)
      return row?.kind === "folder"
        ? next({ ...state, edit: stageFolder(edit, row.entries, request) })
        : entry === undefined
          ? next({ ...state, edit: { ...edit, notice: "Select a resource first." } })
          : next({ ...state, edit: stageChange(edit, entry.id, entry.editable, request) });
    const undo = undoKeys.find(([input]) => input === key.input)?.[1];
    if (undo !== undefined)
      return row?.kind === "folder"
        ? next({ ...state, edit: undoFolder(edit, row.entries, undo) })
        : entry === undefined
          ? next({ ...state, edit: { ...edit, notice: "Select a resource first." } })
          : next({ ...state, edit: undoChange(edit, entry.id, entry.editable, undo) });
    if (key.input === "c") {
      const authoringDraft =
        edit.namespace._tag === "copy" ||
        (edit.namespace._tag === "profile" &&
          (edit.namespace.create || edit.namespace.seed !== undefined));
      return edit.pending.size === 0 && authoringDraft === false
        ? next({ ...state, edit: { ...edit, notice: "Nothing is staged." } })
        : { _tag: "review", state };
    }
  }
  if (key.name === "return" && entry?.preview !== undefined) return { _tag: "open", state, entry };
  return next(state);
};

/** Opens the plan preview for the staged changes at its first line. */
export const withReview = (
  state: ExplorerState,
  review: Omit<ExplorerReview, "offset">,
): ExplorerState =>
  state.edit === undefined
    ? state
    : { ...state, edit: { ...state.edit, review: { ...review, offset: 0 } } };

/**
 * Replaces the entries after an apply with their persisted state and clears what was staged, so
 * the list shows the new choices.
 */
export const withAppliedEntries = (
  state: ExplorerState,
  entries: ReadonlyArray<ExplorerEntry> | undefined,
  review: Omit<ExplorerReview, "offset">,
): ExplorerState => {
  if (state.edit === undefined) return state;
  const reloaded = { ...state, entries: entries ?? state.entries };
  return {
    ...reloaded,
    cursor: Math.min(state.cursor, Math.max(0, visibleRows(reloaded).length - 1)),
    edit: {
      ...state.edit,
      namespace:
        state.edit.namespace._tag === "profile" && entries !== undefined
          ? {
              _tag: "profile",
              sourcePath: state.edit.namespace.sourcePath,
              profileName: state.edit.namespace.profileName,
              create: false,
            }
          : state.edit.namespace,
      // A failed reload keeps the list, so keep what is staged rather than hide it.
      pending: entries === undefined ? state.edit.pending : new Map(),
      review: { ...review, offset: 0 },
    },
  };
};

/** Opens a loaded preview at its first line. */
export const withPreview = (
  state: ExplorerState,
  title: string,
  lines: ReadonlyArray<string>,
): ExplorerState => ({
  ...state,
  preview: { title, lines, offset: 0 },
});
