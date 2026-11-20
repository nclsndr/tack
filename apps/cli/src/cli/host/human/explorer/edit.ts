import { builtinSkillLockReason } from "../../../../domain/choices/builtin.ts";
import {
  skillChoiceIdentity,
  type ChoiceDecision,
  type ChoiceNamespace,
  type SkillChoice,
} from "../../../../domain/choices/choice-schema.ts";
import {
  docsResourceIdentity,
  type DocsResourceReference,
} from "../../../../domain/docs/docs-schema.ts";
import type {
  ResourceAddress,
  SelectableAddress,
} from "../../../../domain/sources/catalog-schema.ts";
import type { ExplorerDestination } from "./destination.ts";
import { withChoice } from "../../../../features/choices/choice.ts";
import {
  allSkillChoices,
  docsSettingsFor,
  withDocsSettings,
} from "../../../../domain/state/state-intent.ts";
import type { State } from "../../../../domain/state/state-schema.ts";

/** Whether an entry is locked or can stage changes, with its persisted starting value. */
export type Editable =
  | { readonly kind: "member"; readonly address: ResourceAddress; readonly included: boolean }
  | { readonly kind: "builtin" }
  /** A row of a user or project selection that a fixed profile owns, named as `source/name`. */
  | { readonly kind: "fixed"; readonly profile: string }
  | {
      readonly kind: "choice";
      readonly address: SelectableAddress;
      /** The decision persisted in the edited namespace, if any. */
      readonly current: ChoiceDecision | undefined;
    }
  | {
      readonly kind: "docs";
      readonly resource: DocsResourceReference;
      readonly attached: boolean;
    };

/** One staged change. Nothing is persisted until the operator confirms the review. */
export type PendingChange =
  | { readonly kind: "member"; readonly address: ResourceAddress; readonly included: boolean }
  | {
      readonly kind: "choice";
      readonly address: SelectableAddress;
      /** `unset` removes the persisted choice so declarations apply again. */
      readonly decision: ChoiceDecision | "unset";
    }
  | {
      readonly kind: "docs";
      readonly resource: DocsResourceReference;
      readonly attached: boolean;
    };

/** The plan or result screen shown before and after a confirmed apply. */
export type ExplorerReview = {
  readonly phase: "preview" | "result";
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  readonly offset: number;
};

/** Edit mode: one namespace, the staged changes, and the review screen when open. */
export type EditState = {
  readonly namespace: ExplorerDestination;
  /** Staged changes by entry id. */
  readonly pending: ReadonlyMap<string, PendingChange>;
  readonly review: ExplorerReview | undefined;
  /** A one-line notice for the footer, cleared by the next key. */
  readonly notice: string | undefined;
  /** The profile, as `source/name`, that fixes the edited user or project selection. */
  readonly fixedBy?: string;
};

/** The keys that stage a change on the selected row, with the request each one makes. */
export const stageKeys = [
  ["i", "include"],
  ["x", "exclude"],
  ["a", "attach"],
] as const;

/** The staging requests an operator can make on the selected entry. */
export type StageRequest = (typeof stageKeys)[number][1];

/** The keys that undo on the selected row: drop its staged change, or reset its saved pick. */
export const undoKeys = [
  ["u", "unstage"],
  ["r", "reset"],
] as const;

/** The undo requests an operator can make on the selected entry. */
export type UndoRequest = (typeof undoKeys)[number][1];

/** Starts edit mode with nothing staged; `fixedBy` names the profile that fixes the selection. */
export const initialEditState = (namespace: ExplorerDestination, fixedBy?: string): EditState => ({
  namespace,
  pending: new Map(),
  review: undefined,
  notice: undefined,
  ...(fixedBy === undefined ? {} : { fixedBy }),
});

/** The name of the namespace being edited, for headings. */
export const namespaceText = (namespace: ExplorerDestination): string =>
  namespace._tag === "copy"
    ? `save selection: ${[...(namespace.input.user ? ["user"] : []), ...(namespace.input.projectName === undefined ? [] : [`project ${namespace.input.projectName}`])].join(" + ")}`
    : namespace._tag === "profile"
      ? `profile ${namespace.profileName}`
      : namespace._tag === "user"
        ? "user"
        : `project ${namespace.projectName}`;

