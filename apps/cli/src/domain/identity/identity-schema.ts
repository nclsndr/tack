import { Schema } from "effect";

/** A label safe to use as a structured Tack identity component. */
export const IdentifierSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);

/**
 * A portable lowercase name used by skills, commands, and source labels. The pattern carries the
 * `u` flag, which matches the same ASCII names, so a JSON Schema built from it keeps the pattern.
 */
export const PortableNameSchema = Schema.String.check(Schema.isMinLength(1))
  .check(Schema.isMaxLength(64))
  .check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u));

const absolutePathPattern = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const windowsVolumeRootPattern = /^[A-Za-z]:[\\/]$/;

/** Finds a `.` or `..` segment in one pass, without splitting every path that is validated. */
const dotSegmentPattern = /(?:^|[\\/])\.\.?(?:[\\/]|$)/;

const hasPathAlias = (path: string) => {
  const withoutUncPrefix = path.startsWith("\\\\") ? path.slice(2) : path;
  return (
    (path !== "/" && !windowsVolumeRootPattern.test(path) && /[\\/]$/.test(path)) ||
    /[\\/]{2,}/.test(withoutUncPrefix)
  );
};

/** A non-empty absolute path without unresolved dot segments. */
export const CanonicalPathSchema = Schema.String.check(Schema.isMinLength(1))
  .check(Schema.isPattern(absolutePathPattern))
  .check(
    Schema.makeFilter((path) =>
      dotSegmentPattern.test(path)
        ? ["Canonical paths must not contain unresolved dot segments."]
        : [],
    ),
  )
  .check(
    Schema.makeFilter((path) =>
      hasPathAlias(path) ? ["Canonical paths must not contain separator aliases."] : [],
    ),
  );
