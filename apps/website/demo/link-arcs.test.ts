import { describe, expect, it } from "vitest";
import { layoutArcs } from "./link-arcs.ts";
import { nextLinkField } from "./link-field.ts";

const home = "/home/you";
const edge = (from: string, to: string) => ({ from, to });
const agentLinks = (scope: string, name: string) =>
  [".claude", ".agents", ".cursor"].map((folder) =>
    edge(`${scope}/${folder}/skills/${name}`, `/home/you/skills/${name}`),
  );

/** After `tack init`: the built-in skill linked for the three agents in the home. */
const userEdges = [".claude", ".agents", ".cursor"].map((folder) =>
  edge(`/home/you/${folder}/skills/use-tack`, "/opt/tack/builtins/skills/use-tack"),
);
const init = nextLinkField(undefined, userEdges, new Set(), home);

/** The first `tack sync --all --apply`: commit and review linked into app and api, 3 kept. */
const syncEdges = [
  ...userEdges,
  ...agentLinks("/home/you/code/app", "commit"),
  ...agentLinks("/home/you/code/app", "review"),
  ...agentLinks("/home/you/code/api", "commit"),
  ...agentLinks("/home/you/code/api", "review"),
];
const sync = nextLinkField(
  init,
  syncEdges,
  new Set(syncEdges.map((link) => link.from).filter((path) => path.includes("/code/"))),
  home,
);
const width = 1440;

describe("layoutArcs", () => {
  const { marks, arcs } = layoutArcs(sync, width);

  it("draws an arc per real file, wider for each file", () => {
    expect(arcs).toHaveLength(3);
    const radii = arcs.map((arc) => arc.radius);
    expect(radii).toEqual([...radii].sort((a, b) => a - b));
    expect(new Set(radii).size).toBe(3);
  });

  it("knows which files the last command linked, and which kept links", () => {
    expect(arcs.map((arc) => arc.fresh)).toEqual([false, true, true]);
    expect(arcs.map((arc) => arc.kept)).toEqual([true, false, false]);
  });

  it("puts each link on its file's arc, above the origin, inside the page", () => {
    expect(marks).toHaveLength(15);
    marks.forEach((mark) => {
      const arc = arcs[mark.file];
      const across = (mark.x - width / 2) / (arc?.radius ?? 1);
      const up = mark.y / ((arc?.radius ?? 1) * (arc?.flat ?? 1));
      expect(across * across + up * up).toBeCloseTo(1, 5);
      expect(mark.y).toBeLessThan(0);
      expect(mark.x).toBeGreaterThan(0);
      expect(mark.x).toBeLessThan(width);
    });
  });

  it("gives the home, then each project, its own sector of the fan, left to right", () => {
    const angleOf = (key: string) => {
      const mark = marks.find((candidate) => candidate.key.includes(key));
      const arc = arcs[mark?.file ?? 0];
      return Math.atan2(-(mark?.y ?? 0) / (arc?.flat ?? 1), (mark?.x ?? 0) - width / 2);
    };
    const angles = ["/home/you/.claude", "/code/app/.claude", "/code/api/.claude"].map(angleOf);
    expect(angles).toEqual([...angles].sort((a, b) => b - a));
  });

  it("keeps the marks in place when a project joins", () => {
    const before = layoutArcs(init, width).marks;
    expect(before.map((mark) => [mark.x, mark.y])).toEqual(
      marks.slice(0, 3).map((mark) => [mark.x, mark.y]),
    );
  });

  it("orders the new marks inner arc first, then left to right, and leaves kept ones out", () => {
    const fresh = [...marks].filter((mark) => mark.fresh).sort((a, b) => a.order - b.order);
    expect(fresh.map((mark) => mark.order)).toEqual([...fresh.keys()]);
    const radius = (mark: (typeof fresh)[number]) => arcs[mark.file]?.radius ?? 0;
    expect(fresh.map(radius)).toEqual([...fresh.map(radius)].sort((a, b) => a - b));
    const inner = fresh.filter((mark) => mark.file === fresh[0]?.file).map((mark) => mark.x);
    expect(inner).toEqual([...inner].sort((a, b) => a - b));
    expect(marks.filter((mark) => mark.fresh === false).every((mark) => mark.order === -1)).toBe(
      true,
    );
  });
});
