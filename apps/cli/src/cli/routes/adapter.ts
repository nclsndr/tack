import { Effect } from "effect";
import { disableAdapter } from "../../features/removal/adapter-disablement.ts";
import { enableAdapters, listEnabledAdapters } from "../../features/reconciliation/agent.ts";
import { appliedAs, removalOutcome, resultAs } from "../envelope/outcomes.ts";
import type { RoutesFor } from "./route.ts";

/** The enabled agent adapters: list, enable and disable. */
export const adapterRoutes: RoutesFor<"adapter-disable" | "adapter-list" | "adapter-enable"> = {
  "adapter-enable": {
    needsHome: false,
    // The named adapters replace detection, as `init --adapter` does, when this initializes state.
    run: (invocation, { initialAdapters: _detected, ...stateOptions }) =>
      enableAdapters(stateOptions, invocation.adapters).pipe(
        Effect.map(appliedAs("adapter-enable")),
      ),
  },
  "adapter-list": {
    needsHome: false,
    run: (_, stateOptions) =>
      listEnabledAdapters(stateOptions).pipe(
        Effect.map((enabledAdapters) => resultAs("adapter-list")({ enabledAdapters })),
      ),
  },
  "adapter-disable": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      disableAdapter(stateOptions, invocation.adapter, { apply: invocation.apply }).pipe(
        Effect.map((execution) =>
          removalOutcome(execution, {
            planned: [execution.plan.removal],
            applied: execution.applied === undefined ? undefined : [execution.applied.removal],
          }),
        ),
      ),
  },
};
