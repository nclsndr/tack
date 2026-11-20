import { createHash } from "node:crypto";
import { posix } from "node:path";
import { evalPrompts } from "@tackup/harness/prompts/evals";
import { drivers } from "./drivers.ts";
import type {
  EvalTask,
  ExecutionOutcome,
  Grade,
  TaskFamily,
  TaskSuite,
  TrialLimits,
} from "./contract.ts";

export const driverIds = ["claude", "codex"] as const;
export type DriverId = (typeof driverIds)[number];
export type ModelProfile = { driver: DriverId; model: string; effort: string };
/** Text the agent receives, where it came from and its SHA-256. */
type AgentText = { source: string; text: string; sha256: string };
/** A built-in skill file a trial replaces or adds, by its path under the built-ins' `skills/`. */
type SkillFile = AgentText & { path: string };
export type PlannedTrial = {
  id: string;
  stage: string;
  taskId: string;
  profile: ModelProfile;
  /** The campaign arm this trial runs: the overrides it applies to the baseline. */
  arm: string;
  seed: number;
  /** The first user message's template: the arm's override, else the task's harness prompt. */
  prompt: AgentText;
  skills: readonly SkillFile[];
  /** How many fixed follow-up messages the task sends after the prompt. */
  followUps: number;
  limits: TrialLimits;
};
/** What the selected drivers can enforce or carry; the plan refuses a trial that needs more. */
export type DriverCapabilities = {
  followUps: boolean;
  maxTurns: boolean;
  budgetUsd: boolean;
};
export type CampaignPlan = {
  confirmation: string;
  trials: readonly PlannedTrial[];
  limits: { trials: number; wallSeconds: number; budgetUsd: number | null };
  estimate: {
    userTurns: number;
    inputTokens: { low: number; high: number; calibrated: false };
    /** The sum of every trial's `budgetUsd`, or `null` when a trial has none. */
    trialBudgetsUsd: number | null;
  };
};
/** The operator's narrowing of a campaign: a trial must match every list that is given. */
export type PlanFilters = {
  stages?: readonly string[];
  tags?: readonly string[];
  taskIds?: readonly string[];
};

/** Hash exact bytes for immutable identities and explicit campaign confirmation. */
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
/** Narrow untrusted JSON records without an unchecked cast. */
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}
const onlyKeys = (input: Record<string, unknown>, allowed: readonly string[], what: string) => {
  const unknown = Object.keys(input).find((key) => allowed.includes(key) === false);
  if (unknown !== undefined) throw new Error(`Unknown ${what} field ${unknown}`);
};
const portableId = (value: unknown): string => {
  if (typeof value !== "string" || /^[a-z0-9-]+$/.test(value) === false)
    throw new Error(`Invalid id ${String(value)}`);
  return value;
};
/** Validate an identifier list, refusing ambiguous duplicates. */
function identifiers(value: unknown): string[] {
  if (
    Array.isArray(value) === false ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string")
  )
    throw new Error("Expected nonempty string list");
  const values = value.filter((item): item is string => typeof item === "string");
  if (new Set(values).size !== values.length) throw new Error("Duplicate selection");
  return values;
}
const uniqueIds = <T extends { id: string }>(items: readonly T[]): readonly T[] => {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error("Duplicate selection");
  return items;
};
/** Validate an explicit model profile; no provider or model fallback is allowed. */
function modelProfile(value: unknown): ModelProfile {
  const input = record(value);
  const driver = driverIds.find((candidate) => candidate === input["driver"]);
  if (driver === undefined) throw new Error("Unsupported driver");
  if (
    typeof input["model"] !== "string" ||
    input["model"].trim().length === 0 ||
    typeof input["effort"] !== "string" ||
    /^[a-z]+$/.test(input["effort"]) === false
  )
    throw new Error("Model and effort must be explicit");
  return { driver, model: input["model"], effort: input["effort"] };
}
const profiles = (value: unknown): ModelProfile[] => {
  if (Array.isArray(value) === false || value.length === 0)
    throw new Error("Select explicit profiles");
  return value.map((profile) => modelProfile(profile));
};
const positiveInteger = (value: unknown, fallback: number, what: string): number => {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number" || Number.isSafeInteger(resolved) === false || resolved < 1)
    throw new Error(`Invalid ${what}`);
  return resolved;
};

