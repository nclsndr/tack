import { describe, expect, it } from "vitest";
import { routeStateDocument, stateFormat } from "./state-format.ts";

describe("state format numbers", () => {
  it("reads and writes format 1 only", () => {
    expect(stateFormat).toBe(1);
  });
});

describe("routing a state document on its first field", () => {
  it.each([
    ["format 1", { format: 1, data: {} }, { _tag: "format", format: 1 }],
    ["format 2", { format: 2, data: {} }, { _tag: "format", format: 2 }],
    ["format 3", { format: 3, data: {} }, { _tag: "format", format: 3 }],
    ["no envelope key", { data: {} }, { _tag: "unrecognized" }],
    ["format that is not the first field", { data: {}, format: 1 }, { _tag: "unrecognized" }],
    ["a fractional format", { format: 1.5 }, { _tag: "unrecognized" }],
    ["a text format", { format: "1" }, { _tag: "unrecognized" }],
    ["an empty object", {}, { _tag: "unrecognized" }],
    ["an array", [{ format: 1 }], { _tag: "unrecognized" }],
    ["null", null, { _tag: "unrecognized" }],
    ["a number", 4, { _tag: "unrecognized" }],
  ])("routes %s", (_name, document, expected) => {
    expect(routeStateDocument(document)).toEqual(expected);
  });
});
