import { type PlatformError, Schema } from "effect";
import { NextCommandsSchema, type NextCommands } from "../../domain/hints/next-commands.ts";
import { fileAccessFailure } from "../file-access.ts";

/** Stable reasons an import operation fails for the operator, each with a message that names the fix. */
const importErrorCodes = [
  "import-location-invalid",
  "import-selection-required",
  "import-selection-unknown",
  "import-candidate-not-importable",
  "import-no-candidates",
  "import-ref-ambiguous",
  "import-ref-not-found",
  "import-not-found",
  "import-destination-required",
  "import-destination-invalid",
  "import-records-invalid",
  "import-write-failed",
  "import-removal-blocked",
  "import-staging-conflict",
] as const;

/** Reports a rejected import request or an import state that cannot proceed. */
export class ImportError extends Schema.TaggedError<ImportError>()("ImportError", {
  code: Schema.Literals(importErrorCodes),
  message: Schema.String,
  /** JSON-safe facts that help repair the request, such as the names that do exist. */
  details: Schema.optionalKey(Schema.Json),
  /** The commands the message names as the fix, as data the envelope's `next` is filled from. */
  next: Schema.optionalKey(NextCommandsSchema),
}) {}

/**
 * An import failure with its repair facts made JSON-safe, and the commands its message names as
 * the fix.
 */
export const importFailure = (
  code: ImportError["code"],
  message: string,
  details?: Readonly<Record<string, unknown>>,
  next?: NextCommands,
) =>
  new ImportError({
    code,
    message,
    ...(details === undefined ? {} : { details: JSON.parse(JSON.stringify(details)) }),
    ...(next === undefined ? {} : { next }),
  });

/**
 * A file an import reads or writes cannot be accessed: the path the failed call touched, the
 * platform's reason and the call, as the repair facts of an `import-write-failed`.
 */
export const importFileFailure = (fallbackPath: string) => (error: PlatformError.PlatformError) => {
  const failure = fileAccessFailure(error, fallbackPath);
  return importFailure(
    "import-write-failed",
    `Tack could not access ${failure.path}: ${failure.explanation}.`,
    { path: failure.path, reason: failure.reason, operation: failure.operation },
  );
};
