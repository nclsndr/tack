import type { evalPrompts } from "@tackup/harness/prompts/evals";

/** Provider-independent task/grader contract. Trusted code runs on the host; agent commands run only in Docker. */
export type CommandRequest = {
  argv: readonly string[];
  /** Absolute container path under /world. */
  cwd: string;
};
export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  executions?: readonly (CommandRequest & { exitCode: number; stdout: string; stderr: string })[];
};
export type CommandEvidence = CommandRequest & CommandResult;
export const executionOutcomes = [
  "completed",
  "timed-out",
  "limit-reached",
  "cancelled",
  "auth-required",
  "quota-limited",
  "setup-error",
  "protocol-error",
  "unstarted",
] as const;
export type ExecutionOutcome = (typeof executionOutcomes)[number];
export type TaskContext = {
  seed: number;
  /** Host path to a fresh world. All fixture files must stay below it. Mounted at /world. */
  world: string;
  /** Execute trusted setup, oracle, or observation argv in the networkless task container. */
  exec: (request: CommandRequest) => Promise<CommandResult>;
};
export type PreparedTask = {
  /** Container path under /world, never a host path. */
  cwd: string;
  /** The task's request, which the trial's prompt template places at `{{request}}`. */
  request: string;
  /** Public facts only. Hidden expected values stay in the host-side closure. */
  publicFacts: Readonly<Record<string, string>>;
};
/**
 * What one trial may spend. `maxTurns` and `budgetUsd` pass to the native CLI, which enforces
 * them; a driver that cannot enforce one refuses a trial that sets it.
 */
export type TrialLimits = {
  wallSeconds: number;
  /** Bridged task commands the agent may run. */
  toolCalls: number;
  /** Combined native transcript and command output bytes. */
  outputBytes: number;
  /** Native agentic turns across the whole conversation. */
  maxTurns?: number;
  /** API-equivalent USD the native CLI may spend before it stops. */
  budgetUsd?: number;
};
/** Tasks that share limits; a campaign can tighten or widen a family's limits for one run. */
export type TaskFamily = { id: string; limits: TrialLimits };
type Criterion = {
  id: string;
  weight: number;
  requiredForPass: boolean;
};
type CriterionResult = {
  criterionId: string;
  satisfied: boolean | "unknown";
  evidence: readonly string[];
};
export type Grade = {
  criteria: readonly CriterionResult[];
  violatedInvariants: readonly string[];
};
type GradeContext = TaskContext & {
  prepared: PreparedTask;
  commands: readonly CommandEvidence[];
  finalAnswer: string;
  outcome: ExecutionOutcome;
};
export type EvalTask = {
  taskId: string;
  version: number;
  title: string;
  difficulty: "easy" | "medium" | "hard";
  /** Selection labels: a campaign stage or `--tag` runs only the tasks that carry one. */
  tags: readonly string[];
  /** The id of the suite family whose limits this task runs under. */
  family: string;
  /** The harness prompt a trial starts from unless its arm overrides it. Defaults to `task`. */
  prompt?: keyof typeof evalPrompts;
  /**
   * The user's later messages, sent in order, each after the agent ends its previous turn. They
   * are fixed: no responder reads the agent's reply.
   */
  followUps?: readonly string[];
  criteria: readonly Criterion[];
  /** Prepare fresh state and prove its initial conditions; never start an agent. */
  prepare: (context: TaskContext) => Promise<PreparedTask>;
  /** Observe final state independently of provider event formats. */
  grade: (context: GradeContext) => Promise<Grade>;
  /** Replay a known solution in a separate fresh world before any paid launch. */
  oracle: (
    context: TaskContext,
    prepared: PreparedTask,
  ) => Promise<{
    commands: readonly CommandEvidence[];
    finalAnswer: string;
  }>;
};
export type TaskSuite = {
  contractVersion: 2;
  families: readonly TaskFamily[];
  tasks: readonly EvalTask[];
};
