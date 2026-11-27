import { describe, expect, it } from "@effect/vitest";
import { kindAndNameKey } from "./choice-schema.ts";

describe("kindAndNameKey", () => {
  it("gives resources of one kind and name one key, whatever their source", () => {
    const fromOne = { sourceRegistrationId: "one", kind: "skill", name: "review" };
    const fromTwo = { sourceRegistrationId: "two", kind: "skill", name: "review" };
    expect(kindAndNameKey(fromOne)).toBe(kindAndNameKey(fromTwo));
  });

  it.each([
    [
      { kind: "skill", name: "review" },
      { kind: "command", name: "review" },
    ],
    [
      { kind: "skill", name: "review" },
      { kind: "skill", name: "reviews" },
    ],
  ])("keeps %o apart from %o", (left, right) => {
    expect(kindAndNameKey(left)).not.toBe(kindAndNameKey(right));
  });
});
