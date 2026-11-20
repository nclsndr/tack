import { builtinModules } from "node:module";
import { Layer } from "effect";
import { BundleScanner, type BundleScannerShape } from "../../services/bundle-scanner.ts";
import { bundleReferences } from "./bundle-references.ts";

/** Node's and Bun's built-in modules, and the JavaScript, HTML and MDX parsers of the scan. */
export const nodeBundleScanner: BundleScannerShape = {
  builtinModules: [...builtinModules, ...builtinModules.map((name) => `node:${name}`), "bun"],
  references: bundleReferences,
};

/** Provides the Node bundle scanner. */
export const BundleScannerLive = Layer.succeed(BundleScanner, nodeBundleScanner);
