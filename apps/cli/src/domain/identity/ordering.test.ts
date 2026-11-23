import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { isInCodeUnitOrder, isSortedUnique, sortAndDedupeBy, sortedUnique } from "./ordering.ts";

describe("isInCodeUnitOrder", () => {
  it("accepts keys that never go down, repeats included", () => {
    expect(isInCodeUnitOrder([])).toBe(true);
    expect(isInCodeUnitOrder(["a", "a", "b"])).toBe(true);
    expect(isInCodeUnitOrder(["B", "a"])).toBe(true);
  });

  it("refuses keys that go down in code-unit order", () => {
    expect(isInCodeUnitOrder(["b", "a"])).toBe(false);
    expect(isInCodeUnitOrder(["a", "B"])).toBe(false);
  });
});

describe("isSortedUnique", () => {
  it("accepts keys that strictly increase in code-unit order", () => {
    expect(isSortedUnique([])).toBe(true);
    expect(isSortedUnique(["B", "a", "b"])).toBe(true);
  });

  it("refuses a repeated key and a key out of order", () => {
    expect(isSortedUnique(["a", "a"])).toBe(false);
    expect(isSortedUnique(["b", "a"])).toBe(false);
  });

  it("holds exactly for what sortAndDedupeBy returns", () => {
    const values = ["c", "a", "b", "a"];
    const canonical = sortAndDedupeBy(values, (value) => value);

    expect(isSortedUnique(canonical)).toBe(true);
    expect(isSortedUnique(values)).toBe(false);
  });
});

describe("sortedUnique", () => {
  const Paths = Schema.Array(Schema.Struct({ path: Schema.String }));
  const paths = (...values: ReadonlyArray<string>) => values.map((path) => ({ path }));

  it("reports one issue when the keys are repeated or out of order", () => {
    const decode = Schema.decodeUnknownSync(
      Paths.check(sortedUnique((item) => item.path, "Paths must be unique and sorted.")),
    );

    expect(decode(paths("a", "b"))).toEqual(paths("a", "b"));
    expect(() => decode(paths("a", "a"))).toThrow("Paths must be unique and sorted.");
    expect(() => decode(paths("b", "a"))).toThrow("Paths must be unique and sorted.");
  });

  it("reports a repeat and a disorder apart when given two messages", () => {
    const decode = Schema.decodeUnknownResult(
      Paths.check(
        sortedUnique((item) => item.path, {
          duplicate: "Paths must be unique.",
          unordered: "Paths must be sorted.",
        }),
      ),
    );
    const message = (values: ReadonlyArray<string>) => {
      const result = decode(paths(...values));
      return Result.isFailure(result) ? result.failure.message : "";
    };

    expect(message(["a", "b"])).toBe("");
    expect(message(["a", "a"])).toContain("Paths must be unique.");
    expect(message(["a", "a"])).not.toContain("Paths must be sorted.");
    expect(message(["b", "a"])).toContain("Paths must be sorted.");
    expect(message(["b", "a"])).not.toContain("Paths must be unique.");
    expect(message(["b", "a", "a"])).toContain("Paths must be unique.");
    expect(message(["b", "a", "a"])).toContain("Paths must be sorted.");
  });
});
