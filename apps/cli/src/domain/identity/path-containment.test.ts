import { expect, it } from "@effect/vitest";
import { isInside, isStrictlyInside } from "./path-containment.ts";

it.each<[string, string, string, boolean, boolean]>([
  ["the folder itself", "/root/a", "/root/a", true, false],
  ["a direct child", "/root/a", "/root/a/b", true, true],
  ["a nested descendant", "/root/a", "/root/a/b/c", true, true],
  ["a child named ..x", "/root/a", "/root/a/..x", true, true],
  ["the parent folder", "/root/a", "/root", false, false],
  ["a sibling sharing the name prefix", "/root/a", "/root/ab", false, false],
  ["a sibling folder", "/root/a", "/root/b", false, false],
  ["a sibling named ..x", "/root/a", "/root/..x", false, false],
  ["an unrelated tree", "/root/a", "/elsewhere/a", false, false],
])("classifies %s", (_, parent, child, inside, strictlyInside) => {
  expect(isInside(parent, child)).toBe(inside);
  expect(isStrictlyInside(parent, child)).toBe(strictlyInside);
});
