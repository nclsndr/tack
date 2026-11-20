import { Schema } from "effect";
import { CanonicalPathSchema } from "../identity/identity-schema.ts";

/** A read-only classification of one prospective managed destination. */
export const DestinationObservationSchema = Schema.Union([
  Schema.TaggedStruct("absent", { destinationPath: CanonicalPathSchema }),
  Schema.TaggedStruct("entry", {
    destinationPath: CanonicalPathSchema,
    entryType: Schema.Literals(["file", "directory", "special"]),
  }),
  Schema.TaggedStruct("relative-link", {
    canonicalTarget: CanonicalPathSchema,
    destinationPath: CanonicalPathSchema,
    rawTarget: Schema.String,
  }),
  Schema.TaggedStruct("unresolved-relative-link", {
    destinationPath: CanonicalPathSchema,
    message: Schema.String,
    rawTarget: Schema.String,
  }),
  Schema.TaggedStruct("absolute-link", {
    destinationPath: CanonicalPathSchema,
    rawTarget: Schema.String,
  }),
  Schema.TaggedStruct("access-failed", {
    destinationPath: CanonicalPathSchema,
    message: Schema.String,
    operation: Schema.Literals(["read-link", "resolve-link-target", "stat"]),
  }),
]);

/** One JSON-safe destination observation. */
export type DestinationObservation = typeof DestinationObservationSchema.Type;
