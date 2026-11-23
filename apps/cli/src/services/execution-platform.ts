import { Context, Effect, Schema } from "effect";
import { classifyRunFailure, RunFailureSchema } from "../domain/execution/execution-schema.ts";
import type {
  HistoryIssue,
  HistoryRecord,
  HistorySummary,
  OperatorRunRequest,
  OperatorRunResult,
  RunFailure,
  ScriptDeclarations,
} from "../domain/execution/execution-schema.ts";

/** Carries only safe expected operational details across the host adapter boundary. */
export class ExecutionError extends Schema.TaggedError<ExecutionError>()("ExecutionError", {
  stage: RunFailureSchema.fields.stage,
  code: RunFailureSchema.fields.code,
  message: RunFailureSchema.fields.message,
  classification: RunFailureSchema.fields.classification,
  details: RunFailureSchema.fields.details,
}) {}

/** Builds an execution error whose classification is derived from its stage and code. */
export const executionError = (
  stage: ExecutionError["stage"],
  code: string,
  message: string,
  details?: Schema.Json,
) =>
  new ExecutionError({
    stage,
    code,
    message,
    classification: classifyRunFailure(stage, code),
    ...(details === undefined ? {} : { details }),
  });

export type WorkerExecution = {
  readonly result: OperatorRunResult;
  readonly diagnostics?: Schema.Json;
  /** What the script declares, when the request asked to describe it and the worker could. */
  readonly described?: ScriptDeclarations;
};

export type RunCancellation = {
  readonly signal: AbortSignal;
  readonly onRepeatSignal: (listener: () => void) => () => void;
  readonly close: () => void;
};

export type WorkerRequest = {
  readonly runId: string;
  readonly entrypoint: string;
  readonly cwd: string;
  readonly input: Schema.Json;
  /** The command-line words after `--`, which the worker reads against the script's arguments. */
  readonly words?: ReadonlyArray<string>;
  /** Load the script and report what it declares instead of running it. */
  readonly describe?: true;
  readonly stateDirectory: string;
  readonly timeoutMs?: number;
  readonly quiet?: boolean;
  readonly signal: AbortSignal;
  readonly onRepeatSignal?: (listener: () => void) => () => void;
};

/** Replaceable OS boundary for operator signals, input, package readiness, and fresh workers. */
export class ExecutionWorker extends Context.Service<
  ExecutionWorker,
  {
    readonly cancellation: () => Effect.Effect<RunCancellation>;
    readonly input: (
      request: OperatorRunRequest,
      signal?: AbortSignal,
    ) => Effect.Effect<Schema.Json, ExecutionError>;
    readonly packageReady: (
      sourcePath: string,
      entrypoint: string,
    ) => Effect.Effect<void, ExecutionError>;
    readonly worker: (request: WorkerRequest) => Effect.Effect<WorkerExecution, ExecutionError>;
  }
>()("tack/cli/services/execution-platform/ExecutionWorker") {}

/** Replaceable store of run records in the state directory. */
export class RunHistory extends Context.Service<
  RunHistory,
  {
    readonly createHistory: (
      directory: string,
      record: HistoryRecord,
    ) => Effect.Effect<void, ExecutionError>;
    readonly finishHistory: (
      directory: string,
      record: HistoryRecord,
    ) => Effect.Effect<void, ExecutionError>;
    /** Summarizes readable runs and names skipped record files, in no particular order. */
    readonly listHistory: (directory: string) => Effect.Effect<
      {
        readonly runs: ReadonlyArray<HistorySummary>;
        readonly issues: ReadonlyArray<HistoryIssue>;
      },
      ExecutionError
    >;
    readonly countHistory: (directory: string) => Effect.Effect<number, ExecutionError>;
    /** Reads one run, or nothing when no record has that identifier. */
    readonly showHistory: (
      directory: string,
      runId: string,
    ) => Effect.Effect<HistoryRecord | undefined, ExecutionError>;
    /** Removes retained record files without decoding them and returns the removed count. */
    readonly clearHistory: (directory: string) => Effect.Effect<number, ExecutionError>;
  }
>()("tack/cli/services/execution-platform/RunHistory") {}

/** Projects an operational adapter failure to the stable run outcome contract. */
export const executionFailureOutcome = (error: ExecutionError): RunFailure => ({
  stage: error.stage,
  code: error.code,
  message: error.message,
  classification: error.classification,
  ...(error.details === undefined ? {} : { details: error.details }),
});
