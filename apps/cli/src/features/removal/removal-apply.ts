import { Effect, FileSystem, Path } from "effect";
import { emptyState, type State } from "../../domain/state/state-schema.ts";
import {
  type StateCheckpointWriter,
  type StatePersistenceError,
} from "../../services/state-store.ts";
import {
  agentLink,
  applyLinkChanges,
  onlyOwedRemovals,
  type LinkChange,
} from "../../domain/links/link-record-schema.ts";
import type { JournalEntry } from "../../domain/state/state-schema.ts";
import {
  reportPendingRemoval,
  type PendingRemovalLastResult,
} from "../../domain/links/pending-removal-schema.ts";
import { removeDocsMounts } from "../docs/docs-links.ts";
import {
  docsLink,
  docsPendingRemovalsOf,
  storedDocsManagedLink,
} from "../../domain/docs/docs-schema.ts";
import {
  finalizeHandoffs,
  finalizeRoot,
  handOffProject,
  handOffRoot,
  removeProject,
} from "../../domain/state/project-lifecycle.ts";
import { Destination, observeDestination } from "../../services/destination.ts";
import {
  concludeResult,
  concludeSettled,
  describeRemove,
  isBlocked,
  removeLink,
  runPreparedBatch,
  type LinkLedger,
  type PreparedBatchExtension,
} from "../links/link-engine.ts";
import { destinationObservationMessage } from "../links/managed-link-ownership.ts";
import {
  causeForRemovalEvidence,
  pendingInRemovalScope,
  statePendingRemovals,
  stateProjects,
} from "./removal-plan.ts";
import type {
  RemovalAction,
  RemovalActionOutcome,
  RemovalPlan,
  RemovalResult,
  RemovalScope,
} from "../../domain/reconciliation/removal-schema.ts";

// State transitions

/**
 * The docs mounts a plan removes, a conflict included: apply owes each one and re-proves ownership
 * before it unlinks, as it does for a blocked agent link.
 */
const docsEvidenceOf = (plan: RemovalPlan) =>
  (plan.docsActions ?? []).map((action) => action.evidence);

/** Owes a removal for every planned destination, keeping the stronger cause of any removal already owed. */
const seedPendingWithPath = (state: State, plan: RemovalPlan): State => {
  const links = applyLinkChanges(state.data.links, [
    ...plan.actions.map((action): LinkChange => ({
      _tag: "owe",
      link: agentLink(action.evidence),
      cause: causeForRemovalEvidence(state, action.evidence.target, plan.cause),
    })),
    ...docsEvidenceOf(plan).map((evidence): LinkChange => {
      const link = docsLink(storedDocsManagedLink(evidence));
      return { _tag: "owe", link, cause: causeForRemovalEvidence(state, link.target, plan.cause) };
    }),
  ]);
  return links.some((record) => record.removal !== undefined)
    ? { ...state, data: { ...state.data, links } }
    : state;
};

const transitionProjectForRemoval = (state: State, plan: RemovalPlan): State => {
  if (plan.scope._tag === "project") return handOffProject(state, plan.scope.projectName);
  if (plan.scope._tag !== "project-root") return state;
  return handOffRoot(state, plan.scope.projectName, plan.scope.canonicalRoot, {
    requestProjectRemoval: plan.finalizeProject,
  });
};

/** Seeds durable evidence and applies the owning lifecycle transition before filesystem mutation. */
export const prepareRemovalState = (state: State, plan: RemovalPlan): State => {
  const seeded = seedPendingWithPath(state, plan);
  if (plan.scope._tag !== "reset") return transitionProjectForRemoval(seeded, plan);
  return {
    data: { ...emptyState().data, links: onlyOwedRemovals(seeded.data.links) },
    format: seeded.format,
  };
};

