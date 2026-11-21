import { describe, expect, it } from "vitest";
import { plainAnsi } from "../landing/ansi.ts";
import { excerpt } from "./excerpt.ts";

const capture = ["one", "two", "three", "four", "five", "six", "", ""].join("\n");

describe("excerpt", () => {
  it("keeps the whole capture, without its trailing blank lines, when no lines are chosen", () => {
    expect(excerpt(capture)).toBe("one\ntwo\nthree\nfour\nfive\nsix");
  });

  it("keeps the chosen lines, counted from one, and names each gap with its line count", () => {
    expect(
      plainAnsi(
        excerpt(capture, [
          [1, 2],
          [5, 5],
        ]),
      ),
    ).toBe("one\ntwo\n⋯ 2 lines not shown\nfive\n⋯ 1 line not shown");
  });

  it("draws a gap dim, so it never reads as the command's own output", () => {
    expect(excerpt(capture, [[2, 6]])).toBe(
      "\u001b[2m⋯ 1 line not shown\u001b[22m\ntwo\nthree\nfour\nfive\nsix",
    );
  });

  it.each([
    ["a range past the end", [[5, 7]]],
    ["a range that runs backwards", [[3, 2]]],
    [
      "ranges out of order",
      [
        [4, 5],
        [1, 2],
      ],
    ],
    [
      "overlapping ranges",
      [
        [1, 3],
        [3, 4],
      ],
    ],
    ["a line number below one", [[0, 2]]],
  ] as const)("refuses %s", (_name, ranges) => {
    expect(() => excerpt(capture, ranges)).toThrow(/lines/);
  });
});
