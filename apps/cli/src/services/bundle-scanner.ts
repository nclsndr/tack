import { Context } from "effect";
import type { BundleReference } from "../domain/bundles/bundle-reference.ts";

/** What a profile bundle check needs to read the code and documents it packs. */
export type BundleScannerShape = {
  /**
   * The module names the runtime provides without a package, such as `fs` and `node:fs`; a
   * bundle's code may import them without declaring a package.
   */
  readonly builtinModules: ReadonlyArray<string>;
  /** The modules and files one file refers to, read statically; it throws on unreadable syntax. */
  readonly references: (file: string, text: string) => ReadonlyArray<BundleReference>;
};

/** Reads bundled code and documents for the modules and files they refer to. */
export class BundleScanner extends Context.Service<BundleScanner, BundleScannerShape>()(
  "tack/cli/BundleScanner",
) {}
