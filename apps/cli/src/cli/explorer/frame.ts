import type { Style } from "../human/style.ts";
import { rowActivityText, type ExplorerActivity } from "./activity.ts";
import {
  fixedSelectionReason,
  destinationText,
  pendingText,
  type EditState,
  type PendingChange,
} from "./edit.ts";
import { destinationMenuLines } from "./destination.ts";
import { aggregateText, folderSummary } from "./folder.ts";
import {
  entryHints,
  entryUndoHints,
  folderHints,
  folderUndoHints,
  footerKeys,
  hintText,
  type KeyHint,
} from "./hints.ts";
import {
  selectedRow,
  visibleEntries,
  visibleRows,
  type ExplorerEntry,
  type ExplorerRow,
  type ExplorerState,
} from "./model.ts";

const minimum = { columns: 40, rows: 8 } as const;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const characters = (text: string) => Array.from(segmenter.segment(text), ({ segment }) => segment);
const cells = (text: string): number =>
  characters(text).reduce(
    (width, character) =>
      width +
      (/\p{Extended_Pictographic}|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/u.test(
        character,
      )
        ? 2
        : 1),
    0,
  );
const fit = (text: string, width: number): string => {
  let result = "";
  let used = 0;
  for (const character of characters(text)) {
    const size = cells(character);
    if (used + size > width) break;
    result += character;
    used += size;
  }
  return result + " ".repeat(Math.max(0, width - used));
};

/** Shortens text to the width, ending with an ellipsis when something was cut. */
const ellipsize = (text: string, width: number): string =>
  cells(text) <= width ? text : `${fit(text, Math.max(0, width - 1)).trimEnd()}…`;

/** Cuts text into lines of at most `width` cells, wherever a line fills up. */
const cut = (text: string, width: number): ReadonlyArray<string> => {
  const lines: string[] = [];
  let current = "";
  let used = 0;
  for (const character of characters(text)) {
    const size = cells(character);
    if (used + size > width && current.length > 0) {
      lines.push(current);
      current = "";
      used = 0;
    }
    current += character;
    used += size;
  }
  return [...lines, current];
};

/**
 * Wraps text at spaces into lines of at most `width` cells. A word wider than a line, such as a
 * path, is cut where the line fills up.
 */
const wrap = (text: string, width: number): ReadonlyArray<string> =>
  text.split(" ").reduce<ReadonlyArray<string>>((lines, word) => {
    const last = lines.at(-1);
    if (last === undefined) return cut(word, width);
    const joined = `${last} ${word}`;
    return cells(joined) <= width
      ? [...lines.slice(0, -1), joined]
      : [...lines, ...cut(word, width)];
  }, []);

type ListRow =
  | { readonly kind: "heading"; readonly title: string }
  | { readonly kind: "row"; readonly row: ExplorerRow; readonly index: number };
const rowsFor = (rows: ReadonlyArray<ExplorerRow>): ReadonlyArray<ListRow> => {
  const list: ListRow[] = [];
  rows.forEach((row, index) => {
    if (rows[index - 1]?.section !== row.section)
      list.push({ kind: "heading", title: row.section });
    list.push({ kind: "row", row, index });
  });
  return list;
};

const listLine = (
  row: ListRow | undefined,
  cursor: number,
  width: number,
  style: Style,
  staged: (entry: ExplorerEntry) => string | undefined,
  edit: EditState | undefined,
): string => {
  if (row === undefined) return " ".repeat(width);
  if (row.kind === "heading") return style.dim(style.bold(fit(` ${row.title}`, width)));
  const selected = row.index === cursor;
  const marker = selected ? " › " : "   ";
  const tagsWidth = Math.min(24, Math.floor(width * 0.42));
  const item = row.row;
  const glyph = item.kind === "folder" ? (item.expanded ? "▾ " : "▸ ") : "";
  const label = item.kind === "folder" ? item.label : item.entry.title;
  const change = item.kind === "folder" ? undefined : staged(item.entry);
  const activity = item.kind === "folder" || edit === undefined ? undefined : item.entry.activity;
  const summary =
    item.kind === "folder" && edit !== undefined ? folderSummary(edit, item.entries) : undefined;
  const tagText =
    item.kind === "folder"
      ? summary === undefined
        ? `${item.count}`
        : summary.decided > 0
          ? `${summary.active}/${summary.decided} active`
          : summary.membership > 0
            ? aggregateText(summary.members, summary.membership)
            : summary.choices > 0
              ? aggregateText(summary.included, summary.choices)
              : summary.docs > 0
                ? aggregateText(summary.attached, summary.docs)
                : `${item.count} ${summary.locked > 0 ? "locked" : "unavailable"}`
      : activity !== undefined
        ? rowActivityText(activity)
        : [...(change === undefined ? [] : [`→${change}`]), ...item.entry.tags].join(" ");
  // One cell stays free so a long name never touches the tags column.
  const line = fit(
    ellipsize(marker + "  ".repeat(item.depth) + glyph + label, width - tagsWidth - 1),
    width - tagsWidth,
  );
  // The edited destination's state leads; a staged change follows it in its own colour.
  const staging = activity === undefined || change === undefined ? "" : ` → ${change}`;
  const stateWidth = Math.max(0, tagsWidth - cells(staging));
  const state =
    staging === "" ? fit(ellipsize(tagText, tagsWidth), tagsWidth) : ellipsize(tagText, stateWidth);
  const tags = staging === "" ? state : fit(state + staging, tagsWidth);
  if (selected) return style.cyan(style.bold(line + tags));
  if (item.kind === "folder") return style.bold(line) + style.dim(tags);
  const entryLine = item.entry.issue ? style.yellow(line) : line;
  if (activity !== undefined)
    return (
      entryLine +
      (activity.active ? state : style.dim(state)) +
      (staging === "" ? "" : style.yellow(fit(staging, tagsWidth - cells(state))))
    );
  return entryLine + (change === undefined ? style.dim(tags) : style.yellow(tags));
};

