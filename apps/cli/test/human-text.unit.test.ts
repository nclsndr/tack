import { describe, expect, it } from "vitest";
import {
  cell,
  displayWidth,
  flow,
  paragraph,
  table,
  tableRows,
  truncate,
  wrapText,
} from "../src/cli/human/text.ts";

const widest = (lines: ReadonlyArray<string>) => Math.max(0, ...lines.map(displayWidth));

describe("displayWidth", () => {
  it("counts wide characters, emoji and zero-width marks by columns", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("ｱｲｳ")).toBe(3);
    expect(displayWidth("ＡＢ")).toBe(4);
    expect(displayWidth("🚀")).toBe(2);
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("👨‍👩‍👧")).toBe(2);
    expect(displayWidth("✓ ✗ − · … →")).toBe(11);
  });

  it("ignores ANSI color escapes", () => {
    expect(displayWidth("\u001b[31m日本\u001b[39m")).toBe(4);
  });
});

describe("truncate", () => {
  it("cuts at a column boundary and never splits a wide character", () => {
    expect(truncate("日本語のテキスト", 7)).toBe("日本語…");
    expect(displayWidth(truncate("日本語のテキスト", 6))).toBeLessThanOrEqual(6);
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 1)).toBe("…");
  });
});

describe("wrapText", () => {
  it("wraps at spaces by columns", () => {
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
    const lines = wrapText("日本語の 説明がここにあります とても長い説明", 12);
    expect(widest(lines)).toBeLessThanOrEqual(12);
    expect(lines.join("").replace(/ /g, "")).toBe("日本語の説明がここにありますとても長い説明");
  });

  it("puts a path that does not fit on its own line, whole", () => {
    const path = "~/a/very/long/directory/name/with/many/segments/SKILL.md";
    expect(wrapText(`read ${path} first`, 20)).toEqual(["read", path, "first"]);
    expect(wrapText(`skill demo:.claude/skills/${"x".repeat(30)}`, 20)).toEqual([
      "skill",
      `demo:.claude/skills/${"x".repeat(30)}`,
    ]);
  });

  it("breaks an overlong token that is not a path at separators before cutting characters", () => {
    const name = "a-very-long-hyphenated-resource-name-with-many-parts";
    const lines = wrapText(name, 20);
    expect(widest(lines)).toBeLessThanOrEqual(20);
    expect(lines.join("")).toBe(name);
    expect(lines.every((line) => line.endsWith("-") || line === lines.at(-1))).toBe(true);
    const unbroken = "x".repeat(50);
    expect(widest(wrapText(unbroken, 16))).toBeLessThanOrEqual(16);
    expect(wrapText(unbroken, 16).join("")).toBe(unbroken);
  });

  it("makes progress when one character is wider than the line", () => {
    expect(wrapText("日本", 1)).toEqual(["日", "本"]);
  });
});

describe("flow", () => {
  it("fills lines with cells and indents continuations", () => {
    const lines = flow(
      ["alpha", "beta", "gamma", "delta"].map((text) => cell(text)),
      { width: 14, indent: 2, hang: 4 },
    );
    expect(lines).toEqual(["  alpha beta", "    gamma", "    delta"]);
  });

  it("keeps a shell command copyable with a trailing backslash", () => {
    const lines = flow(
      "tack sync --project a-rather-long-project-name --apply".split(" ").map((text) => cell(text)),
      { width: 40, indent: 2, hang: 6, continuation: " \\" },
    );
    expect(widest(lines)).toBeLessThanOrEqual(40);
    expect(lines.slice(0, -1).every((line) => line.endsWith(" \\"))).toBe(true);
    expect(lines.at(-1)?.endsWith("\\")).toBe(false);
    expect(lines.map((line) => line.replace(/ \\$/, "").trim()).join(" ")).toBe(
      "tack sync --project a-rather-long-project-name --apply",
    );
  });

  it("paints each line piece and measures without the escapes", () => {
    const red = (text: string) => `\u001b[31m${text}\u001b[39m`;
    const lines = flow([cell("aaaa", red), cell("bbbb", red)], { width: 6, indent: 0 });
    expect(lines).toEqual([red("aaaa"), red("bbbb")]);
  });

  it("cuts a single cell wider than the line when it holds no path", () => {
    const lines = flow([cell("a-very-long-name-that-never-fits-in-one-line")], {
      width: 16,
      indent: 2,
    });
    expect(widest(lines)).toBeLessThanOrEqual(16);
  });

  it("puts a path cell wider than the line on its own line, whole", () => {
    const path = "/very/long/path/that/never/fits/in/one/line";
    expect(flow([cell("at"), cell(path), cell("now")], { width: 16, indent: 2 })).toEqual([
      "  at",
      `  ${path}`,
      "  now",
    ]);
  });

  it("wraps a wide cell at its spaces and keeps the path in it whole", () => {
    const path = "~/.agents/skills/a-long-skill-folder";
    expect(flow([cell(`alias ${path} is shared`)], { width: 24, indent: 2, hang: 4 })).toEqual([
      "  alias",
      `    ${path}`,
      "    is shared",
    ]);
  });
});

