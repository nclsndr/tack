import { Schema } from "effect";
import { AgentAdapterIdSchema } from "../links/agent-adapter-schema.ts";

/**
 * What a hand-made entry is on disk: a folder, a file, a symbolic link Tack has no record of, an
 * entry of another type such as a socket, or one that could not be read.
 */
const HandMadeEntryTypeSchema = Schema.Literals([
  "directory",
  "file",
  "symlink",
  "special",
  "unreadable",
]);

/**
 * One entry in an agent's skill or command folder that Tack holds no record of: the operator or
 * another tool made it. Tack reports it and leaves it untouched; it never moves, adopts or blocks
 * on it.
 */
export const HandMadeEntrySchema = Schema.Struct({
  adapter: AgentAdapterIdSchema,
  kind: Schema.Literals(["skill", "command"]).annotate({
    description: "The folder it was found in: the adapter's skill folder or its command folder.",
  }),
  path: Schema.String.annotate({ description: "The absolute path of the entry." }),
  entry: HandMadeEntryTypeSchema,
});

/** One entry Tack did not make in an agent folder; see {@link HandMadeEntrySchema}. */
export type HandMadeEntry = typeof HandMadeEntrySchema.Type;
