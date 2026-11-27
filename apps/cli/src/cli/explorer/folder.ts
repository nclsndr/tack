import {
  editableValue,
  requestedValue,
  stageChange,
  stageRefusal,
  undoChange,
  type EditState,
  type StageRequest,
  type UndoRequest,
} from "./edit.ts";
import type { ExplorerEntry } from "./model.ts";

const effectiveValue = (edit: EditState, entry: ExplorerEntry) =>
  editableValue(entry.editable, edit.pending.get(entry.id));

/** Describes a count relative to the complete group, including empty groups. */
export const aggregateText = (count: number, total: number): string =>
  `${count === 0 ? "none" : count === total ? "all" : "some"} (${count}/${total})`;

/** Counts effective descendant states, using staged values before persisted values. */
export const folderSummary = (edit: EditState, entries: ReadonlyArray<ExplorerEntry>) => {
  const values = entries.map((entry) => effectiveValue(edit, entry));
  const count = (value: (typeof values)[number]) => values.filter((item) => item === value).length;
  const included = count("include");
  const excluded = count("exclude");
  const unset = count("unset");
  const attached = count("attach");
  const detached = count("detach");
  const members = count("member");
  return {
    included,
    excluded,
    unset,
    attached,
    detached,
    members,
    choices: included + excluded + unset,
    docs: attached + detached,
    membership: members + count("absent"),
    locked: count("locked"),
    unavailable: count("unavailable"),
    staged: entries.filter((entry) => edit.pending.has(entry.id)).length,
    /** Descendants the edited destination delivers, out of those it decides. */
    active: entries.filter((entry) => entry.activity?.active === true).length,
    decided: entries.filter((entry) => entry.activity !== undefined).length,
  };
};

/**
 * What one key does to a folder: `all` or `rest` sets the descendants that lack the value,
 * `unstage` toggles back the ones staged to it once every descendant has it, and `reset` presses
 * the key on every descendant when all of them already have the value without staging.
 */
export type FolderStep =
  | { readonly kind: "refused"; readonly notice: string }
  | {
      readonly kind: "all" | "rest" | "unstage" | "reset";
      readonly edit: EditState;
      /** Descendants whose staged change differs after the step. */
      readonly changed: number;
      /** Descendants the request can never apply to, such as locked or other-kind entries. */
      readonly skipped: number;
    };

const pastTense = { include: "included", exclude: "excluded", attach: "attached" } as const;

/** Plans one key on every descendant, leaving each entry's transition to the row handler. */
export const folderStep = (
  edit: EditState,
  entries: ReadonlyArray<ExplorerEntry>,
  request: StageRequest,
): FolderStep => {
  const eligible = entries.filter((entry) => stageRefusal(entry.editable, request) === undefined);
  if (eligible.length === 0)
    return { kind: "refused", notice: `No descendants can ${request} here.` };
  const wanted = (entry: ExplorerEntry) => requestedValue(entry.editable, request);
  const missing = eligible.filter((entry) => effectiveValue(edit, entry) !== wanted(entry));
  const staged = eligible.filter((entry) => edit.pending.has(entry.id));
  const kind =
    missing.length > 0
      ? missing.length === eligible.length
        ? "all"
        : "rest"
      : staged.length > 0
        ? "unstage"
        : "reset";
  const targets = kind === "unstage" ? staged : kind === "reset" ? eligible : missing;
  const next = targets.reduce((latest, entry) => {
    const step = stageChange(latest, entry.id, entry.editable, request);
    return step.notice === undefined ? step : latest;
  }, edit);
  const changed = targets.filter(
    (entry) => next.pending.get(entry.id) !== edit.pending.get(entry.id),
  ).length;
  if (changed === 0)
    return {
      kind: "refused",
      notice: `All ${eligible.length} descendants are already ${pastTense[request]}.`,
    };
  return { kind, edit: next, changed, skipped: entries.length - eligible.length };
};

/** Names what a folder step does to the descendants it changes. */
export const folderAction = (
  kind: Exclude<FolderStep["kind"], "refused">,
  request: StageRequest,
) =>
  kind === "unstage"
    ? "unstage"
    : kind === "reset"
      ? request === "attach"
        ? "detach"
        : "reset to default"
      : request;

/** Applies one key to every descendant and reports how many changed and were skipped. */
export const stageFolder = (
  edit: EditState,
  entries: ReadonlyArray<ExplorerEntry>,
  request: StageRequest,
): EditState => {
  const step = folderStep(edit, entries, request);
  if (step.kind === "refused") return { ...edit, notice: step.notice };
  return {
    ...step.edit,
    notice: `${step.changed} ${step.changed === 1 ? "descendant" : "descendants"}: ${folderAction(step.kind, request)}. ${step.skipped} skipped.`,
  };
};

const counted = (count: number) => `${count} ${count === 1 ? "descendant" : "descendants"}`;

/**
 * Plans one undo key on every descendant. `unstage` drops every staged change. `reset` stages the
 * removal of every saved pick and drops staged changes on descendants without one; when every saved
 * pick is already staged for reset, it unstages those resets instead.
 */
export const undoFolderStep = (
  edit: EditState,
  entries: ReadonlyArray<ExplorerEntry>,
  request: UndoRequest,
): FolderStep => {
  const eligible = entries.filter((entry) =>
    request === "unstage"
      ? entry.editable !== undefined &&
        entry.editable.kind !== "builtin" &&
        entry.editable.kind !== "fixed"
      : entry.editable?.kind === "choice",
  );
  const skipped = entries.length - eligible.length;
  const staged = eligible.filter((entry) => edit.pending.has(entry.id));
  if (request === "unstage")
    return staged.length === 0
      ? { kind: "refused", notice: "Nothing is staged here." }
      : {
          kind: "unstage",
          edit: staged.reduce(
            (latest, entry) => undoChange(latest, entry.id, entry.editable, request),
            edit,
          ),
          changed: staged.length,
          skipped,
        };
  if (eligible.length === 0) return { kind: "refused", notice: "No descendants can reset here." };
  const resetStaged = (entry: ExplorerEntry) => {
    const change = edit.pending.get(entry.id);
    return change?.kind === "choice" && change.decision === "unset";
  };
  const saved = (entry: ExplorerEntry) =>
    entry.editable?.kind === "choice" && entry.editable.current !== undefined;
  const missing = eligible.filter((entry) =>
    saved(entry) ? resetStaged(entry) === false : edit.pending.has(entry.id),
  );
  const targets = missing.length > 0 ? missing : eligible.filter((entry) => resetStaged(entry));
  if (targets.length === 0)
    return {
      kind: "refused",
      notice: `All ${eligible.length} descendants are already at their default.`,
    };
  return {
    kind: missing.length > 0 ? "reset" : "unstage",
    edit: targets.reduce(
      (latest, entry) => undoChange(latest, entry.id, entry.editable, request),
      edit,
    ),
    changed: targets.length,
    skipped,
  };
};

/** Applies one undo key to every descendant and reports how many changed and were skipped. */
export const undoFolder = (
  edit: EditState,
  entries: ReadonlyArray<ExplorerEntry>,
  request: UndoRequest,
): EditState => {
  const step = undoFolderStep(edit, entries, request);
  if (step.kind === "refused") return { ...edit, notice: step.notice };
  return {
    ...step.edit,
    notice: `${counted(step.changed)}: ${step.kind === "unstage" ? "unstage" : "reset to default"}. ${step.skipped} skipped.`,
  };
};
