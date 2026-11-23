import { Effect, FileSystem, Schema } from "effect";
import { readBoundedBundleFile } from "../sources/bundle-file-read.ts";
import { decodeBundle } from "../../domain/bundles/bundle-codec.ts";
import { BundleError } from "../../domain/bundles/bundle-error.ts";
import { BundleManifestSchema } from "../../domain/bundles/bundle-schema.ts";
import { bundleLimits } from "../../domain/bundles/tar.ts";
import { Compression } from "../../services/compression.ts";

/** Reads and validates a bounded artifact in memory before any extraction or recipient mutation. */
export const readBundleArchive = Effect.fn("profiles.readBundleArchive")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (Number((yield* fs.stat(file)).size) > bundleLimits.compressedBytes)
    return yield* new BundleError({
      code: "profile-bundle-limit",
      message: "Bundle exceeds the compressed input limit.",
    });
  const bytes = yield* readBoundedBundleFile(file, bundleLimits.compressedBytes);
  const codec = yield* Compression;
  return yield* Effect.try({
    try: () => decodeBundle(codec, bytes),
    catch: (error) =>
      error instanceof BundleError
        ? error
        : new BundleError({ code: "profile-bundle-invalid", message: String(error) }),
  });
});

/** The `profile inspect-bundle` payload: the artifact path and its manifest, read without checks. */
export const BundleInspectionPayloadSchema = Schema.Struct({
  kind: Schema.Literal("profile-bundle-inspection"),
  file: Schema.String,
  manifest: BundleManifestSchema,
});
