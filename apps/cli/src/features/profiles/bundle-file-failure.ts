import type { PlatformError } from "effect";
import { BundleError } from "../../domain/bundles/bundle-error.ts";
import { fileAccessFailure } from "../file-access.ts";

/** How to make a bundle, for a bundle file that cannot be read. */
const exportHelp = ["tack", "profile", "export", "--help"];

/** A bundle file the operator named cannot be read: the path, the reason and how to write one. */
export const bundleInputFailure = (file: string) => (error: PlatformError.PlatformError) => {
  const failure = fileAccessFailure(error, file);
  return new BundleError({
    code: "profile-bundle-file-access-failed",
    message: `Bundle file ${failure.path} cannot be read: ${failure.explanation}. Check the path, or run \`${exportHelp.join(" ")}\` to see how to write a bundle.`,
    path: failure.path,
    reason: failure.reason,
    operation: failure.operation,
    next: [exportHelp],
  });
};

/** A file a bundle command reads or writes, other than the bundle itself, cannot be accessed. */
export const bundleFileFailure = (fallbackPath: string) => (error: PlatformError.PlatformError) => {
  const failure = fileAccessFailure(error, fallbackPath);
  return new BundleError({
    code: "profile-bundle-file-access-failed",
    message: `Tack could not access ${failure.path}: ${failure.explanation}.`,
    path: failure.path,
    reason: failure.reason,
    operation: failure.operation,
  });
};
