import { Effect, Layer, Predicate } from "effect";
import {
  Reader,
  ReaderStartupError,
  type ReaderOptions,
  type ReaderService,
} from "../../services/reader.ts";
import { currentVersionReport } from "../../version.ts";

/** Promise boundary supplied by Tack's reader runtime. */
export type ReaderStarter = (options: ReaderOptions & { readonly signal: AbortSignal }) => Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly closed?: Promise<void>;
}>;

/** Adapts the reader engine without leaking its diagnostics into JSON stdout. */
export const makeReaderService = (start: ReaderStarter): ReaderService => ({
  start: (options) =>
    Effect.tryPromise({
      try: (signal) => start({ ...options, signal }),
      catch: (error) =>
        new ReaderStartupError({
          kind:
            Predicate.isObject(error) &&
            (error["name"] === "ReaderConfigurationError" ||
              error["_tag"] === "ReaderConfigurationError")
              ? "configuration"
              : Predicate.isObject(error) && error["name"] === "ReaderPortInUseError"
                ? "port-in-use"
                : "engine",
          message: error instanceof Error ? error.message : "The reader engine could not start.",
        }),
    }).pipe(
      Effect.map((session) => ({
        url: session.url,
        close: Effect.promise(() => session.close()),
        ...(session.closed === undefined
          ? {}
          : {
              closed: Effect.tryPromise({
                try: () => session.closed ?? Promise.resolve(),
                catch: (error) =>
                  new ReaderStartupError({
                    kind: "engine",
                    message:
                      error instanceof Error
                        ? error.message
                        : "The reader engine stopped unexpectedly.",
                  }),
              }),
            }),
      })),
    ),
});

/** Loads the reader only for reader invocations, telling it which Tack release serves it. */
export const ReaderLive = Layer.succeed(
  Reader,
  makeReaderService(async (options) => {
    const { startReader } = await import("@tackup/reader/server");
    return startReader({
      ...options,
      version: currentVersionReport().stamp,
      diagnostic: (message: string) => {
        process.stderr.write(message);
      },
    });
  }),
);
