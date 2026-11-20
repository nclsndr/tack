import { describe, expect, it } from "vitest";
import type { RunFailure } from "../../domain/execution/execution-schema.ts";
import { resolveRunOutcome, type WorkerEvidence } from "./run-outcome.ts";

const protocolFailure: RunFailure = {
  stage: "worker",
  code: "protocol_failure",
  message: "The worker sent invalid private protocol traffic.",
  classification: "internal",
};
const watchdogFailure: RunFailure = {
  stage: "cleanup",
  code: "cleanup_failed",
  message: "The worker retained activity after finalization.",
  classification: "domain",
};
const loadFailure: RunFailure = {
  stage: "load",
  code: "module_load_failed",
  message: "The script module could not be loaded.",
  classification: "invalid-configuration",
};
const coreSuccess = {
  outcome: {
    stage: "output",
    code: "success",
    message: "The script completed.",
    classification: "success",
  },
  finalization: "complete",
} as const satisfies WorkerEvidence["core"];
const coreCleanupFailed = {
  outcome: {
    stage: "cleanup",
    code: "cleanup_failed",
    message: "The script did not complete successfully.",
    classification: "domain",
  },
  finalization: "complete",
} as const satisfies WorkerEvidence["core"];
const coreInterrupted = {
  outcome: {
    stage: "execution",
    code: "interrupted",
    message: "Interrupted.",
    classification: "interruption",
  },
  finalization: "complete",
} as const satisfies WorkerEvidence["core"];
const coreInputRejected = {
  outcome: {
    stage: "input",
    code: "invalid_input",
    message: "Invalid input.",
    classification: "invalid-configuration",
  },
  finalization: "not-started",
} as const satisfies WorkerEvidence["core"];
const retainedActivity: RunFailure = {
  stage: "cleanup",
  code: "cleanup_failed",
  message: "The worker left active child processes or inherited streams.",
  classification: "domain",
};
const timeout: RunFailure = {
  stage: "execution",
  code: "timeout",
  message: "The script exceeded its timeout.",
  classification: "domain",
};
const interrupted: RunFailure = {
  stage: "execution",
  code: "interrupted",
  message: "The script was interrupted by the operator.",
  classification: "interruption",
};
const unexpectedExit = (lastStage: string): RunFailure => ({
  stage: "worker",
  code: "unexpected_worker_exit",
  message: "The worker exited without a terminal outcome.",
  classification: "internal",
  details: { lastStage },
});
const quiet = { orphanedActivity: false, lastStage: "execution" } as const;

describe("supervised run outcome priority", () => {
  it.each<[string, WorkerEvidence, RunFailure, "complete" | "incomplete" | "not-started"]>([
    [
      "keeps the supervisor's own failure above every reported outcome",
      {
        ...quiet,
        failure: protocolFailure,
        core: coreCleanupFailed,
        workerFailure: loadFailure,
        termination: { reason: "timeout", forced: false },
      },
      protocolFailure,
      "complete",
    ],
    [
      "takes finalization from the core beside a non-cleanup supervisor failure",
      { ...quiet, failure: protocolFailure, core: coreInputRejected },
      protocolFailure,
      "not-started",
    ],
    [
      "reports a supervisor failure without core evidence as not started before execution",
      { orphanedActivity: false, lastStage: "worker", failure: protocolFailure },
      protocolFailure,
      "not-started",
    ],
    [
      "marks finalization incomplete when execution ended without core evidence",
      { ...quiet, failure: protocolFailure },
      protocolFailure,
      "incomplete",
    ],
    [
      "marks a supervisor cleanup failure incomplete even beside complete core finalization",
      { ...quiet, failure: watchdogFailure, core: coreSuccess },
      watchdogFailure,
      "incomplete",
    ],
    [
      "turns activity retained after a core outcome into a cleanup failure",
      { ...quiet, orphanedActivity: true, core: coreSuccess },
      retainedActivity,
      "incomplete",
    ],
    [
      "keeps the supervisor's own failure above retained activity",
      { ...quiet, orphanedActivity: true, core: coreSuccess, failure: protocolFailure },
      protocolFailure,
      "incomplete",
    ],
    [
      "keeps the initiated termination above retained activity",
      {
        ...quiet,
        orphanedActivity: true,
        core: coreInterrupted,
        termination: { reason: "timeout", forced: false },
      },
      timeout,
      "incomplete",
    ],
    [
      "reports retained activity without core evidence as an unexpected exit",
      { orphanedActivity: true, lastStage: "load" },
      unexpectedExit("load"),
      "incomplete",
    ],
    [
      "reports retained activity beside a worker failure as that failure",
      { orphanedActivity: true, lastStage: "load", workerFailure: loadFailure },
      loadFailure,
      "incomplete",
    ],
    [
      "keeps a core cleanup failure above the initiated timeout",
      { ...quiet, core: coreCleanupFailed, termination: { reason: "timeout", forced: false } },
      coreCleanupFailed.outcome,
      "complete",
    ],
    [
      "keeps a core cleanup failure above an operator interruption",
      {
        ...quiet,
        core: coreCleanupFailed,
        termination: { reason: "user-interruption", forced: false },
      },
      coreCleanupFailed.outcome,
      "complete",
    ],
    [
      "reports an unforced timeout above the core's interrupted outcome",
      { ...quiet, core: coreInterrupted, termination: { reason: "timeout", forced: false } },
      timeout,
      "complete",
    ],
    [
      "reports a forced operator interruption as incomplete",
      {
        ...quiet,
        core: coreInterrupted,
        termination: { reason: "user-interruption", forced: true },
      },
      interrupted,
      "incomplete",
    ],
    [
      "reports a termination that interrupted execution before a core outcome as incomplete",
      { ...quiet, termination: { reason: "timeout", forced: false } },
      timeout,
      "incomplete",
    ],
    [
      "reports a termination before execution as not started",
      {
        orphanedActivity: false,
        lastStage: "load",
        termination: { reason: "timeout", forced: false },
      },
      timeout,
      "not-started",
    ],
    [
      "keeps the initiated termination above a worker failure",
      {
        orphanedActivity: false,
        lastStage: "load",
        workerFailure: loadFailure,
        termination: { reason: "user-interruption", forced: false },
      },
      interrupted,
      "not-started",
    ],
    [
      "reports a worker failure before execution as not started",
      { orphanedActivity: false, lastStage: "load", workerFailure: loadFailure },
      loadFailure,
      "not-started",
    ],
    [
      "keeps a worker failure above a non-cleanup core outcome",
      { ...quiet, workerFailure: loadFailure, core: coreSuccess },
      loadFailure,
      "complete",
    ],
    [
      "reports the core outcome and its finalization",
      { ...quiet, core: coreSuccess },
      coreSuccess.outcome,
      "complete",
    ],
    [
      "reports a core outcome whose finalization never started",
      { ...quiet, core: coreInputRejected },
      coreInputRejected.outcome,
      "not-started",
    ],
    [
      "reports an exit without evidence at the last entered stage",
      { orphanedActivity: false, lastStage: "preflight" },
      unexpectedExit("preflight"),
      "not-started",
    ],
    [
      "reports an exit without evidence during execution as incomplete",
      quiet,
      unexpectedExit("execution"),
      "incomplete",
    ],
  ])("%s", (_name, evidence, outcome, finalization) => {
    expect(resolveRunOutcome(evidence)).toEqual({ outcome, finalization });
  });
});
