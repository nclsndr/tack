import { Schema } from "effect";
import {
  SourceIssueSchema,
  SourceLabelIssueSchema,
  SourceRegistrationSchema,
  SourceWarningSchema,
  type SourceDeclaration,
  type SourceRegistration,
} from "./source-schema.ts";

/** Plain diagnostic data exposed by source inspection and catalog consumers. */
export type SourceIssue = typeof SourceIssueSchema.Type;

/** Where a source comes from when the operator did not register it: the release or a bundle. */
export const sourceOrigin = { origin: Schema.optionalKey(Schema.Literals(["builtin", "bundle"])) };

/** The label, maintainers and dependencies of one registered source, as `source` reports them. */
export const sourceLabelFacts = {
  label: Schema.optionalKey(Schema.String),
  labelOrigin: Schema.optionalKey(Schema.Literals(["declared", "derived", "none", "clashing"])),
  maintainers: Schema.optionalKey(Schema.Array(Schema.String)),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  labelIssues: Schema.optionalKey(Schema.Array(SourceLabelIssueSchema)),
  warnings: Schema.optionalKey(Schema.Array(SourceWarningSchema)),
};

/** A registered source whose declaration validated. */
export const HealthySourceInspectionSchema = Schema.Struct({
  ...sourceOrigin,
  ...sourceLabelFacts,
  registration: SourceRegistrationSchema,
  status: Schema.Literal("healthy"),
});

/** A registered source that could not be read or validated, with the issue that stopped it. */
export const UnhealthySourceInspectionSchema = Schema.Struct({
  ...sourceOrigin,
  ...sourceLabelFacts,
  issue: SourceIssueSchema,
  registration: SourceRegistrationSchema,
  status: Schema.Literal("unhealthy"),
});

/** The label, maintainers and dependencies of one registered source, as `source` reports them. */
type SourceLabelFacts = Omit<
  typeof HealthySourceInspectionSchema.Type,
  "origin" | "registration" | "status"
>;

/** The public health of one registered source. */
export type SourceInspection =
  | typeof HealthySourceInspectionSchema.Type
  | typeof UnhealthySourceInspectionSchema.Type;

/**
 * One source inspection that also retains the declaration a healthy source was validated with,
 * so catalog discovery consumes that exact declaration instead of reading `tack.yaml` again.
 */
export type DeclaredSourceInspection = {
  readonly origin?: "builtin" | "bundle";
} & SourceLabelFacts &
  (
    | {
        readonly declaration: SourceDeclaration;
        readonly registration: SourceRegistration;
        readonly status: "healthy";
      }
    | {
        readonly issue: SourceIssue;
        readonly registration: SourceRegistration;
        readonly status: "unhealthy";
      }
  );

/** A heads-up about a healthy source. */
export type SourceWarning = typeof SourceWarningSchema.Type;
