import { Schema } from "effect";

/**
 * The commands a failure names as its fix, each as the argv of a `tack` command line that starts
 * with `tack`, such as `["tack", "catalog"]`. A failure carries them as data beside its message, as a
 * doctor check carries its `next`, so the host fills the envelope's `next` without reading prose.
 */
export const NextCommandsSchema = Schema.Array(
  Schema.Array(Schema.String).check(Schema.isMinLength(1)),
);

/** Commands a failure names as its fix; see {@link NextCommandsSchema}. */
export type NextCommands = typeof NextCommandsSchema.Type;
