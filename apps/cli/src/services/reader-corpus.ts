import { Context, Effect, Schema } from "effect";
import type { ReaderProjectInput } from "@tackup/reader/search-core";
import type { FigureCheckReport } from "@tackup/reader/figure-check";

/** Reports configuration and saved-source read errors before search can produce results. */
export class ReaderSearchError extends Schema.TaggedError<ReaderSearchError>()(
  "ReaderSearchError",
  {
    kind: Schema.Literals(["configuration", "read"]),
    message: Schema.String,
  },
) {}

/** A shared registered-project corpus result, derived from the package loader. */
export type ReaderProjectCorpus = Awaited<
  ReturnType<typeof import("@tackup/reader/search").loadProjectCorpus>
>;

/** A path given to the figure check is missing (`path`), or a document could not be read (`read`). */
export class FigureCheckError extends Schema.TaggedError<FigureCheckError>()("FigureCheckError", {
  kind: Schema.Literals(["path", "read"]),
  message: Schema.String,
}) {}

export type ReaderCorpusService = {
  readonly loadProject: (
    input: ReaderProjectInput,
  ) => Effect.Effect<ReaderProjectCorpus, ReaderSearchError>;
  /** Checks the figures of documents and folders of documents, without a browser. */
  readonly checkFigures: (
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<FigureCheckReport, FigureCheckError>;
};

/** Saved project documents load independently from the browser lifecycle. */
export class ReaderCorpus extends Context.Service<ReaderCorpus, ReaderCorpusService>()(
  "tack/cli/services/reader-corpus/ReaderCorpus",
) {}
