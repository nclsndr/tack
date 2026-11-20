import { describe, expect, it } from "vitest";
import { parseAnsi } from "./ansi.ts";

describe("parseAnsi", () => {
  it("returns plain text as one unstyled span", () => {
    expect(parseAnsi("tack sync")).toEqual([{ text: "tack sync", bold: false, dim: false }]);
  });

  it("opens and closes bold, dim and colors the way Tack paints them", () => {
    expect(
      parseAnsi("\u001b[1mtack\u001b[22m \u001b[32m✓ success\u001b[39m \u001b[2;36mnext\u001b[0m."),
    ).toEqual([
      { text: "tack", bold: true, dim: false },
      { text: " ", bold: false, dim: false },
      { text: "✓ success", bold: false, dim: false, color: "green" },
      { text: " ", bold: false, dim: false },
      { text: "next", bold: false, dim: true, color: "cyan" },
      { text: ".", bold: false, dim: false },
    ]);
  });

  it.each([
    [31, "red"],
    [33, "yellow"],
    [34, "blue"],
    [36, "cyan"],
  ] as const)("names color %i %s and ignores codes it does not draw", (code, color) => {
    expect(parseAnsi(`\u001b[${code};4mx\u001b[m`)).toEqual([
      { text: "x", bold: false, dim: false, color },
    ]);
  });
});
