import { expect, it } from "@effect/vitest";
import { resourceCountText } from "../src/cli/host/human/catalog.ts";

const counts = [0, 1, 2];

it("pluralizes every catalog kind for zero, one and many", () => {
  expect(counts.map((count) => resourceCountText(count, "skill"))).toEqual([
    "0 skills",
    "1 skill",
    "2 skills",
  ]);
  expect(counts.map((count) => resourceCountText(count, "command"))).toEqual([
    "0 commands",
    "1 command",
    "2 commands",
  ]);
  expect(counts.map((count) => resourceCountText(count, "context"))).toEqual([
    "0 contexts",
    "1 context",
    "2 contexts",
  ]);
  expect(counts.map((count) => resourceCountText(count, "script"))).toEqual([
    "0 scripts",
    "1 script",
    "2 scripts",
  ]);
  expect(counts.map((count) => resourceCountText(count, "docs"))).toEqual([
    "0 docs",
    "1 doc",
    "2 docs",
  ]);
  expect(counts.map((count) => resourceCountText(count))).toEqual([
    "0 resources",
    "1 resource",
    "2 resources",
  ]);
});
