import { pendingRemovalsOf } from "../../domain/links/link-record-schema.ts";
import { Effect, Schema } from "effect";

import {
  AgentAdapterIdSchema,
  EnabledAdaptersSchema,
  type AgentAdapterId,
} from "../../domain/agents/agent-adapter-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { mutateState, type StateMutation, type StateOptions } from "../../services/state-store.ts";
import { type State } from "../../domain/state/state-schema.ts";
import { readInvocationSnapshot } from "../snapshot/command-snapshot.ts";

const AgentAdapterInputSchema = Schema.Array(AgentAdapterIdSchema).check(
  Schema.makeFilter((adapters) =>
    new Set(adapters).size === adapters.length ? [] : ["Adapter IDs must be unique."],
  ),
);

/** Reports invalid adapter IDs or duplicate invocation selections. */
export class AgentSelectionValidationError extends Schema.TaggedError<AgentSelectionValidationError>()(
  "AgentSelectionValidationError",
  {
    code: Schema.Literal("enabled-adapters-invalid"),
    message: Schema.String,
  },
) {}

/** Reports adapter-set changes that conflict with cleanup-aware disablement. */
export class AgentDisablementRequiredError extends Schema.TaggedError<AgentDisablementRequiredError>()(
  "AgentDisablementRequiredError",
  {
    adapters: EnabledAdaptersSchema,
    code: Schema.Literal("adapter-reenablement-blocked"),
    message: Schema.String,
  },
) {}

/** Reports a one-invocation adapter override that names adapters the machine has not enabled. */
export class AdapterNotEnabledError extends Schema.TaggedError<AdapterNotEnabledError>()(
  "AdapterNotEnabledError",
  {
    /** The requested adapters that are not enabled, in canonical order. */
    adapters: EnabledAdaptersSchema,
    code: Schema.Literal("adapter-not-enabled"),
    enabledAdapters: EnabledAdaptersSchema,
    message: Schema.String,
  },
) {}

/** The `adapter enable` payload:the enabled adapters after the call and whether they changed. */
export const AdapterSettingsPayloadSchema = Schema.Struct({
  kind: Schema.Literal("adapter-settings"),
  changed: Schema.Boolean,
  enabledAdapters: Schema.Array(AgentAdapterIdSchema),
});

/** What enabling adapters reports. */
export type SetEnabledAdaptersResult = Omit<typeof AdapterSettingsPayloadSchema.Type, "kind">;

/** The `adapter` payload: the adapters enabled in state. */
export const AdapterListPayloadSchema = Schema.Struct({
  kind: Schema.Literal("adapters"),
  enabledAdapters: Schema.Array(AgentAdapterIdSchema),
});

/** Invocation-only adapter selection options. */
export type AgentInvocationOptions = {
  /** An explicitly supplied empty array selects no adapters for this invocation. */
  readonly adapterOverride?: ReadonlyArray<AgentAdapterId>;
};

const enabledAdaptersFrom = (state: State): ReadonlyArray<AgentAdapterId> =>
  state.data.enabledAdapters;

const sameAdapters = (left: ReadonlyArray<AgentAdapterId>, right: ReadonlyArray<AgentAdapterId>) =>
  left.length === right.length && left.every((adapter, index) => adapter === right[index]);

const canonicalizeAdapters = (adapters: ReadonlyArray<AgentAdapterId>) =>
  [...adapters].sort(compareCodeUnits);

const pendingDisablementsFor = (
  state: State,
  requested: ReadonlyArray<AgentAdapterId>,
): ReadonlyArray<AgentAdapterId> => {
  const requestedAdapters = new Set(requested);
  return canonicalizeAdapters([
    ...new Set(
      pendingRemovalsOf(state.data.links).flatMap((pending) =>
        pending.cause === "adapter-disable" && requestedAdapters.has(pending.evidence.adapter)
          ? [pending.evidence.adapter]
          : [],
      ),
    ),
  ]);
};

const decodeAdapterInput = (adapters: unknown) =>
  Schema.decodeUnknownEffect(AgentAdapterInputSchema)(adapters).pipe(
    Effect.mapError(
      (cause) =>
        new AgentSelectionValidationError({
          code: "enabled-adapters-invalid",
          message: cause.message,
        }),
    ),
  );

/**
 * Adds `adapters` to the enabled ones of `state` without changing the others. It refuses an adapter
 * whose disablement cleanup is still owed.
 */
export const enableAdaptersIn = (
  state: State,
  adapters: ReadonlyArray<AgentAdapterId>,
): Effect.Effect<StateMutation<SetEnabledAdaptersResult>, AgentDisablementRequiredError> => {
  const existing = enabledAdaptersFrom(state);
  const enabled = canonicalizeAdapters([...new Set([...existing, ...adapters])]);
  const pendingDisablements = pendingDisablementsFor(state, enabled);
  if (pendingDisablements.length > 0)
    return Effect.fail(
      new AgentDisablementRequiredError({
        adapters: pendingDisablements,
        code: "adapter-reenablement-blocked",
        message: "Adapters cannot be enabled until their pending disablement cleanup settles.",
      }),
    );
  if (sameAdapters(existing, enabled))
    return Effect.succeed({ state, value: { changed: false, enabledAdapters: existing } });
  return Effect.succeed({
    state: { ...state, data: { ...state.data, enabledAdapters: enabled } },
    value: { changed: true, enabledAdapters: enabled },
  });
};

/** Adds adapters atomically without changing other enabled adapters. */
export const enableAdapters = Effect.fn("reconciliation.enableAdapters")(function* (
  options: StateOptions,
  adapters: unknown,
) {
  const decoded = yield* decodeAdapterInput(adapters);
  return yield* mutateState(options, (state) => enableAdaptersIn(state, decoded));
});

/** Lists the persisted machine-level enabled adapters in canonical order. */
export const listEnabledAdapters = Effect.fn("reconciliation.listEnabledAdapters")(function* (
  options: StateOptions,
) {
  const { state } = yield* readInvocationSnapshot(options);
  return enabledAdaptersFrom(state);
});

/**
 * Resolves persisted enablement and an optional one-invocation override. An override only narrows
 * the enabled adapters: it refuses an adapter the machine has not enabled, because no later sync
 * would maintain the links it delivers.
 */
export const resolveEffectiveAdapters = (
  persisted: ReadonlyArray<AgentAdapterId>,
  options: AgentInvocationOptions = {},
): Effect.Effect<ReadonlyArray<AgentAdapterId>, AdapterNotEnabledError> => {
  if (options.adapterOverride === undefined) return Effect.succeed(canonicalizeAdapters(persisted));
  const requested = canonicalizeAdapters(options.adapterOverride);
  const notEnabled = requested.filter((adapter) => persisted.includes(adapter) === false);
  return notEnabled.length === 0
    ? Effect.succeed(requested)
    : Effect.fail(
        new AdapterNotEnabledError({
          adapters: notEnabled,
          code: "adapter-not-enabled",
          enabledAdapters: canonicalizeAdapters(persisted),
          message: `Adapters ${notEnabled.join(", ")} are not enabled.`,
        }),
      );
};
