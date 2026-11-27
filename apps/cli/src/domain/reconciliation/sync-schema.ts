import { Schema } from "effect";
import { AgentAdapterIdSchema, AgentCapabilitySchema } from "../agents/agent-adapter-schema.ts";
import {
  DocsLinkApplicationSchema,
  DocsLinkPlanSchema,
  DocsPendingRemovalsSchema,
} from "../docs/docs-schema.ts";
import { ReconciliationApplyResultSchema } from "./reconciliation-application-schema.ts";
import { ReconciliationCommandPlanSchema } from "./reconciliation-schema.ts";
import { SourcesSkillReportSchema } from "../generated/sources-skill-schema.ts";

/**
 * The flags that narrow or widen what a sync plans, as the request made them; each key is present
 * only when its flag was given. Applying a preview with the same flags writes exactly what it
 * showed. `--no-adapters` is not echoed: it is the plan's `resources` being null.
 */
const SyncOptionsSchema = Schema.Struct({
  adapters: Schema.optionalKey(Schema.Array(AgentAdapterIdSchema)),
  includeOptional: Schema.optionalKey(Schema.Literal(true)),
  noDocs: Schema.optionalKey(Schema.Literal(true)),
  requiredCapability: Schema.optionalKey(AgentCapabilitySchema),
});

/** The narrowing flags a sync request carried. */
export type SyncOptions = typeof SyncOptionsSchema.Type;

/** The combined resource and docs preview returned by sync. */
export const SyncPlanSchema = Schema.Struct({
  kind: Schema.Literal("sync-plan"),
  resources: Schema.NullOr(ReconciliationCommandPlanSchema).annotate({
    description: "The agent-link plan; null when --no-adapters left it out.",
  }),
  docs: Schema.Array(DocsLinkPlanSchema).annotate({
    description: "The docs-mount plan per project; empty when --no-docs left it out.",
  }),
  /** The docs mounts of the synced projects whose removal is owed; absent when none is. */
  docsPendingRemovals: Schema.optionalKey(DocsPendingRemovalsSchema),
  /**
   * The sources skill of each synced namespace that links a source, and whether its copy is
   * current; applying writes each one that is not, before it links it. Absent when there is none.
   */
  sourcesSkills: Schema.optionalKey(Schema.Array(SourcesSkillReportSchema)),
  /** The narrowing flags of the request; absent when it gave none. */
  options: Schema.optionalKey(SyncOptionsSchema),
});

/** The results of applying a freshly computed combined sync plan. */
export const SyncApplicationSchema = Schema.Struct({
  kind: Schema.Literal("sync-application"),
  resources: Schema.NullOr(ReconciliationApplyResultSchema).annotate({
    description: "What applying changed among agent links; null when --no-adapters left it out.",
  }),
  docs: Schema.Array(DocsLinkApplicationSchema),
  /** The docs mounts of the synced projects whose removal is still owed; absent when none is. */
  docsPendingRemovals: Schema.optionalKey(DocsPendingRemovalsSchema),
});
