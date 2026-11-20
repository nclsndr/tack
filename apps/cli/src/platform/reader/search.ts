import { Effect, Layer } from "effect";
import {
  FigureCheckError,
  ReaderCorpus,
  ReaderSearchError,
  type ReaderCorpusService,
  type ReaderProjectCorpus,
} from "../../services/reader-corpus.ts";
import type { ReaderProjectInput } from "@tackup/reader/search-core";
import type { FigureCheckReport } from "@tackup/reader/figure-check";

export type ReaderCorpusLoaders = {
  readonly loadProject: (input: ReaderProjectInput) => Promise<ReaderProjectCorpus>;
  readonly checkFigures: (paths: ReadonlyArray<string>) => Promise<FigureCheckReport>;
};

/** A path that does not exist is the caller's mistake; anything else is a failed read. */
const figureCheckError = (error: unknown) =>
  new FigureCheckError({
    kind:
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
        ? "path"
        : "read",
    message: error instanceof Error ? error.message : "The documents could not be checked.",
  });

const readError = (error: unknown) =>
  new ReaderSearchError({
    kind:
      error instanceof Error && error.name === "ReaderConfigurationError"
        ? "configuration"
        : "read",
    message:
      error instanceof Error ? error.message : "The saved reader corpus could not be loaded.",
  });

/** Preserves reader diagnostics while exposing lazy, typed configuration and corpus operations. */
export const makeReaderCorpusService = (loaders: ReaderCorpusLoaders): ReaderCorpusService => ({
  loadProject: (input) =>
    Effect.tryPromise({ try: () => loaders.loadProject(input), catch: readError }),
  checkFigures: (paths) =>
    Effect.tryPromise({ try: () => loaders.checkFigures(paths), catch: figureCheckError }),
});

/** Lazily loads the shared resource-isolated corpus for agent search. */
export const ReaderCorpusLive = Layer.succeed(
  ReaderCorpus,
  makeReaderCorpusService({
    loadProject: async (input) => {
      const { loadProjectCorpus } = await import("@tackup/reader/search");
      // Search reads plain Markdown, so a broken render module must not hide a hit.
      return loadProjectCorpus(input, { renderModules: "skip" });
    },
    checkFigures: async (paths) => {
      const { checkFigures } = await import("@tackup/reader/figure-check");
      return checkFigures(paths);
    },
  }),
);