describe("paragraph", () => {
  it("wraps with a hanging indent inside the width", () => {
    const lines = paragraph("the quick brown fox jumps over the lazy dog", {
      width: 20,
      indent: 2,
      hang: 4,
    });
    expect(widest(lines)).toBeLessThanOrEqual(20);
    expect(lines[0]?.startsWith("  ")).toBe(true);
    expect(lines[1]?.startsWith("    ")).toBe(true);
  });
});

describe("table", () => {
  const rows = [
    [cell("review"), cell("shared"), cell("Review a change set before it merges, in depth")],
    [cell("日本語"), cell("private"), cell("日本語の説明がここにあります。とても長い説明です")],
  ];

  it.each([40, 80, 120])("fits every row in %i columns", (width) => {
    const lines = table(rows, { width });
    expect(widest(lines)).toBeLessThanOrEqual(width);
    expect(lines.join("\n")).toContain("review");
  });

  it("aligns fixed columns by display width", () => {
    const lines = table(rows, { width: 120 });
    const columnOf = (line: string, word: string) =>
      displayWidth(line.slice(0, line.indexOf(word)));
    expect(columnOf(lines[0] ?? "", "shared")).toBe(columnOf(lines[1] ?? "", "private"));
  });

  it("stacks when the fixed columns leave no room", () => {
    const lines = table(
      [[cell("a-name-that-is-wide"), cell("another-wide-column"), cell("description text here")]],
      { width: 40 },
    );
    expect(widest(lines)).toBeLessThanOrEqual(40);
    expect(lines.join("\n")).toContain("description text here");
  });

  it.each([40, 120])("keeps each row's lines in one group at %i columns", (width) => {
    const groups = tableRows(rows, { width });
    expect(groups.map((group) => group[0]?.trimStart().split(" ")[0])).toEqual([
      "review",
      "日本語",
    ]);
    expect(groups.flat()).toEqual(table(rows, { width }));
  });

  it("stacks rather than break a path in a leading column", () => {
    const path = "~/app/.claude/skills/review";
    const lines = table([[cell("linked"), cell(path), cell("skill team:review")]], { width: 40 });
    expect(lines).toContain(`  linked  ${path}`);
    expect(lines).toContain("    skill team:review");
  });

  it("puts a path wider than the last column on its own line, below the leading cells", () => {
    const path = "~/code/app/.claude/skills/a-rather-long-skill-name";
    expect(
      table(
        [
          [cell("source"), cell(`cloned at ${path}`)],
          [cell("docs"), cell(`${path} is shared`)],
        ],
        { width: 40 },
      ),
    ).toEqual([
      "  source  cloned at",
      `          ${path}`,
      "  docs",
      `          ${path}`,
      "          is shared",
    ]);
  });

  it("wraps a long flexible cell under its own column", () => {
    const lines = table([[cell("name"), cell("word ".repeat(30))]], { width: 40 });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((line) => line.startsWith(" ".repeat(8)))).toBe(true);
  });
});
