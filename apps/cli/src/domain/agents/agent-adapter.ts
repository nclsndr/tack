import { keys } from "effect/Record";

import type {
  AgentAdapterId,
  AgentAdapterDescriptor,
  AgentAdapterDestinations,
  AgentCapability,
  AgentCapabilityDecision,
} from "../links/agent-adapter-schema.ts";

/**
 * The static adapter registry used by planning, reconciliation and import discovery, keyed by
 * adapter ID in canonical code-unit order. Its keys are the closed set of adapter IDs.
 */
const agentAdapterTable = {
  claude: {
    capabilities: ["skill-links"],
    projectSkillDirectory: [".claude", "skills"],
    userSkillDirectory: [".claude", "skills"],
  },
  codex: {
    capabilities: ["skill-links"],
    projectSkillDirectory: [".agents", "skills"],
    userSkillDirectory: [".agents", "skills"],
  },
  cursor: {
    capabilities: ["skill-links", "command-links"],
    projectCommandDirectory: [".cursor", "commands"],
    userCommandDirectory: [".cursor", "commands"],
    projectSkillDirectory: [".cursor", "skills"],
    userSkillDirectory: [".cursor", "skills"],
  },
} as const satisfies Readonly<Record<string, AgentAdapterDestinations>>;

/** The adapter IDs in table order, which is canonical code-unit order. */
export const agentAdapterIds = keys(agentAdapterTable);

/** Returns the statically advertised descriptor for one adapter ID. */
export const agentAdapterDescriptor = (adapter: AgentAdapterId): AgentAdapterDescriptor => ({
  id: adapter,
  ...agentAdapterTable[adapter],
});

/** Every adapter descriptor in table order. */
export const agentAdapterDescriptors = agentAdapterIds.map(agentAdapterDescriptor);

/** Checks one required capability without inspecting the host or installed products. */
export const resolveAdapterCapability = (
  descriptor: AgentAdapterDescriptor,
  capability: AgentCapability,
): AgentCapabilityDecision =>
  descriptor.capabilities.includes(capability) === true
    ? { _tag: "supported", capability }
    : { _tag: "blocked", capability };
