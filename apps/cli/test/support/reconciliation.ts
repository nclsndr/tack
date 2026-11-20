import { Effect } from "effect";
import { withRecoveredWriter } from "../../src/features/writer/recovered-writer.ts";
import { applyReconciliationWithWriter } from "../../src/features/reconciliation/reconciliation-application.test-support.ts";
import { reconciliationApplicationCauses } from "../../src/features/reconciliation/partial-cause.ts";
import type { ReconcileCommandOptions } from "../../src/features/reconciliation/reconcile-command.ts";
import { runSyncCommand } from "../../src/features/reconciliation/sync-command.ts";
import type { ReconciliationPlan } from "../../src/domain/reconciliation/reconciliation-schema.ts";
import type { State } from "../../src/domain/state/state-schema.ts";
import type { StateOptions } from "../../src/services/state-store.ts";

/**
 * Runs `tack sync` without docs through the production `runSyncCommand` and returns its resource
 * half: the plan with its selection, the application when applied, and every partial cause, the
 * plan's and the failed link actions', as the sync route reports them.
 */
export const syncResources = (stateOptions: StateOptions, request: ReconcileCommandOptions) =>
  runSyncCommand(stateOptions, { ...request, noDocs: true }).pipe(
    Effect.flatMap(({ applied, plan }) => {
      const prepared = plan.resources;
      if (prepared === undefined)
        return Effect.die(new Error("syncResources needs at least one adapter"));
      const application = applied?.resources;
      const causes = [
        ...prepared.causes,
        ...(application === undefined ? [] : reconciliationApplicationCauses(application)),
      ];
      return Effect.succeed({
        ...(application === undefined ? {} : { application }),
        causes,
        partial: causes.length > 0,
        plan: { ...prepared.plan, selection: prepared.selection },
      });
    }),
  );

/**
 * Runs `tack sync --no-adapters` for one project through the production `runSyncCommand` and
 * returns its docs half: that project's docs plan, and its application when applied. A project
 * name selects that project; otherwise the cwd selects the project owning it, as a bare sync does.
 */
export const syncDocs = (
  stateOptions: StateOptions,
  request: { readonly projectName?: string; readonly cwd?: string; readonly apply: boolean },
) =>
  runSyncCommand(stateOptions, {
    adapterOverride: [],
    apply: request.apply,
    cwd: request.cwd ?? ".",
    includeOptional: false,
    noDocs: false,
    selector:
      request.projectName === undefined
        ? { _tag: "bare" }
        : { _tag: "project", projectName: request.projectName },
  }).pipe(
    Effect.flatMap(({ applied, plan }) => {
      const [docs, ...others] = plan.docs;
      if (docs === undefined || others.length > 0)
        return Effect.die(new Error("syncDocs needs exactly one project with docs to plan"));
      const application = applied?.docs[0];
      return Effect.succeed({
        plan: docs,
        ...(application === undefined ? {} : { applied: application }),
      });
    }),
  );

/**
 * Applies a hand-built plan under the recovered writer, the way a workflow applies the plan it just
 * built. Use it only when no journal is pending, so recovery leaves the plan's state unchanged.
 */
export const applyReconciliationPlan = (stateOptions: StateOptions, plan: ReconciliationPlan) =>
  withRecoveredWriter(stateOptions, (writer) => applyReconciliationWithWriter(writer, plan));

/** Recovers journals, plans from the recovered state, and applies that plan in one locked session. */
export const planAndApplyReconciliation = <E, R>(
  stateOptions: StateOptions,
  plan: (state: State) => Effect.Effect<ReconciliationPlan, E, R>,
) =>
  withRecoveredWriter(stateOptions, (writer) =>
    plan(writer.current()).pipe(
      Effect.flatMap((planned) => applyReconciliationWithWriter(writer, planned)),
    ),
  );
