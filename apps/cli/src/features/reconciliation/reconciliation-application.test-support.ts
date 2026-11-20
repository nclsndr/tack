import { Effect, FileSystem, Path } from "effect";
import type { ReconciliationPlan } from "../../domain/reconciliation/reconciliation-schema.ts";
import type { Destination } from "../../services/destination.ts";
import type { StateCheckpointWriter, StatePersistenceError } from "../../services/state-store.ts";
import { runPreparedBatch } from "../links/link-engine.ts";
import {
  applyReconciliationUnits,
  preparedBatchOfPlan,
  reconciliationResultOf,
  type ReconciliationApplyResult,
} from "./reconciliation-application.ts";

/**
 * Applies a plan built from `writer.current()` under this same writer lock, after the caller
 * recovered the prepared journal, as one prepared batch (see `runPreparedBatch`). Sync applies
 * agent links and docs mounts in one batch (`runSyncCommand`); tests apply agent links alone.
 */
export const applyReconciliationWithWriter = Effect.fnUntraced(function* (
  writer: StateCheckpointWriter,
  plan: ReconciliationPlan,
): Effect.fn.Return<
  ReconciliationApplyResult,
  StatePersistenceError,
  Destination | FileSystem.FileSystem | Path.Path
> {
  const units = yield* runPreparedBatch(writer, preparedBatchOfPlan(plan), (ledger) =>
    applyReconciliationUnits(ledger, plan),
  );
  return reconciliationResultOf(plan, units);
});
