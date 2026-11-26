import { Schema } from "effect";
import { ResourceKindSchema, type ResourceKind } from "../resources/kinds.ts";

/** One problem found under a declaration, with the candidate it concerns when it has one. */
const DeclarationProblemSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  candidatePath: Schema.optionalKey(Schema.String),
});
type DeclarationProblem = typeof DeclarationProblemSchema.Type;

/**
 * What one declaration of a source's `tack.yaml` contributes: its kind, declared path, patterns,
 * the number of resources the catalog holds because of it, and every problem found under it.
 * Facts follow the order of the file, so an entry that did not decode still has a row.
 */
export const DeclarationFactsSchema = Schema.Struct({
  kind: ResourceKindSchema,
  /** The declared path, absent when the entry has none. */
  path: Schema.optionalKey(Schema.String),
  /** The declared name of a scripts or docs entry. */
  name: Schema.optionalKey(Schema.String),
  include: Schema.optionalKey(Schema.Array(Schema.String)),
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  resources: Schema.Number,
  problems: Schema.Array(DeclarationProblemSchema),
});
export type DeclarationFacts = typeof DeclarationFactsSchema.Type;

/** A declaration while discovery runs: problems are added as candidates are found and parsed. */
export type DeclarationRecord = Omit<DeclarationFacts, "resources" | "problems"> & {
  readonly problems: Array<DeclarationProblem>;
};

/** Starts the record of one declaration entry, with no problem yet. */
export const declarationRecord = (
  kind: ResourceKind,
  facts: Omit<DeclarationFacts, "kind" | "resources" | "problems">,
): DeclarationRecord => ({ kind, ...facts, problems: [] });

/** Closes a record into facts once the catalog knows how many resources it contributed. */
export const declarationFacts = (
  record: DeclarationRecord,
  resources: number,
): DeclarationFacts => ({ ...record, resources });

/**
 * Whether a source's declarations load nothing because each one has a problem: every declaration
 * contributes no resource and reports at least one problem. A source that declares nothing does
 * not count: `source-declares-no-resources` already warns about it.
 */
export const loadsNothing = (
  declarations: ReadonlyArray<{
    readonly resources: number;
    readonly problems: ReadonlyArray<unknown>;
  }>,
) =>
  declarations.length > 0 &&
  declarations.every(
    (declaration) => declaration.resources === 0 && declaration.problems.length > 0,
  );
