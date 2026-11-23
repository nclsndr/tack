import { Schema } from "effect";

import { agentAdapterIds } from "../agents/agent-adapter.ts";
import { sortedUnique } from "../identity/ordering.ts";

/** The built-in agent adapters supported by Tack, the keys of the adapter table. */
export const AgentAdapterIdSchema = Schema.Literals(agentAdapterIds);

/** A versioned operation advertised by an agent adapter. */
export const AgentCapabilitySchema = Schema.Literals(["skill-links", "command-links"]);

const AdapterDirectorySegmentSchema = Schema.String.check(Schema.isMinLength(1)).check(
  Schema.makeFilter((segment) =>
    segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")
      ? ["Adapter directory segments must be relative path names."]
      : [],
  ),
);

const AdapterDirectorySchema = Schema.NonEmptyArray(AdapterDirectorySegmentSchema);

const uniqueCapabilities = (capabilities: ReadonlyArray<AgentCapability>) =>
  new Set(capabilities).size === capabilities.length
    ? []
    : ["Adapter capabilities must be unique."];

/** One adapter's supported destinations and operations: a row of the adapter table. */
const AgentAdapterDestinationsSchema = Schema.Struct({
  capabilities: Schema.Array(AgentCapabilitySchema).check(Schema.makeFilter(uniqueCapabilities)),
  projectSkillDirectory: AdapterDirectorySchema,
  userSkillDirectory: AdapterDirectorySchema,
  projectCommandDirectory: Schema.optionalKey(AdapterDirectorySchema),
  userCommandDirectory: Schema.optionalKey(AdapterDirectorySchema),
  /** How the agent handles a linked command differently from its author's intent, as a clause. */
  commandLimit: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
});

/** The strict, code-owned description of one adapter's supported destinations and operations. */
export const AgentAdapterDescriptorSchema = Schema.Struct({
  ...AgentAdapterDestinationsSchema.fields,
  id: AgentAdapterIdSchema,
});

/** The persisted canonical enabled-adapter collection. */
export const EnabledAdaptersSchema = Schema.Array(AgentAdapterIdSchema).check(
  sortedUnique((adapter) => adapter, {
    duplicate: "Enabled adapters must be unique.",
    unordered: "Enabled adapters must use canonical code-unit ordering.",
  }),
);

/**
 * Whether one adapter supports the capability an invocation requires. Only a required capability
 * produces a decision; a unit without it is blocked rather than planned.
 */
export const AgentCapabilityDecisionSchema = Schema.Union([
  Schema.TaggedStruct("supported", { capability: AgentCapabilitySchema }),
  Schema.TaggedStruct("blocked", { capability: AgentCapabilitySchema }),
]);

/** A validated agent adapter ID. */
export type AgentAdapterId = typeof AgentAdapterIdSchema.Type;

/** A validated adapter capability. */
export type AgentCapability = typeof AgentCapabilitySchema.Type;

/** One row of the adapter table, which the table key completes into a descriptor. */
export type AgentAdapterDestinations = typeof AgentAdapterDestinationsSchema.Type;

/** A validated adapter descriptor. */
export type AgentAdapterDescriptor = typeof AgentAdapterDescriptorSchema.Type;

/** A validated capability decision. */
export type AgentCapabilityDecision = typeof AgentCapabilityDecisionSchema.Type;
