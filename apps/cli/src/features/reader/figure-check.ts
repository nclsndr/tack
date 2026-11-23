import { Effect } from "effect";
import { ReaderCorpus } from "../../services/reader-corpus.ts";

/** Checks the figures of the given documents and docs folders, as the reader would list them. */
export const checkDocsFigures = Effect.fn("reader.checkDocsFigures")(function* (
  paths: ReadonlyArray<string>,
) {
  return yield* (yield* ReaderCorpus).checkFigures(paths);
});
