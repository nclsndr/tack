import { Effect, FileSystem, Stream } from "effect";
import { BundleError } from "../../domain/bundles/bundle-error.ts";
import { bundleLimits } from "../../domain/bundles/tar.ts";

/** Bounded reads also protect against a file growing between stat and read. */
export const readBoundedBundleFile = Effect.fnUntraced(function* (
  file: string,
  maximum = bundleLimits.fileBytes,
) {
  const fs = yield* FileSystem.FileSystem;
  const chunks = yield* Stream.runCollect(fs.stream(file, { bytesToRead: maximum + 1 }));
  const bytes = Buffer.concat(chunks);
  if (bytes.length > maximum)
    return yield* new BundleError({
      code: "profile-bundle-limit",
      message: `${file} exceeds the bounded bundle read limit.`,
    });
  return bytes;
});
