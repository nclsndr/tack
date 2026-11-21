import { Option, Schema } from "effect";
import { Flag } from "effect/cli";

/** Creates a repeat-safe boolean CLI flag. */
export const booleanFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => values.length === 1 && values[0] === true),
    Flag.withDescription(description),
  );

/**
 * Accepts a flag at most once, yielding `undefined` when it is absent. The outer `Flag.optional`
 * keeps the flag documented as optional; `Flag.atMost` alone would be reported as required.
 */
export const optionalFlag = <A>(flag: Flag.Flag<A>, description: string) =>
  Flag.optional(flag.pipe(Flag.atMost(1))).pipe(
    Flag.map((values) => Option.getOrUndefined(values)?.[0]),
    Flag.withDescription(description),
  );

/** Accepts a whole-number flag at most once, documented with the `integer` value type. */
export const optionalIntegerFlag = (
  name: string,
  bounds: { readonly minimum: number; readonly maximum: number },
  description: string,
) =>
  optionalFlag(
    Flag.String(name).pipe(
      Flag.withSchema(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween(bounds))),
      Flag.withMetavar("integer"),
    ),
    description,
  );

/** Accepts a string flag at most once, yielding `undefined` when it is absent. */
export const optionalStringFlag = (name: string, description: string) =>
  optionalFlag(Flag.String(name), description);

/** A repeatable string flag, documented as optional, that yields the values it was given in order. */
export const repeatableStringFlag = (name: string, description: string) =>
  // `Flag.optional` keeps the repeatable flag documented as optional.
  Flag.optional(Flag.String(name).pipe(Flag.atLeast(0))).pipe(
    // Coverage skip: Flag.atLeast(0) always yields a list, so the empty fallback never runs.
    /* v8 ignore next -- @preserve */
    Flag.map((values): ReadonlyArray<string> => Option.getOrElse(values, () => [])),
    Flag.withDescription(description),
  );
