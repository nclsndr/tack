import { Schema } from "effect";

export const BundleDigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
/** Exact bytes and ordinary permission bits; no sender identity or ownership is carried. */
export const BundleFileSchema = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
  size: Count,
  mode: Count.check(Schema.isLessThanOrEqualTo(0o777)),
  sha256: BundleDigestSchema,
});
