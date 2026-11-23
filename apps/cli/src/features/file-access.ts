import type { PlatformError } from "effect";

/** What one failed filesystem call touched and why it failed, in terms an operator can act on. */
export type FileAccessFailure = {
  /** The path the call named, or the caller's own path when the call reported none. */
  readonly path: string;
  /** The platform's reason, such as `NotFound` or `PermissionDenied`. */
  readonly reason: string;
  /** The filesystem call that failed, such as `stat` or `writeFile`. */
  readonly operation: string;
  /** The reason as a clause that completes "… cannot be read:". */
  readonly explanation: string;
};

const explanations: { readonly [reason: string]: string } = {
  AlreadyExists: "it already exists",
  BadArgument: "the path is not valid",
  Busy: "it is busy",
  NotFound: "it does not exist",
  PermissionDenied: "permission is denied",
};

/**
 * Reads the path, reason and failed call out of a raw filesystem failure, so a feature can report
 * it as its own typed error instead of letting it reach the host as an internal failure.
 */
export const fileAccessFailure = (
  error: PlatformError.PlatformError,
  fallbackPath: string,
): FileAccessFailure => {
  const reason = error.reason;
  const named =
    reason._tag === "BadArgument" || reason.pathOrDescriptor === undefined
      ? undefined
      : String(reason.pathOrDescriptor);
  return {
    path: named ?? fallbackPath,
    reason: reason._tag,
    operation: reason.method,
    explanation:
      explanations[reason._tag] ??
      (reason.description === undefined || reason.description.length === 0
        ? `the system reported ${reason._tag}`
        : reason.description),
  };
};
