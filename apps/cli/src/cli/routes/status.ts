import { Effect } from "effect";
import { readInvocationSnapshot } from "../../features/snapshot/command-snapshot.ts";
import { statusFromSnapshot } from "../../features/status/status.ts";
import { observeCheckout } from "../../features/projects/checkout.ts";
import {
  statusOutcome,
  withOutsidePendingDiagnostic,
  withUnregisteredWorktree,
} from "../envelope/outcomes.ts";
import { cwdOrCurrent, type RoutesFor, onlyUserOrAllSelector } from "./route.ts";

/** Read-only status of the links, sources and pending removals of a scope. */
export const statusRoutes: RoutesFor<"status"> = {
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
};
