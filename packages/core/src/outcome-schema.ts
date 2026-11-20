import { Schema } from "effect";
import { copyJson, RunLimits, type JsonValue } from "./outcome.ts";

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const BoundedJson = Schema.declare<JsonValue>(
  (value): value is JsonValue => {
    try {
      return byteLength(JSON.stringify(copyJson(value))) <= RunLimits.boundaryBytes;
    } catch {
      return false;
    }
  },
  { description: "Plain JSON data within the script boundary byte limit" },
);
const Message = Schema.String.check(Schema.isMaxLength(4096));
const Diagnostic = Schema.Struct({
  kind: Schema.Literals(["Fail", "Die", "Interrupt"]),
  message: Message,
});
const Diagnostics = Schema.Array(Diagnostic).check(Schema.isMaxLength(200));
const Stage = Schema.Literals([
  "preflight",
  "input",
  "construction",
  "execution",
  "output",
  "cleanup",
]);
const FailureCode = Schema.Literals([
  "invalid_definition",
  "unsupported_contract",
  "unknown_capability",
  "missing_capability",
  "invalid_input",
  "input_too_large",
  "schema_defect",
  "construction_defect",
  "invalid_program",
  "expected_failure",
  "capability_failure",
  "executed_defect",
  "interrupted",
  "unexpected_failure",
  "invalid_expected_failure",
  "invalid_output",
  "boundary_too_large",
  "cleanup_failed",
]);
const primaryFailureStages: Readonly<
  Record<typeof FailureCode.Type, readonly (typeof Stage.Type)[]>
> = {
  invalid_definition: ["preflight"],
  unsupported_contract: ["preflight"],
  unknown_capability: ["preflight"],
  missing_capability: ["preflight"],
  invalid_input: ["input"],
  input_too_large: ["input"],
  schema_defect: ["input", "output", "execution"],
  construction_defect: ["construction"],
  invalid_program: ["construction"],
  expected_failure: ["execution"],
  capability_failure: ["execution"],
  executed_defect: ["execution"],
  interrupted: ["execution"],
  unexpected_failure: ["execution"],
  invalid_expected_failure: ["execution"],
  invalid_output: ["output"],
  boundary_too_large: ["output", "execution"],
  cleanup_failed: [],
};
const PrimaryFailure = Schema.Struct({
  status: Schema.Literal("failure"),
  stage: Stage,
  code: FailureCode,
  message: Message,
  diagnostics: Schema.optionalKey(Diagnostics),
  encoded: Schema.optionalKey(BoundedJson),
  encodedFailures: Schema.optionalKey(
    Schema.Array(BoundedJson).check(
      Schema.makeFilter((values) => byteLength(JSON.stringify(values)) <= RunLimits.boundaryBytes),
    ),
  ),
}).check(
  Schema.makeFilter((failure) => {
    if (!primaryFailureStages[failure.code].includes(failure.stage))
      return "Failure code does not belong to its stage.";
    if (
      failure.code === "expected_failure" &&
      (!Object.hasOwn(failure, "encoded") ||
        failure.encodedFailures === undefined ||
        failure.encodedFailures.length === 0)
    )
      return "Expected failure requires encoded domain failure values.";
    return true;
  }),
);
const Primary = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("success"),
    stage: Schema.Literal("output"),
    code: Schema.Literal("success"),
    encoded: BoundedJson,
  }),
  PrimaryFailure,
]);
const Finalization = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["not_started", "complete"]) }),
  Schema.Struct({ status: Schema.Literal("failed"), diagnostics: Diagnostics }),
]);
const Log = Schema.Struct({
  source: Schema.Literal("effect"),
  sequence: Schema.Natural.check(Schema.isGreaterThan(0)),
  timestamp: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value)),
    ),
  ),
  content: Schema.String.check(
    Schema.makeFilter((value) => byteLength(value) <= RunLimits.logEventBytes),
  ),
  level: Schema.Literals(["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"]),
});
const Truncation = Schema.Struct({
  reason: Schema.Literals(["event_bytes", "total_bytes", "event_count"]),
  observed: Schema.Natural,
  limit: Schema.Natural,
}).check(
  Schema.makeFilter((entry) => {
    const limit =
      entry.reason === "event_bytes"
        ? RunLimits.logEventBytes
        : entry.reason === "total_bytes"
          ? RunLimits.logBytes
          : RunLimits.logEvents;
    return entry.limit === limit && entry.observed > limit;
  }),
);

/** Validates the encoded core transport contract, including terminal-state agreement. */
export const EncodedRunOutcomeSchema = Schema.Struct({
  status: Schema.Literals(["success", "failure"]),
  stage: Stage,
  code: Schema.Union([Schema.Literal("success"), FailureCode]),
  primary: Primary,
  finalization: Finalization,
  encodedInput: Schema.optionalKey(BoundedJson),
  logs: Schema.Array(Log).check(Schema.isMaxLength(RunLimits.logEvents)),
  truncation: Schema.Array(Truncation).check(Schema.isMaxLength(3)),
}).check(
  Schema.makeFilter((outcome) => {
    if (outcome.finalization.status === "failed") {
      if (
        outcome.status !== "failure" ||
        outcome.stage !== "cleanup" ||
        outcome.code !== "cleanup_failed"
      )
        return "Failed finalization requires an outer cleanup failure.";
    } else if (
      outcome.status !== outcome.primary.status ||
      outcome.stage !== outcome.primary.stage ||
      outcome.code !== outcome.primary.code
    ) {
      return "Terminal status, stage and code must match the primary outcome.";
    }
    if (
      outcome.finalization.status === "not_started" &&
      (outcome.primary.status === "success" ||
        (outcome.primary.stage === "execution" && outcome.primary.code !== "interrupted") ||
        outcome.primary.stage === "output")
    )
      return "Executed outcomes require completed or failed finalization.";
    if (
      outcome.finalization.status !== "not_started" &&
      ["preflight", "input", "construction"].includes(outcome.primary.stage)
    )
      return "Pre-execution failures cannot have started finalization.";
    if (outcome.logs.some((log, index) => log.sequence !== index + 1))
      return "Log sequence must be contiguous and ordered.";
    if (
      outcome.logs.reduce((total, log) => total + byteLength(log.content), 0) > RunLimits.logBytes
    )
      return "Captured logs exceed their total byte limit.";
    if (new Set(outcome.truncation.map((entry) => entry.reason)).size !== outcome.truncation.length)
      return "Log truncation reasons must be unique.";
    return true;
  }),
);
export type EncodedRunOutcome = typeof EncodedRunOutcomeSchema.Type;
