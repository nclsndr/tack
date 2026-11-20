import { Schema } from "effect";
import type { TargetSelector } from "../projects/project-schema.ts";
import { ScriptAddressSchema } from "../sources/catalog-schema.ts";

/** One argument a script declares, as `defineScript` takes it. */
const ArgumentDeclarationSchema = Schema.Struct({
  type: Schema.Literals(["string", "number", "boolean"]),
  description: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(Schema.Json),
  optional: Schema.optionalKey(Schema.Boolean),
  multiple: Schema.optionalKey(Schema.Boolean),
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
});
/** What a loaded script declares: its arguments by name and its secret names. */
export const ScriptDeclarationsSchema = Schema.Struct({
  args: Schema.Record(Schema.String, ArgumentDeclarationSchema),
  secrets: Schema.Array(Schema.String),
});
export type ScriptDeclarations = typeof ScriptDeclarationsSchema.Type;
/** The `script show` payload: where a script lives and what it declares, arguments in declaration order. */
export const ScriptShowPayloadSchema = Schema.Struct({
  kind: Schema.Literal("script-show"),
  address: ScriptAddressSchema,
  description: Schema.String,
  filePath: Schema.String,
  sourcePath: Schema.String,
  arguments: Schema.Array(
    Schema.Struct({ name: Schema.String, ...ArgumentDeclarationSchema.fields }),
  ),
  secrets: Schema.Array(Schema.String),
});

/** Limits shared by transport, execution, and local evidence. */
export const executionLimits = {
  inputBytes: 1024 * 1024,
  valueBytes: 1024 * 1024,
  eventBytes: 64 * 1024,
  logBytes: 10 * 1024 * 1024,
  logEvents: 10000,
  graceMs: 5000,
} as const;
const RunLogSchema = Schema.Struct({
  source: Schema.Literals(["stdout", "stderr", "script", "shell", "supervisor"]),
  sequence: Schema.Number,
  timestamp: Schema.String,
  content: Schema.String,
});
export type RunLog = typeof RunLogSchema.Type;
const RunStageSchema = Schema.Literals([
  "invocation",
  "resolution",
  "load",
  "preflight",
  "input",
  "construction",
  "execution",
  "output",
  "cleanup",
  "worker",
  "history",
]);
export const RunFailureSchema = Schema.Struct({
  stage: RunStageSchema,
  code: Schema.String,
  message: Schema.String,
  classification: Schema.Literals([
    "success",
    "domain",
    "invalid-invocation",
    "invalid-configuration",
    "persistence",
    "internal",
    "interruption",
  ]),
  details: Schema.optionalKey(Schema.Json),
});
export type RunFailure = typeof RunFailureSchema.Type;
type RunStage = RunFailure["stage"];
type RunClassification = RunFailure["classification"];
/** Script, cleanup, timeout, and lock outcomes that are domain results rather than faults. */
const domainCodes: ReadonlySet<string> = new Set([
  "expected_failure",
  "capability_failure",
  "cleanup_failed",
  "invalid_output",
  "invalid_expected_failure",
  "boundary_too_large",
  "timeout",
  "state_busy",
]);
/** Stages whose failures come from operator configuration, sources, or declared boundaries. */
const configurationStages: ReadonlySet<RunStage> = new Set([
  "resolution",
  "load",
  "preflight",
  "input",
]);

/**
 * Classifies one run failure from its stage and code. This is the only classification rule for
 * operator runs: success and interruption first, then domain codes, persistence, invocation, and
 * configuration stages; everything else is internal.
 */
export const classifyRunFailure = (stage: RunStage, code: string): RunClassification => {
  if (code === "success") return "success";
  if (code === "interrupted") return "interruption";
  if (domainCodes.has(code)) return "domain";
  if (stage === "history" || code === "state_storage_failed") return "persistence";
  if (stage === "invocation") return "invalid-invocation";
  if (configurationStages.has(stage)) return "invalid-configuration";
  return "internal";
};

