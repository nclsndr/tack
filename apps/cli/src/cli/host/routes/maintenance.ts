import { Effect } from "effect";
import {
  cleanManagedLinks,
  resetTack,
  retrySelectedPendingRemovals,
} from "../../../features/maintenance/selected-removal.ts";
import type { RemovalExecution } from "../../../features/removal/removal.ts";
import { readInvocationSnapshot } from "../../../features/snapshot/command-snapshot.ts";
import { statusFromSnapshot } from "../../../features/status/status.ts";
import {
  removalOutcome,
  statusOutcome,
  withOutsidePendingDiagnostic,
  withUnregisteredWorktree,
} from "../outcomes.ts";
import { observeCheckout } from "../../../features/projects/checkout.ts";
import { cwdOrCurrent, type RoutesFor, onlyUserOrAllSelector } from "./route.ts";

const cleanupOutcome = (execution: RemovalExecution) =>
  removalOutcome(execution, {
    planned: [execution.plan],
    applied: execution.applied === undefined ? undefined : [execution.applied],
  });

/** Read-only status and selected cleanup, retry and reset. */
export const maintenanceRoutes: RoutesFor<"clean" | "reset" | "retry" | "status"> = {
  status: {
    needsHome: onlyUserOrAllSelector,
    run: (invocation, stateOptions) =>
      Effect.gen(function* () {
        const cwd = yield* cwdOrCurrent(invocation.cwd);
        const snapshot = yield* readInvocationSnapshot(stateOptions);
        const report = yield* statusFromSnapshot(snapshot, stateOptions, {
          cwd,
          includeOptional: invocation.includeOptional,
          selector: invocation.selector,
          ...(stateOptions.homeDirectory === undefined
            ? {}
            : { userTarget: stateOptions.homeDirectory }),
        });
        // A registered root needs no Git question, and the user scope holds no worktree.
        const checkout =
          report.scope._tag === "user"
            ? ({ _tag: "outside-repository" } as const)
            : yield* observeCheckout(snapshot.state, cwd);
        return withOutsidePendingDiagnostic(
          withUnregisteredWorktree(statusOutcome(report), checkout, report.scope),
          snapshot.state,
          report.selection,
        );
      }),
  },
  clean: {
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
  retry: {
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
  reset: {
    needsHome: false,
    run: (invocation, stateOptions) =>
      resetTack(stateOptions, { apply: invocation.apply }).pipe(Effect.map(cleanupOutcome)),
  },
};
