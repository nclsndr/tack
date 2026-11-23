import { agentLink } from "../../domain/links/link-record-schema.ts";
import { Effect, FileSystem, Path, PlatformError } from "effect";
import {
  destinationObservationMessage,
  ownsObservedLink,
} from "../links/managed-link-ownership.ts";
import { Destination, observeDestination } from "../../services/destination.ts";
import { type DestinationObservation } from "../../domain/reconciliation/destination-observation-schema.ts";
import {
  adoptLink,
  conclude,
  concludeUnchanged,
  createLink,
  describeAdopt,
  isBlocked,
  preparedBatchOf,
  removeLink,
  describeCreate,
  describeRemove,
  type LinkFailure,
  type LinkFailureCode,
  type LinkIntent,
  type LinkLedger,
} from "../links/link-engine.ts";
import type {
  ReconciliationAction,
  ReconciliationPlan,
  ReconciliationUnitPlan,
} from "../../domain/reconciliation/reconciliation-schema.ts";
import {
  type ReconciliationActionFailureCode,
  type ReconciliationActionOutcome,
  type ReconciliationApplyResult,
  type ReconciliationUnitOutcome,
} from "../../domain/reconciliation/reconciliation-application-schema.ts";

type FileSystemAttempt<A> =
  | { readonly _tag: "success"; readonly value: A }
  | { readonly _tag: "failure"; readonly error: PlatformError.PlatformError };

const attemptFileSystem = <A>(effect: Effect.Effect<A, PlatformError.PlatformError>) =>
  effect.pipe(
    Effect.map((value): FileSystemAttempt<A> => ({ _tag: "success", value })),
    Effect.catch((error) => Effect.succeed({ _tag: "failure", error } as const)),
  );

const actionPath = (action: ReconciliationAction) =>
  action._tag === "directory-create" ? action.directoryPath : action.destinationPath;

/** The link actions of a plan, as the engine's intents. */
const intentsOf = (plan: ReconciliationPlan): ReadonlyArray<LinkIntent> =>
  plan.units
    .flatMap((unit) => unit.actions)
    .flatMap((action): ReadonlyArray<LinkIntent> => {
      if (action._tag === "link-remove")
        return [{ _tag: "remove", link: agentLink(action.evidence) }];
      // An adoption is journaled as a creation: recovery records it once the link it names is there.
      if (action._tag === "link-adopt")
        return [{ _tag: "create", link: agentLink(action.evidence) }];
      return action._tag === "link-create"
        ? [
            {
              _tag: "create",
              link: agentLink(action.evidence),
              previous:
                action.previousEvidence === undefined
                  ? undefined
                  : agentLink(action.previousEvidence),
            },
          ]
        : [];
    });

/** The journal entries recovery needs for a whole plan: one for every destination it changes. */
export const preparedBatchOfPlan = (plan: ReconciliationPlan) => preparedBatchOf(intentsOf(plan));

const failureCodeForObservation = (
  observation: DestinationObservation,
): ReconciliationActionFailureCode =>
  observation._tag === "entry" && observation.entryType === "directory"
    ? "destination-directory-conflict"
    : "destination-conflict";

const failedOutcome = (
  action: ReconciliationAction,
  observation: DestinationObservation,
): ReconciliationActionOutcome => ({
  _tag: "failed",
  action,
  code: failureCodeForObservation(observation),
  message: destinationObservationMessage(observation),
  path: actionPath(action),
});

const failedFilesystemOutcome = (
  action: ReconciliationAction,
  error: PlatformError.PlatformError,
): ReconciliationActionOutcome => ({
  _tag: "failed",
  action,
  code: "filesystem-failure",
  message: error.message,
  path: actionPath(action),
});