/** Describes one staged change in a few words. */
export const pendingText = (change: PendingChange): string =>
  change.kind === "member"
    ? change.included
      ? "include"
      : "exclude"
    : change.kind === "docs"
      ? change.attached
        ? "attach"
        : "detach"
      : change.decision === "unset"
        ? "reset"
        : change.decision;

const withPending = (edit: EditState, id: string, change: PendingChange | undefined): EditState => {
  const pending = new Map(edit.pending);
  if (change === undefined) pending.delete(id);
  else pending.set(id, change);
  return { ...edit, notice: undefined, pending };
};

/** Resolves the row's effective state, using its staged change before its persisted value. */
export const editableValue = (
  editable: Editable | undefined,
  pending: PendingChange | undefined,
) => {
  if (editable === undefined) return "unavailable";
  if (editable.kind === "builtin") return "locked";
  if (editable.kind === "fixed") return "fixed";
  if (editable.kind === "choice")
    return pending?.kind === "choice" ? pending.decision : (editable.current ?? "unset");
  if (editable.kind === "member")
    return (pending?.kind === "member" ? pending.included : editable.included) === true
      ? "member"
      : "absent";
  return (pending?.kind === "docs" ? pending.attached : editable.attached) === true
    ? "attach"
    : "detach";
};

/** The effective value a request sets; members are included by i and excluded by x. */
export const requestedValue = (editable: Editable | undefined, request: StageRequest) =>
  editable?.kind === "member" ? (request === "include" ? "member" : "absent") : request;

/** A request paired with an entry it can apply to. */
type Applicable =
  | { readonly editable: Extract<Editable, { kind: "docs" }>; readonly request: "attach" }
  | {
      readonly editable: Extract<Editable, { kind: "member" | "choice" }>;
      readonly request: "include" | "exclude";
    };

/** Why nothing stages in a selection a fixed profile owns, and where to edit it instead. */
export const fixedSelectionReason = (profile: string): string =>
  `This selection is fixed by profile ${profile}. Press d and choose ${profile} under Profiles to edit its members.`;

/** Pairs a request with the entry, or says why the request never applies to it. */
const applicable = (editable: Editable | undefined, request: StageRequest): Applicable | string => {
  if (editable === undefined) return "This entry cannot be changed here.";
  if (editable.kind === "builtin") return builtinSkillLockReason;
  if (editable.kind === "fixed") return fixedSelectionReason(editable.profile);
  if (editable.kind === "docs")
    return request === "attach" ? { editable, request } : "Docs are attached with a.";
  if (request === "attach")
    return editable.kind === "member"
      ? "Profile members use i to include or x to exclude."
      : "Skills are chosen with i or x.";
  return { editable, request };
};

/** Why a request never applies to an entry, whatever is staged; undefined when it can apply. */
export const stageRefusal = (
  editable: Editable | undefined,
  request: StageRequest,
): string | undefined => {
  const target = applicable(editable, request);
  return typeof target === "string" ? target : undefined;
};

/**
 * Stages the change one key asks for on one entry. Each key toggles: pressing the key that staged
 * the current change again unstages it, and a change equal to the persisted value is not staged.
 * An unstaged choice that already has the requested value is reset to its default; an unstaged
 * member that already has it is left as it is.
 */
