import { Effect } from "effect";
import {
  cleanManagedLinks,
  resetTack,
  retrySelectedPendingRemovals,
} from "../../../features/removal/selected-removal.ts";
import type { RemovalExecution } from "../../../features/removal/removal.ts";
import { removalOutcome, withOutsidePendingDiagnostic } from "../outcomes.ts";
import { cwdOrCurrent, type RoutesFor, onlyUserOrAllSelector } from "./route.ts";

const cleanupOutcome = (execution: RemovalExecution) =>
  removalOutcome(execution, {
    planned: [execution.plan],
    applied: execution.applied === undefined ? undefined : [execution.applied],
  });

/** Selected cleanup, its pending-only retry, and the full reset. */
export const stateRoutes: RoutesFor<"state-clean" | "state-reset" | "state-clean-pending"> = {
  "state-clean": {
    needsHome: onlyUserOrAllSelector,
    run: (invocation, stateOptions) =>
      cwdOrCurrent(invocation.cwd).pipe(
        Effect.flatMap((cwd) =>
          cleanManagedLinks(stateOptions, {
            apply: invocation.apply,
            cwd,
            selector: invocation.selector,
          }),
        ),
        Effect.map(cleanupOutcome),
      ),
  },
  "state-clean-pending": {
    needsHome: onlyUserOrAllSelector,
    run: (invocation, stateOptions) =>
      cwdOrCurrent(invocation.cwd).pipe(
        Effect.flatMap((cwd) =>
          retrySelectedPendingRemovals(stateOptions, {
            apply: invocation.apply,
            cwd,
            selector: invocation.selector,
          }),
        ),
        // The retry reports pending removals outside its selection from the document it planned on.
        Effect.map((execution) =>
          withOutsidePendingDiagnostic(
            cleanupOutcome(execution),
            execution.state,
            execution.plan.selection,
          ),
        ),
      ),
  },
  "state-reset": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      resetTack(stateOptions, { apply: invocation.apply }).pipe(Effect.map(cleanupOutcome)),
  },
};
