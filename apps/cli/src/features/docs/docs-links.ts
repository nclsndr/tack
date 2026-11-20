import { Effect, FileSystem, Path } from "effect";
import { Destination, observeDestination } from "../../services/destination.ts";
import { classifyDestination, deliveryKindOf, isOwnedClaim } from "../links/link-delivery.ts";
import {
  concludeResult,
  concludeSettled,
  concludeUnchanged,
  conclude,
  createLink,
  isBlocked,
  preparedBatchOf,
  removeLink,
  describeCreate,
  describeRemove,
  runPreparedBatch,
  type LinkFailure,
  type LinkFailureCode,
  type LinkIntent,
  type LinkLedger,
} from "../links/link-engine.ts";
import type { JournalEntry, State } from "../../domain/state/state-schema.ts";
import type { StateCheckpointWriter } from "../../services/state-store.ts";
import type { Catalog } from "../../domain/sources/catalog-schema.ts";
import { docsSettingsFor } from "../../domain/state/state-intent.ts";
import {
  docsLink,
  docsResourceIdentity,
  docsRelativeTarget,
  managedDocsLinksOf,
  reportDocsManagedLink,
  storedDocsManagedLink,
  type DocsIssue,
  type DocsManagedLink,
  type DocsLinkAction,
  type DocsLinkApplication,
  type DocsLinkOutcome,
  type DocsRemovalAction,
  type ReportedDocsManagedLink,
} from "../../domain/docs/docs-schema.ts";
import { activeProjects } from "../projects/project.ts";
import { docsDestinationPath, findDocsEntry } from "./docs-resource.ts";

/** Limits docs reconciliation to one project; omitted, every project is reconciled. */
export type DocsLinkScope = {
  readonly projectName?: string;
};
export type { DocsLinkAction } from "../../domain/docs/docs-schema.ts";

/** Reports why a planned link's parents are unsafe, or undefined when they are ordinary directories. */
const planParentConflict = (evidence: DocsManagedLink) => {
  const link = docsLink(evidence);
  return deliveryKindOf(link)
    .parents(link, false)
    .pipe(
      Effect.map((verdict) =>
        verdict._tag === "unsafe" ? { code: verdict.code, message: verdict.message } : undefined,
      ),
    );
};

/**
 * Decides the removal of one recorded docs mount the way apply decides it, through the docs delivery
 * kind: unsafe parents, or a destination that is no longer Tack's link, is a conflict; a link Tack
 * owns, or nothing at all, is a removal.
 */
export const planDocsRemoval = Effect.fnUntraced(function* (
  evidence: DocsManagedLink,
): Effect.fn.Return<DocsRemovalAction, never, Destination | FileSystem.FileSystem | Path.Path> {
  const unsafe = yield* planParentConflict(evidence);
  const observed = yield* observeDestination(evidence.destinationPath);
  const claim = yield* classifyDestination(observed, docsLink(evidence));
  const reported = reportDocsManagedLink(evidence);
  if (unsafe !== undefined) return { action: "conflict", evidence: reported, ...unsafe };
  return claim === "absent" || isOwnedClaim(claim)
    ? { action: "remove", evidence: reported }
    : {
        action: "conflict",
        evidence: reported,
        code: "docs-destination-modified",
        message: "The recorded destination was changed; ownership does not authorize removing it.",
      };
});