/** Finalizes projects whose selected cleanup obligations have all settled. */
const finalizeRemovalScope = (state: State, plan: RemovalPlan): State => {
  if (
    plan.scope._tag === "selected-targets" ||
    plan.scope._tag === "reset" ||
    plan.scope._tag === "adapter" ||
    plan.scope._tag === "source"
  ) {
    return state;
  }
  if (plan.scope._tag === "maintenance") return finalizeHandoffs(state);
  if (plan.scope._tag === "retry-targets") {
    return finalizeHandoffs(
      state,
      new Set(
        plan.scope.targets.flatMap((target) =>
          target._tag === "project-root" ? [target.projectName] : [],
        ),
      ),
    );
  }
  const scope = plan.scope;
  const cleanupScope: RemovalScope =
    plan.finalizeProject && scope._tag === "project-root"
      ? { _tag: "project", projectName: scope.projectName }
      : scope;
  const unresolved = statePendingRemovals(state).some((pending) =>
    pendingInRemovalScope(state, pending, cleanupScope),
  );
  if (unresolved === true) return state;
  return scope._tag === "project"
    ? removeProject(state, scope.projectName)
    : finalizeRoot(state, scope.projectName, scope.canonicalRoot);
};

/** Finalizes the scope of a settled plan, and tells whether that removed a project. */
const settledRemovalState = (state: State, plan: RemovalPlan) => {
  const next = finalizeRemovalScope(state, plan);
  const nextNames = new Set(stateProjects(next).map((project) => project.name));
  return {
    removedProject: stateProjects(state).some((project) => !nextNames.has(project.name)),
    state: next,
  };
};

/** Checks whether reset has reduced state to link records that only owe a removal. */
export const isMinimalRecoveryState = (state: State) => {
  const data = state.data;
  return (
    data.enabledAdapters.length === 0 &&
    data.sources.length === 0 &&
    data.projects.length === 0 &&
    data.userChoices.length === 0 &&
    data.journal === undefined &&
    data.links.length > 0 &&
    data.links.every((record) => record.pendingOnly === true)
  );
};

// Application

/** Records that an action settled its destination: the record and its removal are deleted. */
const concludeActionSettled = (ledger: LinkLedger, action: RemovalAction) =>
  concludeSettled(ledger, agentLink(action.evidence));

/** Records the result of an attempt that left its destination in place. */
const concludeActionResult = (
  ledger: LinkLedger,
  action: RemovalAction,
  lastResult: PendingRemovalLastResult,
) => concludeResult(ledger, agentLink(action.evidence), lastResult);

const attemptRemove = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  action: Extract<RemovalAction, { readonly _tag: "remove" }>,
): Effect.fn.Return<RemovalActionOutcome, never, Destination | FileSystem.FileSystem | Path.Path> {
  // The recovery intent was already checkpointed with the batch. No state I/O may occur between
  // observing a matching link and unlinking that exact destination.
  const failure = describeRemove(yield* removeLink(ledger, agentLink(action.evidence)));
  if (failure === undefined) {
    concludeActionSettled(ledger, action);
    return { _tag: "applied", action };
  }
  concludeActionResult(ledger, action, { _tag: failure.conclusion, message: failure.message });
  return failure.code === "filesystem-failure"
    ? { _tag: "failed", action, code: failure.code, message: failure.message }
    : { _tag: "skipped", action, reason: failure.message };
});

const applyRemovalAction = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  action: RemovalAction,
): Effect.fn.Return<RemovalActionOutcome, never, Destination | FileSystem.FileSystem | Path.Path> {
  if (action._tag === "blocked") {
    concludeActionResult(ledger, action, { _tag: "blocked", message: action.message });
    return { _tag: "skipped", action, reason: action.message };
  }
  if (isBlocked(ledger, action)) {
    // An earlier apply left this destination prepared; its obligation stays owed.
    const reason = "An interrupted change to this destination is awaiting recovery.";
    return { _tag: "skipped", action, reason };
  }
  if (action._tag === "retire") {
    const observation = yield* observeDestination(action.destinationPath);
    if (observation._tag !== "absent") {
      const message = destinationObservationMessage(observation);
      concludeActionResult(ledger, action, { _tag: "blocked", message });
      return { _tag: "skipped", action, reason: message };
    }
    concludeActionSettled(ledger, action);
    return { _tag: "applied", action };
  }
  return yield* attemptRemove(ledger, action);
});

