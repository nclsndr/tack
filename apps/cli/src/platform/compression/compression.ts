import { gunzipSync, gzipSync } from "node:zlib";
import { Layer } from "effect";
import type { GzipCodec } from "../../domain/bundles/tar.ts";
import { Compression } from "../../services/compression.ts";

/** Node's zlib as the bundle gzip codec. */
export const nodeGzip: GzipCodec = {
  gzip: (bytes) => gzipSync(bytes),
  gunzip: (bytes, maxOutputLength) => gunzipSync(bytes, { maxOutputLength }),
};

/** Provides Node's zlib as the bundle gzip codec. */
export const CompressionLive = Layer.succeed(Compression, nodeGzip);
