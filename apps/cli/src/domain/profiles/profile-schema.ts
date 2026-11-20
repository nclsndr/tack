import { Schema } from "effect";
import { PortableNameSchema } from "../identity/identity-schema.ts";
import { ResourceKindSchema } from "../resources/kinds.ts";
import { ResourceAddressSchema } from "../sources/catalog-schema.ts";
import { SourceLabelSchema } from "../sources/source-schema.ts";

/** A portable source-owned member; a bare name always means the profile's own source. */
const ProfileMemberSchema = Schema.Union([
  Schema.String.check(Schema.isMinLength(1)),
  Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1)),
    kind: Schema.optionalKey(ResourceKindSchema),
    source: Schema.optionalKey(SourceLabelSchema),
  }),
]);
export type ProfileMember = typeof ProfileMemberSchema.Type;

/** The independently versioned positive manifest, with no activation or selection rules. */
export const ProfileSchema = Schema.Struct({
  version: Schema.Literal(1),
  name: PortableNameSchema,
  "depends-on": Schema.optionalKey(Schema.Array(SourceLabelSchema)),
  members: Schema.Array(ProfileMemberSchema),
});
export type Profile = typeof ProfileSchema.Type;

/** Explicit publication of one profile file by a version-2 source declaration. */
export const ProfilePublicationSchema = Schema.Struct({
  name: PortableNameSchema,
  path: Schema.String,
});
export type ProfilePublication = typeof ProfilePublicationSchema.Type;

/** Why a profile or bundle workflow refuses or qualifies its plan: a code and a message. */
export const ProfilePlanFindingSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
export type ProfilePlanFinding = typeof ProfilePlanFindingSchema.Type;

/** An authorable failure with a location and an actionable repair. */
const ProfileFindingSchema = Schema.Struct({
  code: Schema.String,
  category: Schema.Literals(["structure", "linkage"]),
  severity: Schema.Literals(["error", "warning"]),
  message: Schema.String,
  remedy: Schema.String,
  file: Schema.String,
  field: Schema.optionalKey(Schema.String),
  candidates: Schema.optionalKey(Schema.Array(ResourceAddressSchema)),
});
export type ProfileFinding = typeof ProfileFindingSchema.Type;

/** One read-only inventory, shared by the checker and profile authoring. */
const ProfileCheckReportSchema = Schema.Struct({
  kind: Schema.Literal("profile-check"),
  sourcePath: Schema.String,
  profileName: Schema.String,
  structural: Schema.Literals(["valid", "invalid"]),
  linkage: Schema.Literals(["complete", "incomplete", "unchecked"]),
  direct: Schema.Array(ResourceAddressSchema),
  required: Schema.Array(ResourceAddressSchema),
  findings: Schema.Array(ProfileFindingSchema),
});
export type ProfileCheckReport = typeof ProfileCheckReportSchema.Type;
