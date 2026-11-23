import { Schema } from "effect";
import { NextCommandsSchema } from "../hints/next-commands.ts";

/** A portable-content refusal, raised before authority is taken from untrusted bytes. */
export class BundleError extends Schema.TaggedError<BundleError>()("BundleError", {
  code: Schema.Literals([
    "profile-bundle-invalid",
    "profile-bundle-limit",
    "profile-bundle-sensitive",
    "profile-bundle-incomplete",
    "profile-bundle-identity",
    "profile-bundle-version",
    "profile-bundle-file-access-failed",
  ]),
  message: Schema.String,
  /** The file a `profile-bundle-file-access-failed` could not read or write. */
  path: Schema.optionalKey(Schema.String),
  /** The platform's reason for a `profile-bundle-file-access-failed`, such as `NotFound`. */
  reason: Schema.optionalKey(Schema.String),
  /** The filesystem call that failed, such as `stat` or `writeFile`. */
  operation: Schema.optionalKey(Schema.String),
  /** The commands the message names as the fix, as data the envelope's `next` is filled from. */
  next: Schema.optionalKey(NextCommandsSchema),
}) {}
