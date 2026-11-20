import { evalPrompts } from "@tackup/harness/prompts/evals";
import { digest, type PlannedTrial } from "./plan.ts";

/** One planned trial as `planCampaign` would write it, for tests that save, report or launch it. */
export const plannedTrialFixture = (change: Partial<PlannedTrial> = {}): PlannedTrial => ({
  id: "one",
  stage: "all",
  taskId: "task-a",
  profile: { driver: "claude", model: "test", effort: "low" },
  arm: "baseline",
  seed: 1,
  prompt: { source: "harness:task", text: evalPrompts.task, sha256: digest(evalPrompts.task) },
  skills: [],
  followUps: 0,
  limits: { wallSeconds: 120, toolCalls: 12, outputBytes: 4194304 },
  ...change,
});