const applyDirectoryCreate = Effect.fnUntraced(function* (
  action: Extract<ReconciliationAction, { readonly _tag: "directory-create" }>,
): Effect.fn.Return<
  ReconciliationActionOutcome,
  never,
  Destination | FileSystem.FileSystem | Path.Path
> {
  const observation = yield* observeDestination(action.directoryPath);
  if (observation._tag === "entry" && observation.entryType === "directory") {
    return { _tag: "applied", action };
  }
  if (observation._tag !== "absent") {
    return failedOutcome(action, observation);
  }

  // A directory records nothing in state, so creating one is never journaled.
  const created = yield* attemptFileSystem(
    (yield* FileSystem.FileSystem).makeDirectory(action.directoryPath, { recursive: true }),
  );
  if (created._tag === "failure") {
    const afterFailure = yield* observeDestination(action.directoryPath);
    if (afterFailure._tag === "entry" && afterFailure.entryType === "directory") {
      return { _tag: "applied", action };
    }
    return failedFilesystemOutcome(action, created.error);
  }

  const verified = yield* observeDestination(action.directoryPath);
  if (verified._tag === "entry" && verified.entryType === "directory") {
    return { _tag: "applied", action };
  }
  return failedOutcome(action, verified);
});

/**
 * The code reconciliation publishes for each reason a link action did not happen. A reason that
 * observed the destination publishes the directory conflict instead when a directory is in the way.
 */
export const reconciliationLinkFailureCodes = {
  "parents-unsafe": "destination-conflict",
  "source-changed": "destination-conflict",
  "destination-occupied": "destination-conflict",
  "destination-not-owned": "destination-conflict",
  unverified: "destination-conflict",
  "filesystem-failure": "filesystem-failure",
} as const satisfies Record<LinkFailureCode, ReconciliationActionFailureCode>;

/** The outcome of a link action, given how it failed if it did. */
const linkOutcome = (
  action: Extract<
    ReconciliationAction,
    { readonly _tag: "link-adopt" | "link-create" | "link-remove" }
  >,
  failure: LinkFailure | undefined,
): ReconciliationActionOutcome =>
  failure === undefined
    ? { _tag: "applied", action }
    : {
        _tag: "failed",
        action,
        code:
          "observation" in failure
            ? failureCodeForObservation(failure.observation)
            : reconciliationLinkFailureCodes[failure.code],
        message: failure.message,
        path:
          failure.code === "source-changed"
            ? action.evidence.sourceDirectoryPath
            : action.destinationPath,
      };

const applyLinkCreate = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  action: Extract<ReconciliationAction, { readonly _tag: "link-create" }>,
): Effect.fn.Return<
  ReconciliationActionOutcome,
  never,
  Destination | FileSystem.FileSystem | Path.Path
> {
  const result = yield* createLink(ledger, agentLink(action.evidence), action.relativeTarget);
  return linkOutcome(action, describeCreate(result));
});

const applyLinkAdopt = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  action: Extract<ReconciliationAction, { readonly _tag: "link-adopt" }>,
): Effect.fn.Return<
  ReconciliationActionOutcome,
  never,
  Destination | FileSystem.FileSystem | Path.Path
> {
  const result = yield* adoptLink(ledger, agentLink(action.evidence), action.relativeTarget);
  return linkOutcome(action, describeAdopt(result));
});

const applyLinkRemove = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  action: Extract<ReconciliationAction, { readonly _tag: "link-remove" }>,
): Effect.fn.Return<
  ReconciliationActionOutcome,
  never,
  Destination | FileSystem.FileSystem | Path.Path
> {
  const link = agentLink(action.evidence);
  const failure = describeRemove(yield* removeLink(ledger, link));
  if (failure === undefined) conclude(ledger, link, "retire");
  else concludeUnchanged(ledger, link);
  return linkOutcome(action, failure);
});

/**
 * Whether a retirement may still forget its record: an absent link always may, and a released one
 * may while the destination stays something other than the link Tack owns.
 */
const retirementHolds = Effect.fnUntraced(function* (
  action: Extract<ReconciliationAction, { readonly _tag: "evidence-retire" }>,
  observation: DestinationObservation,
) {
  if (observation._tag === "absent") return true;
  if (action.reason === "absent" || observation._tag === "access-failed") return false;
  return (yield* ownsObservedLink(observation, action.evidence)) === false;
});

const applyEvidenceRetire = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  action: Extract<ReconciliationAction, { readonly _tag: "evidence-retire" }>,
): Effect.fn.Return<ReconciliationActionOutcome, never, Destination | Path.Path> {
  const observation = yield* observeDestination(action.destinationPath);
  if ((yield* retirementHolds(action, observation)) === false) {
    return failedOutcome(action, observation);
  }
  // Nothing was prepared: the link is gone or not Tack's, and the settle step ends its evidence.
  ledger.changes.push({ _tag: "unmanage", link: agentLink(action.evidence) });
  return { _tag: "applied", action };
});

