import { describe, expect, it } from "vitest";
import { issueLine } from "./issues.ts";
import { readFileTree } from "./file-tree-model.ts";
import { fileTreeLayoutIssues, layoutFileTree, treeGeometry } from "./file-tree-layout.ts";

const tree = (source: string) =>
  readFileTree({ id: "t", title: "The disk holds one release", source }).model;

const release = tree(
  [
    "~/.local/",
    "  bin/",
    "    tack -> ../share/tack/current/bin/tack  # created once, never rewritten",
    "  share/tack/",
    "    current -> releases/r1  # the pointer an update swaps",
    "    previous -> releases/r0",
    "    releases/",
    "      r0/  [100 MB]",
    "      r1/  [300 MB]",
    "        bin/tack  [69 MB]",
  ].join("\n"),
);

describe("the tree layout", () => {
  it("draws one row per entry, indented by depth, on the ruled pitch", () => {
    const layout = layoutFileTree(release);
    const rows = [...layout.rows.values()];
    expect(rows.map((row) => row.y)).toEqual(rows.map((_, index) => index * treeGeometry.pitch));
    expect(layout.rows.get("~/.local/bin/")?.x).toBe(
      (layout.rows.get("~/.local/")?.x ?? 0) + treeGeometry.indent,
    );
    expect(layout.height).toBe(rows.length * treeGeometry.pitch);
    expect(layout.width).toBe(728);
  });

  it("puts every arrow in a lane right of every name, and overlapping arrows in different lanes", () => {
    const layout = layoutFileTree(release);
    const ends = [...layout.rows.values()].map((row) => row.nameEnd);
    expect(layout.arrows).toHaveLength(3);
    layout.arrows.forEach((arrow) => expect(arrow.x).toBeGreaterThan(Math.max(...ends)));
    const [inner, outer] = [
      layout.arrows.find((arrow) => arrow.from === "~/.local/bin/tack"),
      layout.arrows.find((arrow) => arrow.from === "~/.local/share/tack/current"),
    ];
    // The two spans share the row of current, so the longer one takes the outer lane.
    expect(outer?.x).toBeGreaterThan(inner?.x ?? Infinity);
    expect(layout.notesX).toBeGreaterThan(Math.max(...layout.arrows.map((arrow) => arrow.x)));
  });

  it("draws no arrow for a link that resolves to itself", () => {
    expect(layoutFileTree(tree("dir/\n  self -> self")).arrows).toEqual([]);
  });

  it("keeps room for the absent stamp, so a note wraps sooner when a lens can stamp its entry", () => {
    const note = Array.from({ length: 10 }, () => "x".repeat(9)).join(" ");
    const noteLines = (lenses: readonly unknown[]) =>
      layoutFileTree(
        readFileTree({
          id: "t",
          title: "A temporary file carries a long note",
          source: `a [temp]  # ${note} x`,
          lenses,
        }).model,
      ).rows.get("a")?.note;
    expect(noteLines([])).toHaveLength(1);
    expect(noteLines([{ label: "L", note: "n", present: ["a"] }])).toHaveLength(2);
  });

  it("scales size bars to the largest size", () => {
    const layout = layoutFileTree(release);
    const bar = (id: string): number => layout.rows.get(id)?.bar ?? 0;
    expect(bar("~/.local/share/tack/releases/r1/")).toBe(treeGeometry.bar);
    expect(bar("~/.local/share/tack/releases/r0/")).toBeCloseTo(treeGeometry.bar / 3);
    expect(layout.rows.get("~/.local/")?.bar).toBeUndefined();
  });

  it("wraps a long note to two lines, and truncates and reports a longer one", () => {
    const words = (count: number): string =>
      Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
    const layout = layoutFileTree(tree(`a  # ${words(8)}\nb  # ${words(20)}\nc  # ${words(60)}`));
    expect(layout.rows.get("a")?.note).toHaveLength(1);
    expect(layout.rows.get("b")?.note).toHaveLength(2);
    expect(layout.rows.get("b")?.h).toBe(2 * treeGeometry.pitch);
    expect(layout.rows.get("c")?.note.at(-1)?.endsWith("…")).toBe(true);
    expect(fileTreeLayoutIssues(layout).map(issueLine)).toEqual([
      'layout: the note of "c" does not fit two lines; shorten it',
    ]);
  });

  it("reports names so wide they squeeze the notes", () => {
    const long = "x".repeat(100);
    const layout = layoutFileTree(tree(`${long}  # a note`));
    expect(fileTreeLayoutIssues(layout).map(issueLine)).toEqual([
      expect.stringMatching(
        /^layout: the names leave -?\d+ px for notes; shorten the longest name or target$/,
      ),
    ]);
  });

  it("reports a tree taller than the column allows", () => {
    const layout = layoutFileTree(
      tree(Array.from({ length: 51 }, (_, index) => `f${index}`).join("\n")),
    );
    expect(fileTreeLayoutIssues(layout).map(issueLine)).toEqual([
      `layout: the tree is ${51 * treeGeometry.pitch} px tall; the budget is 1,200 px. Fold entries into ...`,
    ]);
  });
});
