import {
  runFailure,
  type OperatorRunResult,
  type RunFailure,
} from "../../domain/execution/execution-schema.ts";

/** Evidence the supervisor observed by the time a worker settles. */
export type WorkerEvidence = {
  /** A failure the supervisor detected itself: protocol, spawn, secret, or watchdog. */
  readonly failure?: RunFailure | undefined;
  /** The validated core outcome projection, when the worker reported one. */
  readonly core?:
    | {
        readonly outcome: RunFailure;
        readonly finalization: "complete" | "not-started";
      }
    | undefined;
  /** A load, preflight, or worker failure the worker reported instead of a core outcome. */
  readonly workerFailure?: RunFailure | undefined;
  /** The timeout or operator interruption the supervisor initiated. */
  readonly termination?: OperatorRunResult["termination"] | undefined;
  /** Whether descendants or inherited streams outlived the worker. */
  readonly orphanedActivity: boolean;
  /** The last protocol stage the worker entered. */
  readonly lastStage: string;
};

const retainedActivity: RunFailure = runFailure(
  "cleanup",
  "cleanup_failed",
  "The worker left active child processes or inherited streams.",
);
const terminated = (reason: NonNullable<OperatorRunResult["termination"]>["reason"]): RunFailure =>
  reason === "timeout"
    ? runFailure("execution", "timeout", "The script exceeded its timeout.")
    : runFailure("execution", "interrupted", "The script was interrupted by the operator.");

/** Outcome sources, highest priority first; the first one with evidence decides the outcome. */
const outcomePriority: ReadonlyArray<(evidence: WorkerEvidence) => RunFailure | undefined> = [
  // The supervisor's own observation: protocol, spawn, secret, or watchdog failure.
  (evidence) => evidence.failure,
  // Descendants or streams that outlived a core outcome the supervisor did not terminate.
  (evidence) =>
    evidence.orphanedActivity === true &&
    evidence.core !== undefined &&
    evidence.termination === undefined
      ? retainedActivity
      : undefined,
  // A cleanup failure the core reported, even after an initiated termination.
  (evidence) =>
    evidence.core?.outcome.code === "cleanup_failed" ? evidence.core.outcome : undefined,
  // The timeout or operator interruption the supervisor initiated.
  (evidence) =>
    evidence.termination === undefined ? undefined : terminated(evidence.termination.reason),
  // The worker's own load, preflight, or worker failure.
  (evidence) => evidence.workerFailure,
  // The core outcome.
  (evidence) => evidence.core?.outcome,
];

/**
 * Settles the public outcome and finalization evidence for one supervised worker. The outcome is
 * the first source in {@link outcomePriority} with evidence, otherwise an unexpected exit at the
 * last entered stage. Finalization is incomplete after a supervisor cleanup failure, a forced
 * termination, retained activity, or an execution that ended without a core outcome; otherwise
 * it is the core's finalization, or not started without one.
 */
export const resolveRunOutcome = (
  evidence: WorkerEvidence,
): { readonly outcome: RunFailure; readonly finalization: OperatorRunResult["finalization"] } => {
  const reported = outcomePriority.reduce<RunFailure | undefined>(
    (outcome, source) => outcome ?? source(evidence),
    undefined,
  );
  const incomplete =
    evidence.failure?.code === "cleanup_failed" ||
    evidence.termination?.forced === true ||
    evidence.orphanedActivity === true ||
    (evidence.core === undefined && evidence.lastStage === "execution");
  return {
    outcome:
      reported ??
      runFailure(
        "worker",
        "unexpected_worker_exit",
        "The worker exited without a terminal outcome.",
        {
          lastStage: evidence.lastStage,
        },
      ),
    finalization:
      incomplete === true ? "incomplete" : (evidence.core?.finalization ?? "not-started"),
  };
};
