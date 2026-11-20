import { Schema } from "effect";
import { HandMadeEntrySchema } from "../agents/hand-made-entry.ts";
import { AgentAdapterIdSchema } from "../links/agent-adapter-schema.ts";
import { SyncApplicationSchema, SyncPlanSchema } from "../reconciliation/sync-schema.ts";

/** Whether one agent's home folder exists in the operator home. */
const AgentDetectionSchema = Schema.Struct({
  adapter: AgentAdapterIdSchema,
  home: Schema.String.annotate({
    description: "The folder looked for: the one found, else the first one Tack looks for.",
  }),
  found: Schema.Boolean,
});

/** One agent's detection; see {@link AgentDetectionSchema}. */
export type AgentDetection = typeof AgentDetectionSchema.Type;

/** What one `tack init` planned to write, from what it found on this machine. */
export const InitPlanSchema = Schema.Struct({
  kind: Schema.Literal("init-plan"),
  stateDirectory: Schema.String,
  state: Schema.Literals(["create", "exists"]).annotate({
    description:
      "create: the state and its .env were absent, so init creates them; exists: they are kept.",
  }),
  adapters: Schema.Struct({
    enabled: Schema.Array(AgentAdapterIdSchema).annotate({
      description: "The adapters enabled before init; init never disables one.",
    }),
    toEnable: Schema.Array(AgentAdapterIdSchema).annotate({
      description: "The adapters init enables in addition to the enabled ones.",
    }),
    detection: Schema.Array(AgentDetectionSchema).annotate({
      description: "Every adapter's home folder and whether it exists.",
    }),
    source: Schema.Literals(["detected", "requested"]).annotate({
      description:
        "detected: the adapters to enable are the agents whose home was found; requested: --adapter named them.",
    }),
  }),
  user: SyncPlanSchema.annotate({
    description:
      "The plan tack sync --user makes once those adapters are enabled: on a new machine, the built-in skills.",
  }),
  handMade: Schema.Array(HandMadeEntrySchema).annotate({
    description:
      "Entries in the agents' user skill and command folders that Tack has no record of. Init leaves them untouched.",
  }),
});

/** What `tack init` wrote, beside the plan it applied. */
export const InitApplicationSchema = Schema.Struct({
  kind: Schema.Literal("init-application"),
  state: Schema.Literals(["created", "existed"]),
  adaptersEnabled: Schema.Array(AgentAdapterIdSchema).annotate({
    description: "The adapters this run enabled; empty when none was added.",
  }),
  user: SyncApplicationSchema,
});