/** The highest value each limit accepts, so a typo cannot plan an unbounded trial. */
const limitCeilings = {
  wallSeconds: 3600,
  toolCalls: 500,
  outputBytes: 64 * 1024 * 1024,
  maxTurns: 500,
  budgetUsd: 50,
} as const satisfies Record<keyof TrialLimits, number>;
const limitKeys = Object.keys(limitCeilings);
const limitValue = (key: string, value: unknown, ceiling: number): number => {
  if (
    typeof value !== "number" ||
    Number.isFinite(value) === false ||
    value <= 0 ||
    value > ceiling ||
    (key !== "budgetUsd" && Number.isSafeInteger(value) === false)
  )
    throw new Error(`Invalid limit ${key}`);
  return value;
};
/** Validate a family's complete limits, or a campaign's partial change to them. */
function trialLimits(value: unknown, base?: TrialLimits): TrialLimits {
  const input = record(value);
  onlyKeys(input, limitKeys, "limit");
  const merged: Record<string, unknown> = { ...base, ...input };
  const required = (key: "wallSeconds" | "toolCalls" | "outputBytes") =>
    limitValue(key, merged[key], limitCeilings[key]);
  const optional = (key: "maxTurns" | "budgetUsd") =>
    merged[key] === undefined ? {} : { [key]: limitValue(key, merged[key], limitCeilings[key]) };
  return {
    wallSeconds: required("wallSeconds"),
    toolCalls: required("toolCalls"),
    outputBytes: required("outputBytes"),
    ...optional("maxTurns"),
    ...optional("budgetUsd"),
  };
}

const textOf = (text: string, source: string): AgentText => ({
  source,
  text,
  sha256: digest(text),
});
/** Read `{ text, source? }`; a campaign file's `{ file }` is resolved to this form before planning. */
const suppliedText = (value: unknown): AgentText => {
  const input = record(value);
  onlyKeys(input, ["text", "source"], "text");
  if (typeof input["text"] !== "string") throw new Error("Expected text");
  return textOf(input["text"], typeof input["source"] === "string" ? input["source"] : "inline");
};
const placeholders = ["{{request}}", "{{cwd}}"];
/** Fill a prompt template's `{{request}}` and `{{cwd}}` with the prepared task's values. */
export const renderPrompt = (template: string, values: { request: string; cwd: string }) =>
  template.replaceAll(/\{\{(request|cwd)\}\}/g, (_match, key: "request" | "cwd") => values[key]);
/** A harness prompt by name, or replacement text that uses only the known placeholders. */
const promptOverride = (value: unknown): AgentText => {
  const input = record(value);
  if (input["harness"] !== undefined) {
    onlyKeys(input, ["harness"], "prompt");
    return harnessPrompt(input["harness"]);
  }
  const prompt = suppliedText(input);
  const unknown = prompt.text
    .match(/\{\{[^}]*\}\}/g)
    ?.find((found) => placeholders.includes(found) === false);
  if (unknown !== undefined) throw new Error(`Unknown prompt placeholder ${unknown}`);
  return prompt;
};
const harnessPrompt = (name: unknown): AgentText => {
  const entry = Object.entries(evalPrompts).find(([candidate]) => candidate === name);
  if (entry === undefined) throw new Error(`Unknown harness prompt ${String(name)}`);
  return textOf(entry[1], `harness:${entry[0]}`);
};
/** Accept only plain relative paths inside one built-in skill's folder. */
const skillPath = (path: string): string => {
  const segments = path.split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) === false) ||
    posix.normalize(path) !== path
  )
    throw new Error(`Invalid skill path ${path}`);
  return path;
};

