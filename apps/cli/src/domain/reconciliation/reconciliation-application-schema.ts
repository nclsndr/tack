import { Schema } from "effect";
import { AgentAdapterIdSchema } from "../agents/agent-adapter-schema.ts";
import { CanonicalPathSchema } from "../identity/identity-schema.ts";
import { ManagedLinkTargetSchema } from "../links/managed-link-schema.ts";
import { ReconciliationActionSchema, reconciliationPlanVersion } from "./reconciliation-schema.ts";

/** A filesystem outcome that did not grant or consume managed-link ownership. */
const ReconciliationActionFailureCodeSchema = Schema.Literals([
  "destination-conflict",
  "destination-directory-conflict",
  "filesystem-failure",
]);

/** One action's durable, JSON-safe application outcome. */
const ReconciliationActionOutcomeSchema = Schema.Union([
  Schema.TaggedStruct("applied", { action: ReconciliationActionSchema }),
  Schema.TaggedStruct("failed", {
    action: ReconciliationActionSchema,
    code: ReconciliationActionFailureCodeSchema,
    message: Schema.String,
    path: CanonicalPathSchema,
  }),
  Schema.TaggedStruct("skipped", {
    action: ReconciliationActionSchema,
    reason: Schema.String,
  }),
]);

/**
 * One target-and-adapter unit's application report. Its collisions and conflicts are the plan
 * unit's, reported once in the plan that accompanies every application.
 */
const ReconciliationUnitOutcomeSchema = Schema.Struct({
  actions: Schema.Array(ReconciliationActionOutcomeSchema),
  adapter: AgentAdapterIdSchema,
  status: Schema.Literals(["success", "partial", "failed", "blocked"]),
  target: ManagedLinkTargetSchema,
});

/** The JSON-safe result of applying one validated reconciliation plan. */
export const ReconciliationApplyResultSchema = Schema.Struct({
  kind: Schema.Literal("skill-reconciliation-application"),
  units: Schema.Array(ReconciliationUnitOutcomeSchema),
  version: Schema.Literal(reconciliationPlanVersion),
});

export type ReconciliationActionFailureCode = typeof ReconciliationActionFailureCodeSchema.Type;
export type ReconciliationActionOutcome = typeof ReconciliationActionOutcomeSchema.Type;
export type ReconciliationApplyResult = typeof ReconciliationApplyResultSchema.Type;
export type ReconciliationUnitOutcome = typeof ReconciliationUnitOutcomeSchema.Type;
