import { Context } from "effect";
import type { GzipCodec } from "../domain/bundles/tar.ts";

/** The gzip codec profile bundles are written and read with. */
export class Compression extends Context.Service<Compression, GzipCodec>()(
  "tack/cli/Compression",
) {}
