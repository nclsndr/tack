import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { CanonicalPathSchema } from "./identity-schema.ts";

/** The segment test the schema used before it was made a single pattern. */
const hasDotSegment = (path: string) =>
  path.split(/[\\/]/).some((segment) => segment === "." || segment === "..");

const isCanonical = Schema.is(CanonicalPathSchema);

it("accepts absolute paths and rejects dot segments and separator aliases", () => {
  for (const path of [
    "/",
    "/a/b",
    "/a/.b/c.d",
    "/a/.../b",
    "C:\\a\\b",
    "C:/a/b",
    "\\\\server\\share\\a",
  ]) {
    expect(isCanonical(path), path).toBe(true);
  }
  for (const path of [
    "",
    "a/b",
    "/a/./b",
    "/a/../b",
    "/a/b/.",
    "/a/b/..",
    "C:\\a\\..\\b",
    "/a//b",
    "/a/b/",
  ]) {
    expect(isCanonical(path), path).toBe(false);
  }
});

it.effect.prop(
  "rejects a dot segment exactly when splitting the path finds one",
  { segments: Schema.Array(Schema.Literals([".", "..", "...", "a", ".b", "b.", "c:"])) },
  ({ segments }) =>
    Effect.sync(() => {
      for (const separator of ["/", "\\"]) {
        const path = `/${segments.join(separator)}`;
        const withoutAliases = path.replaceAll(/[\\/]{2,}/g, separator).replace(/(.)[\\/]$/, "$1");
        const expected = !hasDotSegment(withoutAliases);
        expect(isCanonical(withoutAliases), withoutAliases).toBe(expected);
      }
    }),
  { arbitrary: { runs: 300 } },
);
