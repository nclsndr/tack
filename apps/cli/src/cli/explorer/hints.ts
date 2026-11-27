import {
  editableValue,
  pendingText,
  stageChange,
  stageKeys,
  undoChange,
  undoKeys,
  type EditState,
} from "./edit.ts";
import { folderAction, folderStep, undoFolderStep } from "./folder.ts";
import type { ExplorerEntry } from "./model.ts";

/** What one staging key would do next on the selected row. */
export type KeyHint = {
  readonly key: (typeof stageKeys)[number][0] | (typeof undoKeys)[number][0];
  /** `again` when the key unstages what it staged; listed first. */
  readonly kind: "again" | "other";
  /** The detail pane's phrase for the key, such as `i again: unstage`. */
  readonly text: string;
  /** The footer's single word for the key, such as `unstage`. */
  readonly word: string;
};

/** Lists the key that undoes the current staging first, then the others in key order. */
export const hintText = (hints: ReadonlyArray<KeyHint>): string =>
  [
    ...hints.filter((hint) => hint.kind === "again"),
    ...hints.filter((hint) => hint.kind === "other"),
  ]
    .map((hint) => hint.text)
    .join(" · ");

/**
 * The footer's include and exclude keys with the word for their next press, then the undo keys that
 * do something neither of them does, so the line fits a narrow terminal; the detail pane lists every
 * undo key. A staging key that cannot apply to the row, such as on a locked built-in, keeps its
 * request name.
 */
export const footerKeys = (hints: ReadonlyArray<KeyHint>, undo: ReadonlyArray<KeyHint>): string => {
  const staging = stageKeys
    .filter(([key]) => key !== "a")
    .map(([key, request]) => ({
      key,
      word: hints.find((hint) => hint.key === key)?.word ?? request,
    }));
  return [...staging, ...undo.filter((hint) => staging.every((item) => item.word !== hint.word))]
    .map((item) => `${item.key} ${item.word}`)
    .join("  ");
};

const valueWords = {
  include: "include",
  exclude: "exclude",
  unset: "reset",
  member: "include",
  absent: "exclude",
  attach: "attach",
  detach: "detach",
  locked: "locked",
  fixed: "fixed",
  unavailable: "unavailable",
} as const satisfies Record<ReturnType<typeof editableValue>, string>;

/**
 * Names what each key would do next on one entry, derived by staging that key: the key that
 * staged the current change unstages it, and the others name the value they would leave.
 */
export const entryHints = (edit: EditState, entry: ExplorerEntry): ReadonlyArray<KeyHint> => {
  const current = edit.pending.get(entry.id);
  const pending = new Map(edit.pending);
  pending.delete(entry.id);
  const unstaged = { ...edit, pending };
  return stageKeys.flatMap(([key, request]): ReadonlyArray<KeyHint> => {
    const next = stageChange(edit, entry.id, entry.editable, request);
    if (next.notice !== undefined) return [];
    const after = next.pending.get(entry.id);
    const produced = stageChange(unstaged, entry.id, entry.editable, request).pending.get(entry.id);
    if (
      current !== undefined &&
      after === undefined &&
      produced !== undefined &&
      pendingText(produced) === pendingText(current)
    )
      return [{ key, kind: "again", text: `${key} again: unstage`, word: "unstage" }];
    const word = valueWords[editableValue(entry.editable, after)];
    const phrase = word === "reset" ? "reset to default" : word;
    return [
      {
        key,
        kind: "other",
        text: `${key}: ${phrase}${current === undefined ? "" : " instead"}`,
        word,
      },
    ];
  });
};

/** Names what each key would do next on a folder, derived from the same step the key runs. */
export const folderHints = (
  edit: EditState,
  entries: ReadonlyArray<ExplorerEntry>,
): ReadonlyArray<KeyHint> =>
  stageKeys.flatMap(([key, request]): ReadonlyArray<KeyHint> => {
    const step = folderStep(edit, entries, request);
    if (step.kind === "refused") return [];
    if (step.kind === "unstage")
      return [{ key, kind: "again", text: `${key} again: unstage all`, word: "unstage" }];
    const action = folderAction(step.kind, request);
    const reset = step.kind === "reset" && request !== "attach";
    return [
      {
        key,
        kind: "other",
        text:
          step.kind === "rest"
            ? `${key}: ${action} the rest`
            : reset
              ? `${key}: reset all to default`
              : `${key}: ${action} all`,
        word: reset ? "reset" : action,
      },
    ];
  });

/**
 * Names the undo keys that would change one entry: `u` while something is staged, and `r` while a
 * saved pick exists, which unstages a reset it already staged.
 */
export const entryUndoHints = (edit: EditState, entry: ExplorerEntry): ReadonlyArray<KeyHint> => {
  const staged = edit.pending.get(entry.id);
  const saved = entry.editable?.kind === "choice" && entry.editable.current !== undefined;
  return undoKeys.flatMap(([key, request]): ReadonlyArray<KeyHint> => {
    if (undoChange(edit, entry.id, entry.editable, request).notice !== undefined) return [];
    if (request === "unstage")
      return [{ key, kind: "other", text: `${key}: unstage`, word: "unstage" }];
    if (saved === false) return [];
    return staged?.kind === "choice" && staged.decision === "unset"
      ? [{ key, kind: "other", text: `${key} again: unstage`, word: "unstage" }]
      : [{ key, kind: "other", text: `${key}: reset to default`, word: "reset" }];
  });
};

/** Names the undo keys that would change a folder, derived from the same step the key runs. */
export const folderUndoHints = (
  edit: EditState,
  entries: ReadonlyArray<ExplorerEntry>,
): ReadonlyArray<KeyHint> =>
  undoKeys.flatMap(([key, request]): ReadonlyArray<KeyHint> => {
    const step = undoFolderStep(edit, entries, request);
    if (step.kind === "refused") return [];
    return request === "unstage"
      ? [{ key, kind: "other", text: `${key}: unstage all`, word: "unstage" }]
      : step.kind === "unstage"
        ? [{ key, kind: "other", text: `${key} again: unstage all`, word: "unstage" }]
        : [{ key, kind: "other", text: `${key}: reset all to default`, word: "reset" }];
  });