/** The journal entries for the unlinks of a plan: one for every agent and docs link it removes. */
const removalBatchOf = (plan: RemovalPlan): ReadonlyArray<JournalEntry> => [
  ...plan.actions.flatMap((action): JournalEntry[] =>
    action._tag === "remove" ? [{ _tag: "remove", link: agentLink(action.evidence) }] : [],
  ),
  ...docsEvidenceOf(plan).map((evidence): JournalEntry => ({
    _tag: "remove",
    link: docsLink(storedDocsManagedLink(evidence)),
  })),
];

/**
 * Applies a removal plan built from `writer.current()` under this same writer lock, after the
 * caller recovered the journal, as one prepared batch (see `runPreparedBatch`). The state is
 * written twice at most, whatever the plan holds:
 *
 * 1. **Prepare.** One checkpoint seeds every obligation, agent links and docs mounts alike, and
 *    the lifecycle transition, and journals every unlink. Reset and a retry of a state that holds
 *    only obligations journal nothing, because that state is its own recovery record.
 * 2. **Act.** Agent links are removed in plan order, then docs mounts. Each re-proves ownership
 *    right before it unlinks. A link that cannot be removed safely keeps its obligation.
 * 3. **Settle.** One checkpoint records every result, finalizes the scope the plan names and clears
 *    the journal, deciding an unlink that did not run or did not finish by observation as recovery
 *    does. It runs when the actions end however they end. A terminal cleanup that leaves nothing
 *    owed deletes the state document instead of writing it.
 */
export const applyRemovalWithWriter = Effect.fnUntraced(function* (
  writer: StateCheckpointWriter,
  plan: RemovalPlan,
  transitionState: (state: State) => State = (state) => state,
): Effect.fn.Return<
  RemovalResult,
  StatePersistenceError,
  Destination | FileSystem.FileSystem | Path.Path
> {
  const prepare = (state: State) => prepareRemovalState(transitionState(state), plan);
  const terminalCleanup =
    plan.scope._tag === "reset" ||
    (plan.scope._tag === "retry-targets" && isMinimalRecoveryState(prepare(writer.current())));
  let finalized = false;
  const extension: PreparedBatchExtension = {
    prepare,
    // An unlink that was still running when the apply ended may or may not have happened.
    changes: (ledger) =>
      [...ledger.inFlight.values()].map((link): LinkChange => ({
        _tag: "result",
        link,
        lastResult: { _tag: "interrupted", message: "Cleanup was interrupted." },
      })),
    // Finalizes the scope the plan names; a terminal cleanup that leaves nothing owed deletes the
    // state document instead of writing it.
    settle: Effect.fnUntraced(function* (settled: State) {
      const { removedProject, state } = settledRemovalState(settled, plan);
      if (
        terminalCleanup &&
        statePendingRemovals(state).length === 0 &&
        docsPendingRemovalsOf(state.data.links).length === 0
      ) {
        yield* writer.deleteState();
      } else {
        finalized = yield* writer.checkpoint(() =>
          Effect.succeed({ state, value: removedProject }),
        );
      }
    }),
  };
  const { actions, docsActions } = yield* runPreparedBatch(
    writer,
    terminalCleanup ? [] : removalBatchOf(plan),
    (ledger) =>
      Effect.gen(function* () {
        const agent = yield* Effect.forEach(plan.actions, (action) =>
          applyRemovalAction(ledger, action),
        );
        const docs = yield* removeDocsMounts(ledger, docsEvidenceOf(plan));
        return { actions: agent, docsActions: docs };
      }),
    extension,
  );
  const docsPendingRemovals = writer.stateExists()
    ? docsPendingRemovalsOf(writer.current().data.links)
    : [];
  return {
    actions,
    ...(docsActions.length === 0 ? {} : { docsActions }),
    ...(docsPendingRemovals.length === 0 ? {} : { docsPendingRemovals }),
    finalizedProject: finalized,
    kind: "managed-removal-application" as const,
    pendingRemovals: writer.stateExists()
      ? statePendingRemovals(writer.current()).map((pending) => reportPendingRemoval(pending))
      : [],
    version: 1 as const,
  } satisfies RemovalResult;
});
