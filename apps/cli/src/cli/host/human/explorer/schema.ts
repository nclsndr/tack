import { Schema } from "effect";

/** The typed result of one explorer session; edits are reported inside the session. */
export const ExploreSessionSchema = Schema.Struct({
  kind: Schema.Literal("explore-session"),
});
