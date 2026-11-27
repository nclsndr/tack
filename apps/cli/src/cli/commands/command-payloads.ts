/** The payload schemas of the results the CLI itself produces: help pages and explorer sessions. */
import { Schema } from "effect";
import { MutationModeSchema } from "./operation-contract.ts";

/** One positional operand, in declaration order. */
export const CommandArgumentSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** The value type, such as `string` or `choice`. */
  type: Schema.String,
  required: Schema.Boolean,
  variadic: Schema.Boolean,
});

/** One accepted flag, spelled `--<name>`. */
export const CommandFlagSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** The value type: `boolean` flags take no value; `choice` flags list their `choices`. */
  type: Schema.String,
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
  required: Schema.Boolean,
});

const CommandExampleSchema = Schema.Struct({
  command: Schema.String,
  description: Schema.optionalKey(Schema.String),
});

/** A titled block of `term  meaning` rows, such as what each status value means. */
const HelpNoteSchema = Schema.Struct({
  title: Schema.String,
  rows: Schema.Array(Schema.Struct({ term: Schema.String, text: Schema.String })),
});

/** The grammar of one command path. */
export const CommandGrammarFields = {
  /** The words after `tack`; empty for the root. */
  commandPath: Schema.Array(Schema.String),
  usage: Schema.String,
  description: Schema.String,
  /** Whether the path itself is an operation; a pure group only lists subcommands. */
  executable: Schema.Boolean,
  /** How the operation changes state, present when `executable`. */
  mutation: Schema.optionalKey(MutationModeSchema),
  arguments: Schema.Array(CommandArgumentSchema),
  flags: Schema.Array(CommandFlagSchema),
  examples: Schema.Array(CommandExampleSchema),
  /** Extra blocks the help page prints after the flags; omitted when a command has none. */
  notes: Schema.optionalKey(Schema.Array(HelpNoteSchema)),
};

/** The `help` result: the grammar of one command path and its direct subcommands. */
export const HelpPayloadSchema = Schema.Struct({
  kind: Schema.Literal("help"),
  ...CommandGrammarFields,
  subcommands: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.String, executable: Schema.Boolean }),
  ),
});

/** A help result. */
export type HelpPayload = typeof HelpPayloadSchema.Type;

/** The typed result of one explorer session; edits are reported inside the session. */
export const ExploreSessionSchema = Schema.Struct({
  kind: Schema.Literal("explore-session"),
});