type Arm = { id: string; prompt: AgentText | null; skills: readonly SkillFile[] };
const arm = (value: unknown): Arm => {
  const input = record(value);
  onlyKeys(input, ["id", "prompt", "skills"], "arm");
  return {
    id: portableId(input["id"]),
    prompt: input["prompt"] === undefined ? null : promptOverride(input["prompt"]),
    skills:
      input["skills"] === undefined
        ? []
        : Object.entries(record(input["skills"])).map(([path, text]) => ({
            path: skillPath(path),
            ...suppliedText(text),
          })),
  };
};
type Stage = {
  id: string;
  taskIds: readonly string[] | null;
  tags: readonly string[] | null;
  arms: readonly string[] | null;
  profiles: readonly ModelProfile[] | null;
  repetitions: number | null;
};
const stage = (value: unknown): Stage => {
  const input = record(value);
  onlyKeys(input, ["id", "taskIds", "tags", "arms", "profiles", "repetitions"], "stage");
  const list = (key: string) => (input[key] === undefined ? null : identifiers(input[key]));
  return {
    id: portableId(input["id"]),
    taskIds: list("taskIds"),
    tags: list("tags"),
    arms: list("arms"),
    profiles: input["profiles"] === undefined ? null : profiles(input["profiles"]),
    repetitions:
      input["repetitions"] === undefined
        ? null
        : positiveInteger(input["repetitions"], 1, "repetitions"),
  };
};

/** Refuse malformed task weights or identities before any fixture or inference. */
function validateTask(task: EvalTask): void {
  if (
    /^[A-Za-z0-9-]+$/.test(task.taskId) === false ||
    task.criteria.length === 0 ||
    new Set(task.criteria.map((criterion) => criterion.id)).size !== task.criteria.length ||
    Math.abs(task.criteria.reduce((sum, criterion) => sum + criterion.weight, 0) - 1) > 1e-9 ||
    task.criteria.some(
      (criterion) => Number.isFinite(criterion.weight) === false || criterion.weight <= 0,
    )
  )
    throw new Error(`Invalid task criteria: ${task.taskId}`);
}
const findFamily = (families: readonly TaskFamily[], id: string): TaskFamily => {
  const family = families.find((candidate) => candidate.id === id);
  if (family === undefined) throw new Error(`Unknown family ${id}`);
  return family;
};
/** Input tokens one user turn may take, before any measured calibration. */
const inputTokensPerUserTurn = { low: 30000, high: 150000 } as const;
/** Fixture setup, oracle and grading time a campaign allows each trial beyond its own wall time. */
const overheadSecondsPerTrial = 120;

/**
 * Expand a campaign into its complete, bounded matrix without I/O or model requests: each stage's
 * tasks × profiles × repetitions × arms, narrowed by the operator's filters. Arms alternate order
 * across repetitions, and repetitions share seeds across arms.
 */
