import { describe, expect, it } from "vitest";
import { nextLinkField } from "./link-field.ts";
import {
  defaultTransition,
  layoutReins,
  laneCount,
  plannedReins,
  reinCap,
  reinPath,
  reinSpan,
  rulerTicks,
  tallyLinks,
  trackPoint,
  transitionFrom,
} from "./story-transition.ts";

const home = "/home/you";
const edge = (from: string, to: string) => ({ from, to });

/** After `tack init`: the built-in skill linked for two agents in the home. */
const userEdges = [".claude", ".agents"].map((folder) =>
  edge(`/home/you/${folder}/skills/use-tack`, "/opt/tack/builtins/skills/use-tack"),
);
const init = nextLinkField(undefined, userEdges, new Set(), home);

/** A sync that links review into app and api for Claude Code, keeping the home's links. */
const syncEdges = [
  ...userEdges,
  edge("/home/you/code/app/.claude/skills/review", "/home/you/skills/review"),
  edge("/home/you/code/api/.claude/skills/review", "/home/you/skills/review"),
];
const sync = nextLinkField(
  init,
  syncEdges,
  new Set(syncEdges.map((link) => link.from).filter((path) => path.includes("/code/"))),
  home,
);

describe("transitionFrom", () => {
  it("defaults to the recommended direction without a choice", () => {
    expect(transitionFrom("")).toBe(defaultTransition);
    expect(transitionFrom("?other=b")).toBe(defaultTransition);
  });

  it("reads a direction by letter or by name, in any case", () => {
    expect(transitionFrom("?transition=a")).toBe("reins");
    expect(transitionFrom("?transition=B")).toBe("plotter");
    expect(transitionFrom("?transition=c")).toBe("track");
    expect(transitionFrom("?transition=track")).toBe("track");
  });

  it("falls back to the default on an unknown value", () => {
    expect(transitionFrom("?transition=z")).toBe(defaultTransition);
  });
});

describe("tallyLinks", () => {
  it("counts nothing before the machine loads", () => {
    expect(tallyLinks(undefined)).toEqual({ total: 0, fresh: 0, scopes: 0 });
  });

  it("counts every link, the fresh ones and the places they serve", () => {
    expect(tallyLinks(init)).toEqual({ total: 2, fresh: 0, scopes: 1 });
    expect(tallyLinks(sync)).toEqual({ total: 4, fresh: 2, scopes: 3 });
  });
});

describe("layoutReins", () => {
  const span = { from: 100, to: 500 };

  it("draws planned guides before any link exists", () => {
    const reins = layoutReins(0, 0, span);
    expect(reins).toHaveLength(plannedReins);
    expect(reins.every((rein) => rein.state === "planned")).toBe(true);
  });

  it("draws one rein per link, the last ones fresh", () => {
    expect(layoutReins(4, 2, span).map((rein) => rein.state)).toEqual([
      "made",
      "made",
      "fresh",
      "fresh",
    ]);
  });

  it("caps the reins and keeps them inside the span, evenly spaced", () => {
    const reins = layoutReins(40, 40, span);
    expect(reins).toHaveLength(reinCap);
    const xs = reins.map((rein) => rein.x);
    expect(Math.min(...xs)).toBeGreaterThan(span.from);
    expect(Math.max(...xs)).toBeLessThan(span.to);
    const gaps = xs.slice(1).map((x, index) => x - (xs[index] ?? 0));
    expect(new Set(gaps.map((gap) => gap.toFixed(6))).size).toBe(1);
  });
});

describe("reinSpan", () => {
  it("keeps the reins over the right part of the content column", () => {
    expect(reinSpan(100, 1000)).toEqual({ from: 720, to: 1060 });
  });
});

describe("reinPath", () => {
  it("drops straight from the top, then bends onto the target", () => {
    expect(reinPath(800, { x: 500, y: 1000 }, 400)).toBe(
      "M 800 0 L 800 400 C 800 700, 500 700, 500 1000",
    );
  });
});

describe("rulerTicks", () => {
  it("lights one tick per link, the fresh ones last", () => {
    expect(rulerTicks(3, 1, 5)).toEqual(["lit", "lit", "fresh", "idle", "idle"]);
  });

  it("lights at most every tick", () => {
    expect(rulerTicks(9, 9, 3)).toEqual(["fresh", "fresh", "fresh"]);
  });
});

describe("laneCount", () => {
  it("keeps one lane before any link and at most three", () => {
    expect(laneCount(0)).toBe(1);
    expect(laneCount(2)).toBe(2);
    expect(laneCount(7)).toBe(3);
  });
});

describe("trackPoint", () => {
  it("starts at the bottom of the track and runs clockwise", () => {
    expect(trackPoint(0)).toEqual({ left: 50, top: 100 });
    const quarter = trackPoint(0.25);
    expect(quarter.left).toBeCloseTo(0);
    expect(quarter.top).toBeCloseTo(50);
  });

  it("draws an inner lane inside the outer one", () => {
    const inner = trackPoint(0, 0.2);
    expect(inner.left).toBeCloseTo(50);
    expect(inner.top).toBeCloseTo(90);
  });
});
