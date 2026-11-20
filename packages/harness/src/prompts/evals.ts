import { agentPrompt } from "./landing.ts";

/**
 * The named first user messages an eval trial can start from, the baseline a campaign overrides.
 * `{{request}}` stands for the task's own request and `{{cwd}}` for its working directory.
 */
export const evalPrompts = {
  /** The task's request, verbatim. */
  task: "{{request}}",
  /** The prompt the landing page asks a visitor to give their coding agent. */
  "getting-started": agentPrompt,
} as const satisfies Record<string, string>;

/** A skill the eval delivers to the agent, as the agent's own skill listing would show it. */
type InstalledSkill = { name: string; description: string; path: string };

/**
 * The environment an eval agent runs in, appended to its system prompt: its one tool, where the
 * task runs, and the skills installed for it. Each skill shows its name and description, as a
 * native skill listing does, so the agent reads a skill's file only when the description matches.
 */
export const environmentPrompt = ({
  cwd,
  skills,
}: {
  cwd: string;
  skills: readonly InstalledSkill[];
}) =>
  [
    "You work on the user's machine through one tool, mcp task exec. It runs argv in a separate networkless container; the user's files are under /world there, not in your own process.",
    `Working directory: ${cwd}.`,
    skills.length === 0
      ? "No skills are installed."
      : [
          "Skills installed for you. When a skill's description matches the request, read its file with that tool before you act:",
          ...skills.map((skill) => `- ${skill.name}: ${skill.description} Read ${skill.path}`),
        ].join("\n"),
  ].join("\n\n");
