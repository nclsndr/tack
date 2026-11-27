import { Schema } from "effect";
import { booleanFlag } from "./flag-utils.ts";

/** Apply flag shared by mutating command families. */
export const applyFlag = booleanFlag("apply", "Apply the planned changes");

/**
 * Mutation modes published by help and command discovery: `preview-apply` changes nothing without
 * `--apply`; `immediate` persists at once.
 */
export const MutationModeSchema = Schema.Literals([
  "read-only",
  "immediate",
  "preview-apply",
  "execute",
  "conditional",
]);

/** How an operation changes state. */
export type MutationMode = typeof MutationModeSchema.Type;
