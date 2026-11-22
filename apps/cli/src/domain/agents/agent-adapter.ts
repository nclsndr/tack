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
  // Cline calls commands workflows. Its extension and CLI both read these two workflow folders.
  cline: {
    capabilities: ["skill-links", "command-links"],
    commandLimit: "runs a command as /NAME.md, extension included",
    projectCommandDirectory: [".clinerules", "workflows"],
    userCommandDirectory: ["Documents", "Cline", "Workflows"],
    projectSkillDirectory: [".cline", "skills"],
    userSkillDirectory: [".cline", "skills"],
  },
  codex: {
    capabilities: ["skill-links"],
    projectSkillDirectory: [".agents", "skills"],
    userSkillDirectory: [".agents", "skills"],
  },
  // Copilot CLI reads Markdown commands only from Claude Code's `.claude/commands`, so it gets none.
  copilot: {
    capabilities: ["skill-links"],
    projectSkillDirectory: [".github", "skills"],
    userSkillDirectory: [".copilot", "skills"],
  },
  cursor: {
    capabilities: ["skill-links", "command-links"],
    projectCommandDirectory: [".cursor", "commands"],
    userCommandDirectory: [".cursor", "commands"],
    projectSkillDirectory: [".cursor", "skills"],
    userSkillDirectory: [".cursor", "skills"],
  },
  // Gemini CLI reads commands only as TOML files, and Tack links Markdown untranslated.
  gemini: {
    capabilities: ["skill-links"],
    projectSkillDirectory: [".gemini", "skills"],
    userSkillDirectory: [".gemini", "skills"],
  },
  opencode: {
    capabilities: ["skill-links", "command-links"],
    projectCommandDirectory: [".opencode", "commands"],
    userCommandDirectory: [".config", "opencode", "commands"],
    projectSkillDirectory: [".opencode", "skills"],
    userSkillDirectory: [".config", "opencode", "skills"],
  },
  // Pi calls commands prompt templates and loads only direct `.md` children of `prompts`.
  pi: {
    capabilities: ["skill-links", "command-links"],
    projectCommandDirectory: [".pi", "prompts"],
    userCommandDirectory: [".pi", "agent", "prompts"],
    projectSkillDirectory: [".pi", "skills"],
    userSkillDirectory: [".pi", "agent", "skills"],
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
