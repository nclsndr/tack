import { Effect, Schema } from "effect";
import { searchDocuments, type ReaderSearchQuery } from "@tackup/reader/search-core";
import { DocsResourceReferenceSchema } from "../../domain/docs/docs-schema.ts";
import { ReaderCorpus } from "../../services/reader-corpus.ts";
import {
  DocsSetupGapSchema,
  ReaderProjectSchema,
  ReaderResourceIssueSchema,
  resolveProjectDocsContext,
  type DocsSelector,
} from "../docs/docs-selection.ts";
import type { StateOptions } from "../../services/state-store.ts";

/** A physical range in a saved, authored file; lines are one-based and inclusive. */
const SourceReferenceSchema = Schema.Struct({
  path: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  kind: Schema.optionalKey(Schema.Literals(["data", "fragment", "implementation"])),
});

/** One matching document with its provenance and the text blocks that matched. */
const ReaderSearchHitSchema = Schema.Struct({
  document: Schema.Struct({
    path: Schema.String,
    relativePath: Schema.String,
    title: Schema.String,
    route: Schema.String,
    metadata: Schema.Struct({
      title: Schema.String,
      type: Schema.optionalKey(Schema.String),
      status: Schema.optionalKey(Schema.String),
      tags: Schema.Array(Schema.String),
      layout: Schema.optionalKey(Schema.String),
    }),
    resource: Schema.optionalKey(
      Schema.Struct({ ...DocsResourceReferenceSchema.fields, sourcePath: Schema.String }),
    ),
  }),
  score: Schema.Number,
  matches: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      version: Schema.String,
      source: SourceReferenceSchema,
      contributors: Schema.Array(SourceReferenceSchema),
      excerpt: Schema.String,
    }),
  ),
});

/**
 * The `docs search` payload: the ranked hits within the limit, and whether every attached
 * resource and document loaded.
 */
export const ReaderSearchPayloadSchema = Schema.Struct({
  kind: Schema.Literal("reader-search"),
  project: ReaderProjectSchema,
  complete: Schema.Boolean,
  issues: Schema.Array(ReaderResourceIssueSchema),
  setup: Schema.optionalKey(DocsSetupGapSchema),
  query: Schema.String,
  limit: Schema.Number,
  total: Schema.Number,
  truncated: Schema.Boolean,
  hits: Schema.Array(ReaderSearchHitSchema),
});

/** What one docs search reports. */
export type ReaderSearch = Omit<typeof ReaderSearchPayloadSchema.Type, "kind">;

/** Searches the registered project's attached resources with shared completeness and provenance. */
export const searchReader = Effect.fn("searchReader")(function* (
  options: StateOptions,
  request: ReaderSearchQuery & DocsSelector,
) {
  const { input, setup } = yield* resolveProjectDocsContext(options, request);
  const corpus = yield* (yield* ReaderCorpus).loadProject(input);
  const search: ReaderSearch = {
    project: input.project,
    // An empty setup has nothing to search, which is never complete coverage.
    complete: corpus.complete && setup === undefined,
    issues: corpus.issues,
    ...(setup === undefined ? {} : { setup }),
    ...searchDocuments(corpus.documents, request),
  };
  return search;
});