/** Derives directory-link actions from the same registered catalog and persisted attachment intent. */
export const planDocsLinks = Effect.fnUntraced(function* (
  state: State,
  catalog: Catalog,
  scope: DocsLinkScope = {},
) {
  const path = yield* Path.Path;
  const desired: DocsManagedLink[] = [];
  const issues: DocsIssue[] = [];
  const keepUnavailable = new Set<string>();
  for (const projectIntent of state.data.projects) {
    const settings = docsSettingsFor(state, projectIntent.name);
    if (settings === undefined) continue;
    if (scope.projectName !== undefined && settings.projectName !== scope.projectName) continue;
    const project = activeProjects(state).find((entry) => entry.name === settings.projectName);
    if (project === undefined) continue;
    for (const resource of settings.attachments) {
      const entry = findDocsEntry(catalog, resource);
      for (const root of project.roots) {
        const destinationPath = docsDestinationPath(path, root, settings, resource);
        if (entry === undefined) {
          keepUnavailable.add(docsResourceIdentity(resource));
          continue;
        }
        desired.push({
          projectName: project.name,
          root,
          resource,
          destinationPath,
          sourceDirectoryPath: entry.directoryPath,
        });
      }
      if (entry === undefined)
        issues.push({
          code: "docs-resource-unavailable",
          message: `${resource.sourceRegistrationId}/${resource.name} is unavailable; its existing links are retained.`,
          subject: { resource },
        });
    }
  }
  const owned = managedDocsLinksOf(state.data.links).filter(
    (entry) => scope.projectName === undefined || scope.projectName === entry.projectName,
  );
  const actions: DocsLinkAction[] = [];
  for (const evidence of owned) {
    const wanted = desired.find(
      (entry) =>
        entry.destinationPath === evidence.destinationPath &&
        entry.sourceDirectoryPath === evidence.sourceDirectoryPath,
    );
    if (wanted !== undefined || keepUnavailable.has(docsResourceIdentity(evidence.resource)))
      continue;
    actions.push(yield* planDocsRemoval(evidence));
  }
  for (const evidence of desired) {
    const prior = owned.find((entry) => entry.destinationPath === evidence.destinationPath);
    const unsafe = yield* planParentConflict(evidence);
    const observed = yield* observeDestination(evidence.destinationPath);
    const claim = yield* classifyDestination(observed, docsLink(evidence));
    const replacing =
      prior !== undefined &&
      actions.some(
        (action) =>
          action.action === "remove" &&
          action.evidence.destinationPath === evidence.destinationPath,
      );
    actions.push(
      unsafe !== undefined
        ? { action: "conflict", evidence: reportDocsManagedLink(evidence), ...unsafe }
        : prior !== undefined &&
            prior.sourceDirectoryPath === evidence.sourceDirectoryPath &&
            isOwnedClaim(claim)
          ? { action: "keep", evidence: reportDocsManagedLink(evidence) }
          : claim === "absent" || replacing === true
            ? { action: "create", evidence: reportDocsManagedLink(evidence) }
            : {
                action: "conflict",
                evidence: reportDocsManagedLink(evidence),
                code: "docs-destination-occupied",
                message:
                  "Existing entries are not adopted or overwritten. Move the conflicting entry, then reconcile again.",
              },
    );
  }
  return {
    actions,
    issues,
    kind: "docs-reconciliation-plan" as const,
    complete: issues.length === 0 && actions.every((action) => action.action !== "conflict"),
  };
});

/** A planned action that changes a mount, as opposed to one that keeps it or reports a conflict. */
type ChangeAction = {
  readonly action: "create" | "remove";
  readonly evidence: ReportedDocsManagedLink;
};

const isChange = (action: DocsLinkAction): action is ChangeAction =>
  action.action === "create" || action.action === "remove";

const destinationChanged = "The destination changed after planning; retry reconciliation.";

/** The intents of docs actions: one for every link a plan creates or removes. */
const intentsOf = (plans: ReadonlyArray<{ readonly actions: ReadonlyArray<DocsLinkAction> }>) =>
  plans
    .flatMap((plan) => plan.actions)
    .flatMap((action): ReadonlyArray<LinkIntent> =>
      isChange(action)
        ? [{ _tag: action.action, link: docsLink(storedDocsManagedLink(action.evidence)) }]
        : [],
    );

/**
 * The journal entries for the docs plans of one apply: one for every destination they create,
 * replace or remove, exactly as agent links are prepared.
 */
export const docsPreparedBatchOf = (
  plans: ReadonlyArray<{ readonly actions: ReadonlyArray<DocsLinkAction> }>,
): ReadonlyArray<JournalEntry> => preparedBatchOf(intentsOf(plans));

/**
 * How docs reports each reason a planned mount change did not happen, where it publishes its own
 * code and sentence. Unsafe parents and filesystem failures keep the engine's code and message.
 */
export const docsChangeFailures = {
  "source-changed": {
    code: "docs-source-changed",
    message: "The docs directory changed after planning.",
  },
  "destination-occupied": { code: "docs-destination-changed", message: destinationChanged },
  "destination-not-owned": { code: "docs-destination-changed", message: destinationChanged },
  unverified: {
    code: "docs-verification-failed",
    message: "The docs mutation could not be verified; retry to recover.",
  },
} as const satisfies Record<
  Exclude<LinkFailureCode, "parents-unsafe" | "filesystem-failure">,
  { readonly code: string; readonly message: string }
>;