export const stageChange = (
  edit: EditState,
  entryId: string,
  editable: Editable | undefined,
  request: StageRequest,
): EditState => {
  const target = applicable(editable, request);
  if (typeof target === "string")
    // A locked entry never keeps a staged change, even one forged before the lock applied.
    return editable?.kind === "builtin" || editable?.kind === "fixed"
      ? { ...withPending(edit, entryId, undefined), notice: target }
      : { ...edit, notice: target };
  const staged = edit.pending.get(entryId);
  const effective = editableValue(target.editable, staged);
  const wanted = requestedValue(target.editable, request);
  if (effective === wanted && staged !== undefined) return withPending(edit, entryId, undefined);
  if (target.request === "attach") {
    const attached = effective !== "attach";
    return withPending(
      edit,
      entryId,
      attached === target.editable.attached
        ? undefined
        : { kind: "docs", resource: target.editable.resource, attached },
    );
  }
  if (target.editable.kind === "member") {
    if (effective === wanted)
      return { ...edit, notice: wanted === "member" ? "Already included." : "Already excluded." };
    const included = wanted === "member";
    return withPending(
      edit,
      entryId,
      included === target.editable.included
        ? undefined
        : { kind: "member", address: target.editable.address, included },
    );
  }
  const decision = effective === wanted ? ("unset" as const) : target.request;
  return withPending(
    edit,
    entryId,
    decision === (target.editable.current ?? "unset")
      ? undefined
      : { kind: "choice", address: target.editable.address, decision },
  );
};

/**
 * Applies staged changes to a state snapshot in memory only, so planning can preview what a
 * confirmed apply would do. The explorer never persists this state.
 */
export const stagedState = (
  state: State,
  namespace: ChoiceNamespace,
  pending: ReadonlyArray<PendingChange>,
): State => {
  let choices: ReadonlyArray<SkillChoice> = allSkillChoices(state);
  let latest = state;
  for (const change of pending) {
    if (change.kind === "choice") {
      const identity = skillChoiceIdentity({ address: change.address, namespace });
      choices = [
        ...choices.filter((choice) => skillChoiceIdentity(choice) !== identity),
        ...(change.decision === "unset"
          ? []
          : [{ address: change.address, decision: change.decision, namespace }]),
      ];
    } else if (change.kind === "docs" && namespace._tag === "project") {
      const projectName = namespace.projectName;
      const settings = docsSettingsFor(latest, projectName) ?? { projectName, attachments: [] };
      const identity = docsResourceIdentity(change.resource);
      const others = settings.attachments.filter(
        (resource) => docsResourceIdentity(resource) !== identity,
      );
      const { defaultWritingResource, ...rest } = settings;
      const keepDefault =
        defaultWritingResource !== undefined &&
        (change.attached || docsResourceIdentity(defaultWritingResource) !== identity);
      latest = withDocsSettings(latest, {
        ...rest,
        attachments: change.attached ? [...others, change.resource] : others,
        ...(keepDefault ? { defaultWritingResource } : {}),
      });
    }
  }
  return withChoice(latest, namespace, choices);
};

/** Why a reset never applies to an entry, for the entries that hold no saved pick. */
const resetRefusal = (editable: Editable | undefined): string | undefined =>
  editable === undefined
    ? "This entry cannot be changed here."
    : editable.kind === "builtin"
      ? builtinSkillLockReason
      : editable.kind === "fixed"
        ? fixedSelectionReason(editable.profile)
        : editable.kind === "docs"
          ? "Docs are attached with a."
          : editable.kind === "member"
            ? "Profile members use i to include or x to exclude."
            : undefined;

/**
 * Undoes on one entry. `unstage` drops its staged change, back to the saved state. `reset` stages
 * the removal of its saved pick so the source default applies again, and on an entry without a
 * saved pick drops its staged change instead. Pressing `r` again unstages the staged reset.
 */
export const undoChange = (
  edit: EditState,
  entryId: string,
  editable: Editable | undefined,
  request: UndoRequest,
): EditState => {
  const staged = edit.pending.get(entryId);
  if (request === "unstage")
    return staged === undefined
      ? { ...edit, notice: "Nothing is staged here." }
      : withPending(edit, entryId, undefined);
  const refusal = resetRefusal(editable);
  if (refusal !== undefined || editable?.kind !== "choice")
    return { ...edit, notice: refusal ?? "This entry cannot be changed here." };
  if (editable.current === undefined)
    return staged === undefined
      ? { ...edit, notice: "Already at its default." }
      : withPending(edit, entryId, undefined);
  return withPending(
    edit,
    entryId,
    staged?.kind === "choice" && staged.decision === "unset"
      ? undefined
      : { kind: "choice", address: editable.address, decision: "unset" },
  );
};