export function planCampaign(
  value: unknown,
  suite: TaskSuite,
  filters: PlanFilters = {},
): CampaignPlan {
  const input = record(value);
  onlyKeys(
    input,
    ["seed", "profiles", "repetitions", "limits", "families", "tasks", "arms", "stages"],
    "campaign",
  );
  const seed = input["seed"];
  if (typeof seed !== "number" || Number.isSafeInteger(seed) === false || seed < 0)
    throw new Error("Invalid seed");
  const defaultProfiles = profiles(input["profiles"]);
  const repetitions = positiveInteger(input["repetitions"], 1, "repetitions");
  const families = suite.families.map((family) => ({
    id: family.id,
    limits: trialLimits(family.limits),
  }));
  const familyChanges = Object.entries(
    input["families"] === undefined ? {} : record(input["families"]),
  ).map(([id, change]) => ({ id, limits: trialLimits(change, findFamily(families, id).limits) }));
  const effectiveFamilies = families.map(
    (family) => familyChanges.find((change) => change.id === family.id) ?? family,
  );
  const findTask = (id: string): EvalTask => {
    const task = suite.tasks.find((candidate) => candidate.taskId === id);
    if (task === undefined) throw new Error(`Unknown task ${id}`);
    return task;
  };
  const taskProfiles = new Map(
    Object.entries(input["tasks"] === undefined ? {} : record(input["tasks"])).map(
      ([id, override]) => {
        findTask(id);
        const fields = record(override);
        onlyKeys(fields, ["profiles"], "task");
        return [id, fields["profiles"] === undefined ? null : profiles(fields["profiles"])];
      },
    ),
  );
  const arms = uniqueIds(
    Array.isArray(input["arms"])
      ? input["arms"].map((item) => arm(item))
      : [arm({ id: "baseline" })],
  );
  const stages = uniqueIds(
    Array.isArray(input["stages"])
      ? input["stages"].map((item) => stage(item))
      : [stage({ id: "all" })],
  );
  const campaignLimits = record(input["limits"] ?? {});
  onlyKeys(campaignLimits, ["trials", "wallSeconds", "budgetUsd"], "limits");

  const trials = stages
    .filter((current) => filters.stages === undefined || filters.stages.includes(current.id))
    .flatMap((current) => {
      const stageArms = (current.arms ?? arms.map((candidate) => candidate.id)).map((id) => {
        const found = arms.find((candidate) => candidate.id === id);
        if (found === undefined) throw new Error(`Unknown arm ${id}`);
        return found;
      });
      const selected =
        current.taskIds === null && current.tags === null
          ? suite.tasks
          : [
              ...(current.taskIds ?? []).map((id) => findTask(id)),
              ...suite.tasks.filter((task) =>
                task.tags.some((tag) => current.tags?.includes(tag) === true),
              ),
            ].filter((task, index, all) => all.indexOf(task) === index);
      return selected
        .filter(
          (task) =>
            (filters.taskIds === undefined || filters.taskIds.includes(task.taskId)) &&
            (filters.tags === undefined || task.tags.some((tag) => filters.tags?.includes(tag))),
        )
        .flatMap((task) => {
          validateTask(task);
          const limits = findFamily(effectiveFamilies, task.family).limits;
          const baseline = harnessPrompt(task.prompt ?? "task");
          const followUps = task.followUps?.length ?? 0;
          return (taskProfiles.get(task.taskId) ?? current.profiles ?? defaultProfiles).flatMap(
            (profile) => {
              const can = drivers[profile.driver].capabilities;
              const missing = [
                ...(followUps > 0 && can.followUps === false
                  ? ["cannot send follow-up messages"]
                  : []),
                ...(limits.maxTurns !== undefined && can.maxTurns === false
                  ? ["cannot enforce maxTurns"]
                  : []),
                ...(limits.budgetUsd !== undefined && can.budgetUsd === false
                  ? ["cannot enforce budgetUsd"]
                  : []),
              ];
              if (missing.length > 0)
                throw new Error(`${task.taskId}: ${profile.driver} ${missing.join(", ")}`);
              return Array.from({ length: current.repetitions ?? repetitions }, (_, repetition) =>
                (repetition % 2 === 0 ? stageArms : stageArms.toReversed()).map(
                  (selectedArm): PlannedTrial => ({
                    id: `${current.id}-${task.taskId}-${profile.driver}-${digest(JSON.stringify(profile)).slice(0, 8)}-${seed + repetition}-${selectedArm.id}`,
                    stage: current.id,
                    taskId: task.taskId,
                    profile,
                    arm: selectedArm.id,
                    seed: seed + repetition,
                    prompt: selectedArm.prompt ?? baseline,
                    skills: selectedArm.skills,
                    followUps,
                    limits,
                  }),
                ),
              ).flat();
            },
          );
        });
    });
  if (trials.length === 0) throw new Error("No trials selected");
  if (new Set(trials.map((trial) => trial.id)).size !== trials.length)
    throw new Error("Duplicate trial identity");
  const limits = {
    trials: positiveInteger(campaignLimits["trials"], 12, "limit trials"),
    wallSeconds: positiveInteger(
      campaignLimits["wallSeconds"],
      trials.reduce((sum, trial) => sum + trial.limits.wallSeconds + overheadSecondsPerTrial, 0),
      "limit wallSeconds",
    ),
    budgetUsd:
      campaignLimits["budgetUsd"] === undefined
        ? null
        : limitValue("budgetUsd", campaignLimits["budgetUsd"], Number.MAX_SAFE_INTEGER),
  };
  if (limits.trials > 200) throw new Error("Invalid limit trials");
  if (trials.length > limits.trials)
    throw new Error(
      `Campaign plans ${trials.length} trials; its limit is ${limits.trials}. Select fewer, or raise limits.trials`,
    );
  const userTurns = trials.reduce((sum, trial) => sum + 1 + trial.followUps, 0);
  const estimate = {
    userTurns,
    inputTokens: {
      low: userTurns * inputTokensPerUserTurn.low,
      high: userTurns * inputTokensPerUserTurn.high,
      calibrated: false,
    },
    trialBudgetsUsd: trials.every((trial) => trial.limits.budgetUsd !== undefined)
      ? trials.reduce((sum, trial) => sum + (trial.limits.budgetUsd ?? 0), 0)
      : null,
  } as const;
  const tasks = [...new Set(trials.map((trial) => trial.taskId))].map((id) => findTask(id));
  return {
    confirmation: digest(
      JSON.stringify({
        trials,
        limits,
        tasks: tasks.map((task) => ({
          taskId: task.taskId,
          version: task.version,
          criteria: task.criteria,
          followUps: task.followUps ?? [],
        })),
      }),
    ).slice(0, 16),
    trials,
    limits,
    estimate,
  };
}
const savedText = (value: unknown): AgentText => {
  const input = record(value);
  if (
    typeof input["source"] !== "string" ||
    typeof input["text"] !== "string" ||
    input["sha256"] !== digest(input["text"])
  )
    throw new Error("Invalid saved agent text");
  return { source: input["source"], text: input["text"], sha256: input["sha256"] };
};
/** Decode a saved trial's planned identity, refusing text whose recorded SHA-256 does not match. */
export function plannedTrial(value: unknown): PlannedTrial {
  const input = record(value);
  const text = (key: string) => {
    const found = input[key];
    if (typeof found !== "string") throw new Error(`Invalid saved trial ${key}`);
    return found;
  };
  const id = text("id");
  if (/^[A-Za-z0-9-]+$/.test(id) === false) throw new Error("Invalid saved trial id");
  const seed = input["seed"];
  const followUps = input["followUps"];
  if (
    typeof seed !== "number" ||
    typeof followUps !== "number" ||
    Array.isArray(input["skills"]) === false
  )
    throw new Error("Invalid saved trial");
  return {
    id,
    stage: text("stage"),
    taskId: text("taskId"),
    profile: modelProfile(input["profile"]),
    arm: text("arm"),
    seed,
    prompt: savedText(input["prompt"]),
    skills: input["skills"].map((skill) => ({
      path: skillPath(String(record(skill)["path"])),
      ...savedText(skill),
    })),
    followUps,
    limits: trialLimits(input["limits"]),
  };
}
/** Derive pass and score from the same complete criterion evidence. */
export function scoreGrade(
  task: EvalTask,
  grade: Grade,
  outcome: ExecutionOutcome,
): { score: number; pass: boolean; excluded: boolean } {
  validateTask(task);
  if (
    grade.criteria.length !== task.criteria.length ||
    new Set(grade.criteria.map((criterion) => criterion.criterionId)).size !==
      grade.criteria.length ||
    grade.criteria.some(
      (criterion) =>
        task.criteria.some((expected) => expected.id === criterion.criterionId) === false,
    )
  )
    throw new Error("Grader did not return exactly the declared criteria");
  const criteria = task.criteria.map((criterion) => ({
    ...criterion,
    satisfied:
      grade.criteria.find((result) => result.criterionId === criterion.id)?.satisfied === true,
  }));
  return {
    score: criteria.reduce(
      (sum, criterion) => sum + (criterion.satisfied === true ? criterion.weight : 0),
      0,
    ),
    pass:
      outcome === "completed" &&
      grade.violatedInvariants.length === 0 &&
      criteria.every(
        (criterion) => criterion.requiredForPass === false || criterion.satisfied === true,
      ),
    excluded: [
      "auth-required",
      "setup-error",
      "protocol-error",
      "quota-limited",
      "cancelled",
      "unstarted",
    ].includes(outcome),
  };
}