/** Builds a run failure whose classification is derived from its stage and code. */
export const runFailure = (
  stage: RunStage,
  code: string,
  message: string,
  details?: Schema.Json,
): RunFailure => ({
  stage,
  code,
  message,
  classification: classifyRunFailure(stage, code),
  ...(details === undefined ? {} : { details }),
});
export const RunResultSchema = Schema.Struct({
  runId: Schema.String,
  outcome: RunFailureSchema,
  core: Schema.optionalKey(Schema.Json),
  logs: Schema.Array(RunLogSchema),
  logTruncation: Schema.Struct({
    truncated: Schema.Boolean,
    observedBytes: Schema.Number,
    observedEvents: Schema.Number,
    reasons: Schema.Array(Schema.String),
  }),
  finalization: Schema.Literals(["complete", "incomplete", "not-started"]),
  termination: Schema.optionalKey(
    Schema.Struct({
      reason: Schema.Literals(["timeout", "user-interruption"]),
      forced: Schema.Boolean,
    }),
  ),
});
export type OperatorRunResult = typeof RunResultSchema.Type;
/** One exact operator run; input-source conflicts are recorded as attempts. */
export type OperatorRunRequest = {
  readonly address: typeof ScriptAddressSchema.Type;
  readonly selector: TargetSelector;
  readonly cwd?: string;
  readonly root?: string;
  readonly targetConflict?: boolean;
  readonly inputJson?: string;
  readonly inputFile?: string;
  readonly inputStdin?: boolean;
  /** The command-line words after `--`: the script's arguments, read by the worker. */
  readonly words?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly quiet?: boolean;
};
/** The target a run executed in, as its history record keeps it: a project root or the user. */
export const RunTargetSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("project-root"),
    canonicalPath: Schema.String,
    projectName: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.Literal("user"), canonicalPath: Schema.String }),
]);
/** The target a run executed in, as its history record keeps it: a project root or the user. */
export type RunTarget = typeof RunTargetSchema.Type;
export const HistoryRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.String,
  status: Schema.Literals(["pending", "complete"]),
  startedAt: Schema.String,
  finishedAt: Schema.optionalKey(Schema.String),
  address: ScriptAddressSchema,
  originalInput: Schema.optionalKey(Schema.Json),
  /** The command-line words after `--` the run was given, in place of JSON input. */
  originalWords: Schema.optionalKey(Schema.Array(Schema.String)),
  target: Schema.optionalKey(Schema.Json),
  result: Schema.optionalKey(RunResultSchema),
  diagnostics: Schema.optionalKey(Schema.Json),
}).check(
  Schema.makeFilter((record) =>
    record.status === "pending"
      ? record.result === undefined && record.finishedAt === undefined
        ? []
        : ["Pending history cannot contain terminal fields."]
      : record.result !== undefined &&
          record.finishedAt !== undefined &&
          record.result.runId === record.runId
        ? []
        : ["Completed history requires its matching terminal result and finish time."],
  ),
);
export type HistoryRecord = typeof HistoryRecordSchema.Type;

/** Storage-safe run identifier grammar: 36 lowercase hexadecimal digits or hyphens, no folding. */
export const isHistoryRunId = (runId: string) => /^[a-f0-9-]{36}$/.test(runId);
/** Bounds for one `history list` page. */
export const historyListBounds = { defaultLimit: 20, maximumLimit: 100 } as const;
/** A compact projection of one retained run; `history show` keeps the full record. */
const HistorySummarySchema = Schema.Struct({
  runId: Schema.String,
  status: HistoryRecordSchema.fields.status,
  address: ScriptAddressSchema,
  startedAt: Schema.String,
  finishedAt: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(
    Schema.Struct({
      code: RunFailureSchema.fields.code,
      classification: RunFailureSchema.fields.classification,
    }),
  ),
});
export type HistorySummary = typeof HistorySummarySchema.Type;
/** A retained record file that listing skipped, named by path without its raw content. */
const HistoryIssueSchema = Schema.Struct({
  path: Schema.String,
  reason: Schema.Literals(["unreadable", "invalid", "invalid-name", "run-id-mismatch"]),
});
export type HistoryIssue = typeof HistoryIssueSchema.Type;
/** The `script history` payload: one page of readable runs, newest first; `total` counts every readable retained record. */
export const HistoryListPayloadSchema = Schema.Struct({
  kind: Schema.Literal("run-history"),
  runs: Schema.Array(HistorySummarySchema),
  total: Schema.Number,
  offset: Schema.Number,
  limit: Schema.Number,
  truncated: Schema.Boolean,
  issues: Schema.Array(HistoryIssueSchema),
});
/** One page of retained runs, as `script history` lists it. */
export type HistoryList = Omit<typeof HistoryListPayloadSchema.Type, "kind">;

/** Projects the listing fields of one validated record without input, logs, or diagnostics. */
export const summarizeHistory = (record: HistoryRecord): HistorySummary => ({
  runId: record.runId,
  status: record.status,
  address: record.address,
  startedAt: record.startedAt,
  ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
  ...(record.result === undefined
    ? {}
    : {
        outcome: {
          code: record.result.outcome.code,
          classification: record.result.outcome.classification,
        },
      }),
});
