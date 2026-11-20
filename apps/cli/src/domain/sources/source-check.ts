import { Schema } from "effect";

/** A local authoring finding with declaration and resource locations. */
export const SourceFindingSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  severity: Schema.Literals(["warning", "error"]),
  file: Schema.String,
  field: Schema.optionalKey(Schema.String),
  candidatePath: Schema.optionalKey(Schema.String),
});
export type SourceFinding = typeof SourceFindingSchema.Type;

/** Counts of usable resources, using the same discovery as catalog. */
const SourceCountsSchema = Schema.Struct({
  skill: Schema.Number,
  command: Schema.Number,
  context: Schema.Number,
  script: Schema.Number,
  docs: Schema.Number,
});

/** Read-only inspection of one source, independent of Tack state. */
export const SourceCheckReportSchema = Schema.Struct({
  kind: Schema.Literal("source-check"),
  sourcePath: Schema.String,
  counts: SourceCountsSchema,
  findings: Schema.Array(SourceFindingSchema),
});
export type SourceCheckReport = typeof SourceCheckReportSchema.Type;