const folderDetailLines = (
  row: Extract<ExplorerRow, { kind: "folder" }>,
  width: number,
  style: Style,
  edit: EditState | undefined,
  hints: ReadonlyArray<KeyHint>,
  undo: ReadonlyArray<KeyHint>,
): ReadonlyArray<string> => {
  const summary = edit === undefined ? undefined : folderSummary(edit, row.entries);
  const hint = hintText(hints);
  return [
    style.bold(fit(row.path.join("/"), width)),
    "",
    `${style.dim(fit("contains", 10))}${fit(`${row.count} ${row.count === 1 ? "entry" : "entries"}`, Math.max(1, width - 10))}`,
    `${style.dim(fit("state", 10))}${fit(row.expanded ? "expanded" : "collapsed", Math.max(1, width - 10))}`,
    ...(summary === undefined
      ? []
      : [
          "",
          ...(row.count === row.entries.length
            ? []
            : [`Actions cover all ${row.entries.length} descendants, including hidden entries.`]),
          ...(summary.decided === 0
            ? []
            : [`Active: ${aggregateText(summary.active, summary.decided)}`]),
          ...(summary.choices === 0
            ? []
            : [
                `Included: ${aggregateText(summary.included, summary.choices)}`,
                `Excluded: ${aggregateText(summary.excluded, summary.choices)}`,
                `Default: ${aggregateText(summary.unset, summary.choices)}`,
              ]),
          ...(summary.docs === 0
            ? []
            : [`Attached: ${aggregateText(summary.attached, summary.docs)}`]),
          ...(summary.membership === 0
            ? []
            : [`Members: ${aggregateText(summary.members, summary.membership)}`]),
          `Staged: ${aggregateText(summary.staged, row.entries.length)}`,
          `${summary.locked} locked, ${summary.unavailable} unavailable`,
          ...(hint === "" ? [] : ["", style.dim(hint)]),
          ...(undo.length === 0 ? [] : [style.dim(hintText(undo))]),
        ].map((line) => ellipsize(line, width))),
    "",
    style.dim(ellipsize("Enter: expand or collapse", width)),
  ];
};

/** What a staged change does to the edited destination, when the row says what it delivers. */
const stagedText = (change: PendingChange, activity: ExplorerActivity | undefined): string => {
  const text = pendingText(change);
  if (change.kind !== "choice") return text;
  if (change.decision === "unset") return `${text} to default (removes the saved pick)`;
  if (activity === undefined) return text;
  return change.decision === "include" && activity.active
    ? `${text} (already active, no link change)`
    : change.decision === "exclude" && activity.active === false
      ? `${text} (already inactive, no link change)`
      : text;
};

const detailLines = (
  entry: ExplorerEntry | undefined,
  width: number,
  style: Style,
  editing:
    | {
        readonly hints: ReadonlyArray<KeyHint>;
        readonly undo: ReadonlyArray<KeyHint>;
        readonly staged: PendingChange | undefined;
      }
    | undefined,
): ReadonlyArray<string> => {
  if (entry === undefined) return [style.dim(fit("Nothing matches the filter.", width))];
  const labelWidth = Math.min(
    width - 2,
    18,
    Math.max(10, ...entry.facts.map(([label]) => label.length + 2)),
  );
  return [
    style.bold(fit(entry.title, width)),
    fit(entry.description, width),
    "",
    ...entry.facts.flatMap(([label, value]) => {
      const available = Math.max(1, width - labelWidth);
      const parts = wrap(value, available);
      return parts.map(
        (part, index) =>
          `${index === 0 ? style.dim(fit(label, labelWidth)) : " ".repeat(labelWidth)}${fit(part, available)}`,
      );
    }),
    ...(editing === undefined || entry.editable?.kind !== "fixed"
      ? []
      : [
          "",
          ...wrap(fixedSelectionReason(entry.editable.profile), width).map((line) =>
            style.dim(line),
          ),
        ]),
    ...(editing === undefined ||
    entry.editable === undefined ||
    entry.editable.kind === "builtin" ||
    entry.editable.kind === "fixed"
      ? []
      : [
          "",
          editing.staged === undefined
            ? style.dim("Not staged")
            : style.yellow(
                ellipsize(`Staged: ${stagedText(editing.staged, entry.activity)}`, width),
              ),
          style.dim(hintText(editing.hints)),
          ...(editing.undo.length === 0 ? [] : [style.dim(hintText(editing.undo))]),
        ]),
    ...(entry.preview === undefined ? [] : ["", style.dim("Enter: preview")]),
  ];
};

