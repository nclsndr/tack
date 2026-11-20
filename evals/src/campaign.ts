import type {
  CommandEvidence,
  EvalTask,
  ExecutionOutcome,
  Grade,
  PreparedTask,
  TaskContext,
  TaskSuite,
} from "./contract.ts";
import { digest, scoreGrade, type CampaignPlan, type PlannedTrial } from "./plan.ts";

export type Fixture = { context: TaskContext; close: () => Promise<void> };
type AgentExecution = {
  outcome: ExecutionOutcome;
  finalAnswer: string;
  commands: readonly CommandEvidence[];
  /** API-equivalent USD the native CLI reported, or `null` when it reported none. */
  costUsd: number | null;
  metadata: Readonly<Record<string, unknown>>;
};
export type TrialResult = PlannedTrial & {
  outcome: ExecutionOutcome;
  score: number | null;
  pass: boolean;
  excluded: boolean;
  grade: Grade | null;
  execution: AgentExecution | null;
  error: string | null;
};
export type CampaignBackend = {
  /** A fresh world for the trial's task and seed, carrying the built-in skills its arm delivers. */
  fixture: (trial: PlannedTrial, task: EvalTask, purpose: "oracle" | "agent") => Promise<Fixture>;
  launch: (
    trial: PlannedTrial,
    task: EvalTask,
    fixture: Fixture,
    prepared: PreparedTask,
    signal: AbortSignal,
  ) => Promise<AgentExecution>;
  record: (result: TrialResult) => Promise<void>;
};
const emptyResult = (trial: PlannedTrial): TrialResult => ({
  ...trial,
  outcome: "unstarted",
  score: null,
  pass: false,
  excluded: true,
  grade: null,
  execution: null,
  error: null,
});
/** A fixture depends on the task, the seed and the built-in skills the trial's arm delivers. */
const fixtureKey = (trial: PlannedTrial) =>
  `${trial.taskId}:${trial.seed}:${digest(JSON.stringify(trial.skills))}`;
/**
 * Prove all fixtures before paid launches; run once per cell and retain unstarted cells. Stops
 * launching once the reported spend reaches the campaign budget; a trial that reports no cost is
 * charged its own budget.
 */
export async function executeCampaign(options: {
  plan: CampaignPlan;
  suite: TaskSuite;
  confirmation: string;
  backend: CampaignBackend;
  signal?: AbortSignal;
}): Promise<TrialResult[]> {
  const { plan, suite, backend } = options;
  if (options.confirmation !== plan.confirmation)
    throw new Error(`Explicit campaign confirmation required: ${plan.confirmation}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted === true) controller.abort();
  const timer = setTimeout(() => controller.abort(), plan.limits.wallSeconds * 1000);
  const results: TrialResult[] = [];
  let spentUsd = 0;
  try {
    const proven = new Set<string>();
    for (const trial of plan.trials) {
      if (controller.signal.aborted === true) break;
      const key = fixtureKey(trial);
      if (proven.has(key) === true) continue;
      const task = suite.tasks.find((candidate) => candidate.taskId === trial.taskId);
      if (task === undefined) throw new Error(`Missing task ${trial.taskId}`);
      const fixture = await backend.fixture(trial, task, "oracle");
      try {
        const prepared = await task.prepare(fixture.context);
        const oracle = await task.oracle(fixture.context, prepared);
        const grade = await task.grade({
          ...fixture.context,
          prepared,
          ...oracle,
          outcome: "completed",
        });
        if (scoreGrade(task, grade, "completed").pass === false)
          throw new Error(`Oracle failed for ${key}: ${JSON.stringify(grade)}`);
        proven.add(key);
      } finally {
        await fixture.close();
      }
    }
    for (const trial of plan.trials) {
      let result = emptyResult(trial);
      const budget = plan.limits.budgetUsd;
      if (budget !== null && spentUsd >= budget) {
        result = {
          ...result,
          error: `Campaign budget reached: $${spentUsd.toFixed(2)} of $${budget.toFixed(2)}`,
        };
        await backend.record(result);
      } else if (controller.signal.aborted === false) {
        const task = suite.tasks.find((candidate) => candidate.taskId === trial.taskId);
        // Coverage skip: the oracle pass above already refused every trial whose task is missing.
        /* v8 ignore next -- @preserve */
        if (task === undefined) throw new Error(`Missing task ${trial.taskId}`);
        let fixture: Fixture | undefined;
        try {
          fixture = await backend.fixture(trial, task, "agent");
          const prepared = await task.prepare(fixture.context);
          if (controller.signal.aborted === false) {
            const execution = await backend.launch(
              trial,
              task,
              fixture,
              prepared,
              controller.signal,
            );
            spentUsd += execution.costUsd ?? trial.limits.budgetUsd ?? 0;
            const grade = await task.grade({
              ...fixture.context,
              prepared,
              commands: execution.commands,
              finalAnswer: execution.finalAnswer,
              outcome: execution.outcome,
            });
            result = {
              ...trial,
              ...scoreGrade(task, grade, execution.outcome),
              outcome: execution.outcome,
              grade,
              execution,
              error: null,
            };
          }
        } catch (error) {
          result = { ...result, outcome: "setup-error", error: String(error) };
          controller.abort();
        } finally {
          // Save evidence before removing the container; the world is retained for regrading.
          try {
            await backend.record(result);
          } finally {
            await fixture?.close();
          }
        }
      } else {
        await backend.record(result);
      }
      results.push(result);
    }
    return results;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