/** The outcome of a planned mount change, given how it failed if it did. */
const docsChangeOutcome = (
  action: ChangeAction,
  failure: LinkFailure | undefined,
): DocsLinkOutcome => {
  if (failure === undefined) return { _tag: "applied", action };
  if (failure.code === "parents-unsafe")
    return { _tag: "failed", action, code: failure.reason, message: failure.message };
  if (failure.code === "filesystem-failure")
    return { _tag: "failed", action, code: failure.code, message: failure.message };
  return { _tag: "failed", action, ...docsChangeFailures[failure.code] };
};

/** Applies one planned create or remove through the engine, reporting it in docs terms. */
const applyDocsLinkChange = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  action: ChangeAction,
): Effect.fn.Return<DocsLinkOutcome, never, Destination | FileSystem.FileSystem | Path.Path> {
  const evidence = storedDocsManagedLink(action.evidence);
  const link = docsLink(evidence);
  if (action.action === "create") {
    const result = yield* createLink(ledger, link, docsRelativeTarget(evidence));
    return docsChangeOutcome(action, describeCreate(result));
  }
  const failure = describeRemove(yield* removeLink(ledger, link));
  if (failure === undefined) conclude(ledger, link, "retire");
  else concludeUnchanged(ledger, link);
  return docsChangeOutcome(action, failure);
});

/**
 * Runs the actions of one docs plan, in plan order, against an apply's ledger. An action on a
 * destination an earlier apply left prepared is skipped: that entry blocks only its destination.
 */
export const applyDocsActions = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  plan: {
    readonly actions: ReadonlyArray<DocsLinkAction>;
    readonly issues: ReadonlyArray<DocsIssue>;
  },
): Effect.fn.Return<DocsLinkApplication, never, Destination | FileSystem.FileSystem | Path.Path> {
  const actions = yield* Effect.forEach(plan.actions, (action) =>
    Effect.gen(function* (): Effect.fn.Return<
      DocsLinkOutcome,
      never,
      Destination | FileSystem.FileSystem | Path.Path
    > {
      if (isBlocked(ledger, action.evidence))
        return { _tag: "skipped", action, reason: "recovery-pending" };
      if (action.action === "conflict")
        return { _tag: "blocked", action, code: action.code, message: action.message };
      return isChange(action)
        ? yield* applyDocsLinkChange(ledger, action)
        : { _tag: "applied", action };
    }),
  );
  return {
    actions,
    issues: plan.issues,
    kind: "docs-reconciliation-application" as const,
    complete: plan.issues.length === 0 && actions.every((action) => action._tag === "applied"),
  };
});

/** Applies exact planned docs links as one prepared batch (see `runPreparedBatch`). */
export const applyDocsPlan = Effect.fnUntraced(function* (
  writer: StateCheckpointWriter,
  plan: {
    readonly actions: ReadonlyArray<DocsLinkAction>;
    readonly issues: ReadonlyArray<DocsIssue>;
  },
) {
  return yield* runPreparedBatch(writer, docsPreparedBatchOf([plan]), (ledger) =>
    applyDocsActions(ledger, plan),
  );
});

/**
 * Removes the docs mounts a validated lifecycle removal plan names. The plan's batch already owes
 * every one of them, so a mount that cannot be removed safely keeps its obligation with the reason
 * and a later `clean` retries it, as for an agent link.
 */
export const removeDocsMounts = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  evidence: ReadonlyArray<ReportedDocsManagedLink>,
): Effect.fn.Return<
  ReadonlyArray<DocsLinkOutcome>,
  never,
  Destination | FileSystem.FileSystem | Path.Path
> {
  return yield* Effect.forEach(evidence, (reported) =>
    Effect.gen(function* (): Effect.fn.Return<
      DocsLinkOutcome,
      never,
      Destination | FileSystem.FileSystem | Path.Path
    > {
      const action: DocsLinkAction = { action: "remove", evidence: reported };
      const link = docsLink(storedDocsManagedLink(reported));
      if (isBlocked(ledger, link)) return { _tag: "skipped", action, reason: "recovery-pending" };
      const failure = describeRemove(yield* removeLink(ledger, link));
      if (failure === undefined) {
        concludeSettled(ledger, link);
        return { _tag: "applied", action };
      }
      concludeResult(ledger, link, { _tag: failure.conclusion, message: failure.message });
      if (failure.code === "filesystem-failure")
        return { _tag: "failed", action, code: failure.code, message: failure.message };
      return {
        _tag: "blocked",
        action,
        code: failure.code === "parents-unsafe" ? failure.reason : "docs-destination-modified",
        message: failure.message,
      };
    }),
  );
});
