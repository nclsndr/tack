import { Schema } from "effect";

/** A portable-content refusal, raised before authority is taken from untrusted bytes. */
export class BundleError extends Schema.TaggedError<BundleError>()("BundleError", {
  code: Schema.Literals([
    "profile-bundle-invalid",
    "profile-bundle-limit",
    "profile-bundle-sensitive",
    "profile-bundle-incomplete",
    "profile-bundle-identity",
    "profile-bundle-version",
  ]),
  message: Schema.String,
}) {}
