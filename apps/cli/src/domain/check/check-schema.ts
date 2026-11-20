import { Schema } from "effect";
import { NextCommandsSchema } from "../hints/next-commands.ts";
import { compareCodeUnits } from "../identity/ordering.ts";

/** One authoring finding, always anchored to a physical file and a one-based line. */
const CheckFindingSchema = Schema.Struct({
  code: Schema.String,
  severity: Schema.Literals(["error", "warning"]),
  file: Schema.String,
  line: Schema.Number,
  message: Schema.String,
  remedy: Schema.optionalKey(Schema.String),
  /** The commands the remedy names, which the check's `next` lists. */
  next: Schema.optionalKey(NextCommandsSchema),
});
export type CheckFinding = typeof CheckFindingSchema.Type;

/** A checked input or discovered source-owned file; details explain the observed inventory. */
const CheckItemSchema = Schema.Struct({
  kind: Schema.Literals(["source", "profile", "bundle", "docs", "path"]),
  path: Schema.String,
  details: Schema.Array(Schema.String),
});
export type CheckItem = typeof CheckItemSchema.Type;

/** One combined read-only report. Its exit status and displayed counts share these findings. */
export const CheckReportSchema = Schema.Struct({
  kind: Schema.Literal("check-report"),
  checks: Schema.Array(CheckItemSchema),
  findings: Schema.Array(CheckFindingSchema),
  summary: Schema.Struct({
    checked: Schema.Number,
    errors: Schema.Number,
    warnings: Schema.Number,
  }),
});
export type CheckReport = typeof CheckReportSchema.Type;

/** Folds overlapping inputs once and derives every count from the resulting report. */
export const makeCheckReport = (
  items: ReadonlyArray<CheckItem>,
  findings: ReadonlyArray<CheckFinding>,
): CheckReport => {
  const checks = [...new Map(items.map((item) => [`${item.kind}:${item.path}`, item])).values()];
  const unique = [
    ...new Map(
      findings.map((finding) => [
        JSON.stringify([
          finding.file,
          finding.line,
          finding.code,
          finding.severity,
          finding.message,
        ]),
        finding,
      ]),
    ).values(),
  ].sort(
    (a, b) =>
      compareCodeUnits(a.file, b.file) ||
      a.line - b.line ||
      compareCodeUnits(a.code, b.code) ||
      compareCodeUnits(a.message, b.message),
  );
  return {
    kind: "check-report",
    checks,
    findings: unique,
    summary: {
      checked: checks.length,
      errors: unique.filter((finding) => finding.severity === "error").length,
      warnings: unique.filter((finding) => finding.severity === "warning").length,
    },
  };
};
