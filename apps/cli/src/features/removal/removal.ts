import { Effect } from "effect";

import type { StateOptions } from "../../services/state-store.ts";
import type { PreviewOrApplied } from "../../domain/plan-and-apply.ts";
import { previewOrApply } from "../writer/recovered-writer.ts";
import { applyRemovalWithWriter } from "./removal-apply.ts";
import { planRemoval } from "./removal-plan.ts";
import type {
  RemovalPlan,
  RemovalRequest,
  RemovalResult,
} from "../../domain/reconciliation/removal-schema.ts";

/** One removal plan and, after an explicit apply, its result. */
export type RemovalExecution = PreviewOrApplied<RemovalPlan, RemovalResult>;

/** Plans a cleanup scope, or plans it from recovered state and applies it under one lock. */
export const runManagedRemoval = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  request: RemovalRequest,
  apply: boolean,
) {
  const execution: RemovalExecution = yield* previewOrApply(stateOptions, {
    apply,
    plan: ({ state }) => planRemoval(state, request),
    applyPlan: (writer, plan) => applyRemovalWithWriter(writer, plan),
  });
  return execution;
});