const applyAction = (
  ledger: LinkLedger,
  action: ReconciliationAction,
): Effect.Effect<
  ReconciliationActionOutcome,
  never,
  Destination | FileSystem.FileSystem | Path.Path
> => {
  if (action._tag === "directory-create") {
    return applyDirectoryCreate(action);
  }
  if (isBlocked(ledger, action)) {
    // An earlier apply left this destination prepared; it blocks this destination and no other.
    return Effect.succeed({
      _tag: "skipped",
      action,
      reason: "An interrupted change to this destination is awaiting recovery.",
    });
  }
  if (action._tag === "link-create") {
    return applyLinkCreate(ledger, action);
  }
  if (action._tag === "link-remove") {
    return applyLinkRemove(ledger, action);
  }
  if (action._tag === "link-adopt") {
    return applyLinkAdopt(ledger, action);
  }
  return applyEvidenceRetire(ledger, action);
};

const unitStatus = (
  unit: ReconciliationUnitPlan,
  outcomes: ReadonlyArray<ReconciliationActionOutcome>,
): ReconciliationUnitOutcome["status"] => {
  if (unit.capability?._tag === "blocked") {
    return "blocked";
  }
  const hasUnresolvedPlanIssue = unit.conflicts.length > 0 || unit.collisions.length > 0;
  if (outcomes.length === 0) {
    return hasUnresolvedPlanIssue === false ? "success" : "partial";
  }
  const failures = outcomes.filter((outcome) => outcome._tag === "failed").length;
  const applied = outcomes.filter((outcome) => outcome._tag === "applied").length;
  if (failures === 0 && hasUnresolvedPlanIssue === false) {
    return "success";
  }
  return failures > 0 && applied === 0 && hasUnresolvedPlanIssue === false ? "failed" : "partial";
};

const applyUnit = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  unit: ReconciliationUnitPlan,
): Effect.fn.Return<
  ReconciliationUnitOutcome,
  never,
  Destination | FileSystem.FileSystem | Path.Path
> {
  const outcomes: Array<ReconciliationActionOutcome> = [];
  const path = yield* Path.Path;
  const failedDirectories = new Set<string>();
  const failedRemovalPaths = new Set<string>();
  for (const action of unit.actions) {
    if (
      (failedDirectories.has(path.dirname(actionPath(action))) ||
        failedRemovalPaths.has(actionPath(action))) &&
      action._tag === "link-create"
    ) {
      outcomes.push({
        _tag: "skipped",
        action,
        reason: failedDirectories.has(path.dirname(actionPath(action)))
          ? "The resource directory was not created."
          : "The managed link was not removed, so replacement was skipped.",
      });
    } else {
      const outcome = yield* applyAction(ledger, action);
      outcomes.push(outcome);
      if (action._tag === "directory-create" && outcome._tag === "failed") {
        failedDirectories.add(action.directoryPath);
      }
      if (action._tag === "link-remove" && outcome._tag === "failed") {
        failedRemovalPaths.add(action.destinationPath);
      }
    }
  }
  return {
    actions: outcomes,
    adapter: unit.adapter,
    status: unitStatus(unit, outcomes),
    target: unit.target,
  };
});

/** Runs the actions of every unit of a plan, in plan order, against an apply's ledger. */
export const applyReconciliationUnits = (ledger: LinkLedger, plan: ReconciliationPlan) =>
  Effect.forEach(plan.units, (unit) => applyUnit(ledger, unit));

/** The result a plan's applied units make. */
export const reconciliationResultOf = (
  plan: ReconciliationPlan,
  units: ReadonlyArray<ReconciliationUnitOutcome>,
) =>
  ({
    kind: "skill-reconciliation-application",
    units,
    version: plan.version,
  }) satisfies ReconciliationApplyResult;

export type {
  ReconciliationApplyResult,
  ReconciliationUnitOutcome,
} from "../../domain/reconciliation/reconciliation-application-schema.ts";
export { ReconciliationApplyResultSchema } from "../../domain/reconciliation/reconciliation-application-schema.ts";
