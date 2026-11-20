import { Crypto, Effect, FileSystem, Layer, Path } from "effect";
import { builtInSource } from "../../release.ts";
import { makeSourceService, Source } from "./source.ts";

/** Provides source inspection and registration identities over live platform services. */
export const SourceLive = Layer.effect(
  Source,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const canonicalPath = yield* fs
      .realPath(builtInSource.canonicalPath)
      .pipe(Effect.catch(() => Effect.succeed(builtInSource.canonicalPath)));
    return makeSourceService(yield* Crypto.Crypto, fs, yield* Path.Path, [
      { ...builtInSource, canonicalPath },
    ]);
  }),
);
