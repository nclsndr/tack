import { Schema } from "effect";
import { ResourceKindSchema } from "../resources/kinds.ts";
import { SourceLabelSchema } from "../sources/source-schema.ts";
import { PortableNameSchema } from "../identity/identity-schema.ts";

/** Bundle versions evolve independently of source, profile and local state versions. */
const bundleVersion = 1;
export { BundleFileSchema } from "../sources/bundle-facts.ts";
import { BundleDigestSchema, BundleFileSchema } from "../sources/bundle-facts.ts";
/** Portable resource inventory and current-content provenance, not a revision lock. */
const BundleResourceSchema = Schema.Struct({
  kind: ResourceKindSchema,
  name: Schema.String,
  path: Schema.String,
  direct: Schema.Boolean,
  provenance: Schema.optionalKey(
    Schema.Struct({
      location: Schema.String,
      revision: Schema.String,
      upstreamPath: Schema.String,
      importedDigest: Schema.String,
      currentDigest: BundleDigestSchema,
    }),
  ),
});
const BundleSourceSchema = Schema.Struct({
  key: PortableNameSchema,
  name: Schema.optionalKey(SourceLabelSchema),
  bindings: Schema.Record(SourceLabelSchema, PortableNameSchema),
  resources: Schema.Array(BundleResourceSchema),
  prerequisites: Schema.Array(Schema.String),
});
const manifestFields = {
  version: Schema.Literal(bundleVersion),
  profile: Schema.Struct({
    sourceKey: PortableNameSchema,
    name: PortableNameSchema,
    path: Schema.String,
  }),
  sources: Schema.Array(BundleSourceSchema),
  files: Schema.Array(BundleFileSchema),
};
export const BundleContentSchema = Schema.Struct(manifestFields);
export const BundleManifestSchema = Schema.Struct({
  ...manifestFields,
  identity: BundleDigestSchema,
});
export type BundleContent = typeof BundleContentSchema.Type;
export type BundleManifest = typeof BundleManifestSchema.Type;
