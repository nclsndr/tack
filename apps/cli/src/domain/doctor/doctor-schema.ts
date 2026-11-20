import { Schema } from "effect";

/** The stable ID of each health check, one per area `doctor` observes. */
const DoctorCheckIdSchema = Schema.Literals([
  "release",
  "state",
  "profiles",
  "profile-definitions",
  "adapters",
  "sources",
  "imports",
  "projects",
  "links",
  "docs",
  "unregistered-dependency-source",
]);

/**
 * What one observation found. A warning or a skip needs no action and keeps the exit status at 0;
 * a failed check is a problem the operator can act on.
 */
const DoctorOutcomeSchema = Schema.Literals(["ok", "warning", "failed", "skipped"]).annotate({
  description:
    "ok: nothing to do. warning: worth a look, exit status stays 0. skipped: not observable yet, such as a check that needs state. failed: a problem to fix; the command exits 1.",
});

/** One read-only observation: its outcome, why, and the exact command that addresses a problem. */
const DoctorCheckSchema = Schema.Struct({
  id: DoctorCheckIdSchema,
  outcome: DoctorOutcomeSchema,
  message: Schema.String.annotate({ description: "What the check found, in one sentence." }),
  /** Who or what the check is about, such as project names, in code-unit order. */
  subjects: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * The command that addresses the first observed cause, as an argv array. It is a preview
   * unless the operation is immediate, carries its own selector, and never guesses `--all`.
   */
  next: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMinLength(1)).annotate({
      description:
        "The command that addresses the cause, as an argv array that starts with `tack`. A preview unless the operation is immediate.",
    }),
  ),
});
export type DoctorCheck = typeof DoctorCheckSchema.Type;

/** How many checks ended with each outcome. */
const DoctorSummarySchema = Schema.Struct({
  ok: Schema.Number,
  warning: Schema.Number,
  failed: Schema.Number,
  skipped: Schema.Number,
  total: Schema.Number,
});

/** The machine-wide health report; it records what was observed and changes nothing. */
export const DoctorReportSchema = Schema.Struct({
  kind: Schema.Literal("doctor-report"),
  release: Schema.Struct({ stamp: Schema.String, sourceRun: Schema.Boolean }),
  stateDirectory: Schema.String,
  summary: DoctorSummarySchema,
  checks: Schema.Array(DoctorCheckSchema),
}).check(
  Schema.makeFilter((report) => {
    const counts = (outcome: typeof DoctorOutcomeSchema.Type) =>
      report.checks.filter((check) => check.outcome === outcome).length;
    return report.summary.total === report.checks.length &&
      report.summary.ok === counts("ok") &&
      report.summary.warning === counts("warning") &&
      report.summary.failed === counts("failed") &&
      report.summary.skipped === counts("skipped")
      ? []
      : ["The summary must count the report's checks."];
  }),
);
export type DoctorReport = typeof DoctorReportSchema.Type;
