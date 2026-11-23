import { Effect } from "effect";
import {
  docsPendingRemovalsOf,
  type DocsLinkApplication,
  type DocsLinkPlan,
  type DocsPendingRemoval,
} from "../../domain/docs/docs-schema.ts";
import { applyDocsActions, docsPreparedBatchOf, planDocsLinks } from "../docs/docs-links.ts";
import { previewOrApply } from "../writer/recovered-writer.ts";
import type { StateCheckpointWriter, StateOptions } from "../../services/state-store.ts";
import type { CommandSnapshot } from "../snapshot/command-snapshot.ts";
import {
  applyReconciliationUnits,
  preparedBatchOfPlan,
  reconciliationResultOf,
} from "./reconciliation-application.ts";
import { runPreparedBatch } from "../links/link-engine.ts";
import type { ReconciliationApplyResult } from "../../domain/reconciliation/reconciliation-application-schema.ts";
import {
  prepareReconciliation,
  type PreparedReconciliation,
  type ReconcileCommandOptions,
} from "./reconcile-command.ts";

/** The resource and docs plans one sync computes from a single state snapshot. */
export type SyncPlan = {
  readonly resources?: PreparedReconciliation;
  readonly docs: ReadonlyArray<DocsLinkPlan>;
  /** The docs mounts of the synced projects whose removal is owed when the plan was made. */
  readonly docsPending: ReadonlyArray<DocsPendingRemoval>;
};

/** What applying a sync plan did to agent links and to each project's docs mounts. */
export type SyncApplication = {
  readonly resources: ReconciliationApplyResult | undefined;
  readonly docs: ReadonlyArray<DocsLinkApplication>;
  /** The docs mounts whose removal is still owed; a sync reports what its plan found. */
  readonly docsPending: ReadonlyArray<DocsPendingRemoval>;
};

/** The owed docs removals of the projects a sync covers, none when docs are left out. */
const docsPendingOf = (
  links: Parameters<typeof docsPendingRemovalsOf>[0],
  projectNames: ReadonlyArray<string>,
  noDocs: boolean,
) =>
  noDocs
    ? []
    : docsPendingRemovalsOf(links).filter((pending) =>
        projectNames.includes(pending.evidence.projectName),
      );

/** Plans selected resources and attached docs against the supplied state without writing. */
export const planSync = (
  stateOptions: StateOptions,
  options: ReconcileCommandOptions & { readonly noDocs: boolean },
  snapshot: CommandSnapshot,
) =>
  Effect.gen(function* () {
    const prepared = yield* prepareReconciliation(stateOptions, options, snapshot);
    const docs = options.noDocs
      ? []
      : yield* Effect.forEach(
          prepared.projectNames.filter(
            (projectName) =>
              prepared.causes.some(
                (cause) =>
                  cause.code === "profile-inventory-unresolved" &&
                  cause.subject.namespace["_tag"] === "project" &&
                  cause.subject.namespace.projectName === projectName,
              ) === false,
          ),
          (projectName) =>
            Effect.flatMap(snapshot.catalog, (catalog) =>
              planDocsLinks(snapshot.state, catalog, { projectName }),
            ),
        );
    return {
      ...(options.adapterOverride?.length === 0 ? {} : { resources: prepared }),
      docs,
      docsPending: docsPendingOf(snapshot.state.data.links, prepared.projectNames, options.noDocs),
    } satisfies SyncPlan;
  });

/** Plans selected resources and attached docs from one snapshot, then applies under one writer. */
export const runSyncCommand = Effect.fn("reconciliation.runSyncCommand")(function* (
  stateOptions: StateOptions,
  options: ReconcileCommandOptions & { readonly noDocs: boolean },
) {
  return yield* previewOrApply(stateOptions, {
    apply: options.apply,
    plan: (snapshot) => planSync(stateOptions, options, snapshot),
    // Agent links first, then docs, as one prepared batch: one write to prepare it and one to settle it.
    applyPlan: applySyncPlan,
  });
});

/** Applies a sync plan through the shared prepared-batch writer. */
export const applySyncPlan = (writer: StateCheckpointWriter, plan: SyncPlan) =>
  runPreparedBatch(
    writer,
    [
      ...(plan.resources === undefined ? [] : preparedBatchOfPlan(plan.resources.plan)),
      ...docsPreparedBatchOf(plan.docs),
    ],
    (ledger) =>
      Effect.gen(function* () {
        const resources =
          plan.resources === undefined
            ? undefined
            : reconciliationResultOf(
                plan.resources.plan,
                yield* applyReconciliationUnits(ledger, plan.resources.plan),
              );
        const docs: DocsLinkApplication[] = [];
        for (const entry of plan.docs) docs.push(yield* applyDocsActions(ledger, entry));
        // A sync never owes or settles a removal, so what it reports is what the plan found.
        return { resources, docs, docsPending: plan.docsPending } satisfies SyncApplication;
      }),
  );