/** Renders a complete alternate-screen frame at the current terminal size. */
export const renderExplorerFrame = (
  state: ExplorerState,
  size: { readonly rows: number; readonly columns: number },
  style: Style,
): string => {
  const columns = Math.max(1, size.columns - 1);
  if (size.columns < minimum.columns || size.rows < minimum.rows)
    return `\u001b[H\u001b[2J${fit("Enlarge the terminal to browse. Press q to quit.", columns)}`;
  const height = size.rows - 4;
  const visible = visibleEntries(state);
  const edit = state.edit;
  const current = selectedRow(state);
  // One derivation feeds both the detail pane and the footer, so they always agree.
  const hints =
    edit === undefined || current === undefined
      ? []
      : current.kind === "folder"
        ? folderHints(edit, current.entries)
        : entryHints(edit, current.entry);
  const undo =
    edit === undefined || current === undefined
      ? []
      : current.kind === "folder"
        ? folderUndoHints(edit, current.entries)
        : entryUndoHints(edit, current.entry);
  const staged = (entry: ExplorerEntry) => {
    const change = edit?.pending.get(entry.id);
    return change === undefined ? undefined : pendingText(change);
  };
  const heading = ` ${state.heading}${
    edit === undefined
      ? ""
      : `  ·  editing ${destinationText(edit.namespace)}  ·  ${edit.fixedBy === undefined ? `${edit.pending.size} staged` : `fixed by ${edit.fixedBy}, read-only`}`
  }`;
  const filter =
    state.query.length > 0 || state.filtering
      ? ` /${state.query}${state.filtering ? "▏" : ""}  ${visible.length} matches`
      : "";
  const filterWidth = Math.min(columns, cells(filter));
  const header = fit(heading, columns - filterWidth) + fit(filter, filterWidth);
  let body: ReadonlyArray<string>;
  if (state.destinationMenu !== undefined) {
    const lines = destinationMenuLines(state.destinationMenu, state.destinations ?? [], height);
    body = Array.from({ length: height }, (_, index) => fit(lines[index] ?? "", columns));
  } else if (edit?.review !== undefined) {
    const review = edit.review;
    body = [
      style.bold(fit(review.title, columns)),
      ...Array.from({ length: height - 1 }, (_, index) =>
        fit(review.lines[review.offset + index] ?? "", columns),
      ),
    ];
  } else if (state.preview !== undefined) {
    body = [
      style.bold(fit(state.preview.title, columns)),
      ...Array.from({ length: height - 1 }, (_, index) =>
        fit(state.preview?.lines[state.preview.offset + index] ?? "~", columns),
      ),
    ];
  } else {
    const leftWidth = Math.min(62, Math.max(20, Math.floor(columns * 0.45)));
    const rightWidth = columns - leftWidth - 3;
    const list = rowsFor(visibleRows(state));
    const selected = list.findIndex((row) => row.kind === "row" && row.index === state.cursor);
    const offset = Math.max(0, Math.min(selected - Math.floor(height / 2), list.length - height));
    const detail =
      current?.kind === "folder"
        ? folderDetailLines(current, rightWidth, style, edit, hints, undo)
        : detailLines(
            current?.entry,
            rightWidth,
            style,
            edit === undefined
              ? undefined
              : {
                  hints,
                  undo,
                  staged:
                    current?.entry === undefined ? undefined : edit.pending.get(current.entry.id),
                },
          );
    body = Array.from(
      { length: height },
      (_, index) =>
        `${listLine(list[offset + index], state.cursor, leftWidth, style, staged, edit)}${style.dim(" │ ")}${detail[index] ?? ""}`,
    );
  }
  const footer =
    edit?.review !== undefined
      ? edit.review.phase === "preview"
        ? edit.namespace._tag === "copy"
          ? " y choose source/name  n back (nothing was written)  ↑↓ scroll"
          : edit.namespace._tag === "profile"
            ? " y save profile  n back (nothing was written)  ↑↓ scroll"
            : " y apply these changes  n back (nothing was written)  ↑↓ scroll"
        : " ↑↓ scroll  q back"
      : state.preview !== undefined
        ? " ↑↓ scroll  space page  q back"
        : state.filtering
          ? " Type to filter  Enter done  Esc clear"
          : edit?.notice !== undefined
            ? ` ${edit.notice}`
            : edit !== undefined
              ? ` d destination  ${footerKeys(hints, undo)}  c review/save  / filter  q quit`
              : " d destination  ↑↓ move  ←→ fold  / filter  Enter open  q quit";
  const lines = [
    header,
    style.dim("─".repeat(columns)),
    ...body,
    style.dim("─".repeat(columns)),
    style.dim(fit(footer, columns)),
  ];
  return `\u001b[H\u001b[2J${lines.map((line, index) => `\u001b[${index + 1};1H${line}\u001b[K`).join("")}`;
};
