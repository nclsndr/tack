import { Schema } from "effect";
import { NamespaceSchema } from "../choices/choice-schema.ts";

/**
 * One namespace's sources skill as `sync` and `status` report it: the `SKILL.md` Tack writes in its
 * state directory, the hash of the inputs it is rendered from, and whether the copy on disk is that
 * text (`current`), another one (`stale`), or absent (`missing`). A sync rewrites a stale or missing
 * copy before it links it.
 */
export const SourcesSkillReportSchema = Schema.Struct({
  namespace: NamespaceSchema,
  path: Schema.String,
  inputs: Schema.String,
  state: Schema.Literals(["current", "stale", "missing"]),
});

/** One namespace's sources skill, as `sync` and `status` report it. */
export type SourcesSkillReport = typeof SourcesSkillReportSchema.Type;
