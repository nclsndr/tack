import { Effect, Schema } from "effect";
import { agentAdapterIds } from "../../../domain/agents/agent-adapter.ts";
import {
  InitApplicationSchema,
  InitPlanSchema,
} from "../../../domain/setup/machine-init-schema.ts";
import {
  agentHomes,
  runMachineInit,
  type MachineInitExecution,
} from "../../../features/setup/machine-init.ts";
import { syncOutcome, toJson } from "../outcomes.ts";
import type { PublicOutcome } from "../public-outcome.ts";
import { afterSync } from "./sync.ts";
import { cwdOrCurrent, type RoutesFor } from "./route.ts";

const validInitPlan = Schema.decodeUnknownSync(InitPlanSchema, { onExcessProperty: "error" });
const validInitApplication = Schema.decodeUnknownSync(InitApplicationSchema, {
  onExcessProperty: "error",
});

/** The diagnostic code of a setup that found no agent and was given none. */
const agentHomeNotFound = "agent-home-not-found";

/** Every adapter `--adapter` accepts, in table order, such as `claude, codex or cursor`. */
const adapterChoices = `${agentAdapterIds.slice(0, -1).join(", ")} or ${agentAdapterIds.at(-1)}`;

/**
 * Presents what `tack init` planned and applied. Its user part is exactly `sync --user`'s payload,
 * with that sync's diagnostics. It is partial when that sync is, or when no agent was found or
 * named, in which case only the state is set up and the sync's own no-adapter warning is replaced
 * by one that names the agent folders looked for.
 */
const machineInitOutcome = ({ plan, applied }: MachineInitExecution): PublicOutcome => {
  const sync = syncOutcome({ plan: plan.sync, applied: applied.sync }, undefined);
  const noAgent = plan.adapters.enabled.length === 0 && plan.adapters.toEnable.length === 0;
  const diagnostics = [
    ...(noAgent
      ? [
          {
            code: agentHomeNotFound,
            message: `No agent folder was found in ${plan.home} (it looks for ${Object.values(agentHomes).flat().join(", ")}), so Tack has no agent to link into. Name yours with --adapter ${adapterChoices}.`,
            severity: "warning" as const,
          },
        ]
      : []),
    ...sync.diagnostics.filter(
      (diagnostic) => noAgent === false || diagnostic.code !== "no-adapters-enabled",
    ),
  ];
  return {
    classification: diagnostics.length === 0 ? "success" : "partial",
    diagnostics,
    plan: toJson(
      validInitPlan({
        kind: "init-plan",
        stateDirectory: plan.stateDirectory,
        state: plan.state,
        adapters: plan.adapters,
        user: sync.plan,
        handMade: plan.handMade,
      }),
    ),
    applied: toJson(
      validInitApplication({
        kind: "init-application",
        state: applied.state,
        adaptersEnabled: applied.adaptersEnabled,
        user: sync.applied,
      }),
    ),
  };
};

/** One machine setup, written at once: state, agents and their user links. */
export const setupRoutes: RoutesFor<"init"> = {
  init: {
    needsHome: true,
    run: (invocation, stateOptions) =>
      cwdOrCurrent(undefined).pipe(
        Effect.flatMap((cwd) =>
          runMachineInit(stateOptions, {
            cwd,
            ...(invocation.adapters === undefined ? {} : { adapters: invocation.adapters }),
          }),
        ),
        Effect.tap(() => afterSync(stateOptions, true)),
        Effect.map(machineInitOutcome),
      ),
  },
};
