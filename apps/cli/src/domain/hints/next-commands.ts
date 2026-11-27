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

/** `tack sync --project demo`; a word is quoted only when a shell would otherwise split or expand it. */
export const shellWord = (word: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** A whole argument vector as one shell line, such as a doctor check's `next`. */
export const argvLine = (argv: ReadonlyArray<string>): string => argv.map(shellWord).join(" ");
