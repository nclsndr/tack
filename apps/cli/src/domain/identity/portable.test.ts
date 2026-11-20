import { createHash } from "node:crypto";
import nodePath from "node:path";
import { isDeepStrictEqual as nodeDeepEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { deepStrictEqual, posixPath, sha256 } from "./portable.ts";

describe("portable POSIX paths", () => {
  type Paths = Pick<
    typeof posixPath,
    "basename" | "dirname" | "isAbsolute" | "join" | "normalize" | "relative" | "resolve" | "sep"
  >;
  const cases: ReadonlyArray<readonly [string, (paths: Paths) => unknown]> = [
    [
      "relative to a sibling tree",
      (paths) => paths.relative("/home/you/code/app/.claude", "/home/you/skills/review"),
    ],
    ["relative to itself", (paths) => paths.relative("/a/b", "/a/b")],
    ["dirname", (paths) => paths.dirname("/home/you/skills/review")],
    ["dirname of a bare name", (paths) => paths.dirname("review")],
    ["join with dots", (paths) => paths.join("skills", "../commands", "./x.md")],
    ["normalize", (paths) => paths.normalize("a//b/../c/.")],
    ["isAbsolute", (paths) => [paths.isAbsolute("/a"), paths.isAbsolute("a")]],
    ["resolve from an absolute base", (paths) => paths.resolve("/a/b", "../c")],
    ["basename", (paths) => paths.basename("/a/b.md")],
    ["sep", (paths) => paths.sep],
  ];

  it.each(cases)("%s matches node:path", (_name, call) => {
    expect(call(posixPath)).toEqual(call(nodePath.posix));
  });
});

describe("portable deep strict equality", () => {
  const values: ReadonlyArray<unknown> = [
    1,
    "1",
    Number.NaN,
    0,
    -0,
    null,
    undefined,
    [],
    [1, [2, { a: 3 }]],
    [1, [2, { a: 4 }]],
    { a: 1, b: [1, 2] },
    { b: [1, 2], a: 1 },
    { a: 1, b: [1, 2], c: undefined },
    { 0: 1 },
    [1],
    { nested: { deep: ["x", { y: null }] } },
  ];

  it("agrees with node:util on every pair of plain values", () => {
    const pairs = values.flatMap((left) => values.map((right) => [left, right] as const));

    expect(pairs.map(([left, right]) => deepStrictEqual(left, right))).toEqual(
      pairs.map(([left, right]) => nodeDeepEqual(left, right)),
    );
  });
});

describe("portable SHA-256", () => {
  const encoder = new TextEncoder();
  const inputs = [
    new Uint8Array(),
    encoder.encode("abc"),
    encoder.encode("a".repeat(55)),
    encoder.encode("a".repeat(56)),
    encoder.encode("a".repeat(64)),
    encoder.encode("é✓ unicode"),
    Uint8Array.from({ length: 100_003 }, (_, index) => (index * 31) % 256),
  ];

  it.each(inputs.map((input) => [input.byteLength, input] as const))(
    "hashes %i bytes like node:crypto",
    (_length, input) => {
      expect(sha256(input)).toBe(createHash("sha256").update(input).digest("hex"));
    },
  );

  it("hashes strings as their UTF-8 bytes and streams several chunks as one input", () => {
    expect(sha256("é✓")).toBe(createHash("sha256").update("é✓").digest("hex"));
    expect(sha256(["ab", encoder.encode("c")])).toBe(
      createHash("sha256").update("abc").digest("hex"),
    );
  });
});
