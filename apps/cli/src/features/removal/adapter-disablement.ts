import { Effect, Schema } from "effect";

import {
  AgentAdapterIdSchema,
  EnabledAdaptersSchema,
  type AgentAdapterId,
} from "../../domain/agents/agent-adapter-schema.ts";
import { applyRemovalWithWriter } from "./removal-apply.ts";
import { planRemoval } from "./removal-plan.ts";
import {
  RemovalPlanSchema,
  RemovalResultSchema,
} from "../../domain/reconciliation/removal-schema.ts";
import { previewOrApply } from "../writer/recovered-writer.ts";
import type { State } from "../../domain/state/state-schema.ts";
import type { StateCheckpointWriter, StateOptions } from "../../services/state-store.ts";

/** A deterministic adapter setting transition paired with its exact cleanup proof. */
export const AdapterDisablementPlanSchema = Schema.Struct({
  adapter: AgentAdapterIdSchema,
  enabledAdapters: EnabledAdaptersSchema,
  expectedEnabledAdapters: EnabledAdaptersSchema,
  kind: Schema.Literal("adapter-disablement-plan"),
  removal: RemovalPlanSchema,
  version: Schema.Literal(1),
});

/** The durable outcome of applying one adapter disablement plan. */
export const AdapterDisablementResultSchema = Schema.Struct({
  adapter: AgentAdapterIdSchema,
  enabledAdapters: EnabledAdaptersSchema,
  kind: Schema.Literal("adapter-disablement-application"),
  removal: RemovalResultSchema,
  version: Schema.Literal(1),
});

/** A validated adapter disablement plan. */
export type AdapterDisablementPlan = typeof AdapterDisablementPlanSchema.Type;

/** A validated adapter disablement application result. */
export type AdapterDisablementResult = typeof AdapterDisablementResultSchema.Type;

/** One adapter disablement plan and its optional application outcome. */
type AdapterDisablementExecution = {
  readonly applied?: AdapterDisablementResult;
  readonly plan: AdapterDisablementPlan;
};

/** Reports a malformed adapter ID. */
export class AdapterDisablementValidationError extends Schema.TaggedError<AdapterDisablementValidationError>()(
  "AdapterDisablementValidationError",
  { message: Schema.String },
) {}

const decodeAdapter = (candidate: unknown) =>
  Schema.decodeUnknownEffect(AgentAdapterIdSchema)(candidate).pipe(
    Effect.mapError((cause) => new AdapterDisablementValidationError({ message: cause.message })),
  );

const planFromState = Effect.fnUntraced(function* (state: State, adapter: AgentAdapterId) {
  const expectedEnabledAdapters = state.data.enabledAdapters;
  const removal = yield* planRemoval(state, {
    cause: "adapter-disable",
    scope: { _tag: "adapter", adapter },
  });
  return {
    adapter,
    enabledAdapters: expectedEnabledAdapters.filter((candidate) => candidate !== adapter),
    expectedEnabledAdapters,
    kind: "adapter-disablement-plan",
    removal,
    version: 1,
  } satisfies AdapterDisablementPlan;
});

/** Applies a plan built from the same writer, recording the setting with its cleanup evidence. */
const applyPlan = Effect.fnUntraced(function* (
  writer: StateCheckpointWriter,
  plan: AdapterDisablementPlan,
) {
  const removal = yield* applyRemovalWithWriter(writer, plan.removal, (state) =>
    plan.enabledAdapters.length === plan.expectedEnabledAdapters.length
      ? state
      : { ...state, data: { ...state.data, enabledAdapters: plan.enabledAdapters } },
  );
  return {
    adapter: plan.adapter,
    enabledAdapters: plan.enabledAdapters,
    kind: "adapter-disablement-application",
    removal,
    version: 1,
  } satisfies AdapterDisablementResult;
});

/**
 * Plans or applies machine-wide cleanup for one persisted adapter selection. Adapters are not
 * scoped to a project, so the cleanup covers every managed target holding the adapter's links
 * regardless of the operator's current directory.
 */
export const disableAdapter = Effect.fn("removal.disableAdapter")(function* (
  stateOptions: StateOptions,
  adapterCandidate: unknown,
  options: { readonly apply: boolean },
) {
  const adapter = yield* decodeAdapter(adapterCandidate);
  const execution: AdapterDisablementExecution = yield* previewOrApply(stateOptions, {
    apply: options.apply,
    plan: ({ state }) => planFromState(state, adapter),
    applyPlan,
  });
  return execution;
});
