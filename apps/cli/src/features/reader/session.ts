import { Schema } from "effect";
import { ReaderProjectSchema } from "../docs/docs-selection.ts";

/** The `docs serve` payload: the URL a ready reader serves the project's attached docs on. */
export const ReaderSessionPayloadSchema = Schema.Struct({
  kind: Schema.Literal("reader-session"),
  url: Schema.String,
  project: ReaderProjectSchema,
});
