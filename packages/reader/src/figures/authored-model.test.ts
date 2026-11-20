import { describe, expect, it } from "vitest";
import { issueLine } from "./issues.ts";
import {
  authoredBudget,
  authoredReadable,
  type AuthoredInput,
  boxSize,
  readAuthoredFigure,
} from "./authored-model.ts";

const pipeline: AuthoredInput = {
  id: "update-pipeline",
  kind: "system",
  title: "Nothing outside staging/ changes until the gate passes",
  summary: "Two places on disk.",
  rule: { title: "Left to right", text: "Work moves from the checkout to the install." },
  startWith: ["export"],
  legend: { dashed: "a copy" },
  replays: [
    {
      label: "A good update",
      steps: [
        { at: "export", note: "git archive into a clean tree." },
        { at: "gate", note: "The built release is run for real." },
      ],
    },
  ],
  lenses: [{ label: "Gate fails", note: "Nothing moves.", focus: ["gate"], broken: ["swap"] }],
  drawing: {
    height: 320,
    elements: [
      {
        element: "band",
        props: { x: 16, y: 12, w: 340, h: 296, label: "Your checkout" },
      },
      { element: "band", props: { x: 372, y: 12, w: 340, h: 296, label: "~/.local/share/tack" } },
      {
        element: "box",
        props: { id: "export", x: 32, y: 60, label: "git archive", detail: "clean tree, no .git" },
      },
      {
        element: "box",
        props: { id: "gate", x: 388, y: 180, label: "gate-release", detail: "5 min cap", tint: 2 },
      },
      {
        element: "box",
        props: { id: "swap", x: 388, y: 60, label: "swap current", shape: "sheet" },
      },
      { element: "link", props: { from: "export", to: "gate", label: "staging/<uuid>" } },
      { element: "link", props: { from: "gate", to: "swap", style: "dashed" } },
      { element: "badge", props: { at: "export", n: 1 } },
      { element: "note", props: { x: 40, y: 260, text: "Held commits never retry", to: "export" } },
      { element: "label", props: { x: 32, y: 40, text: "Build", size: "small" } },
    ],
  },
};

const issuesOf = (input: unknown): readonly string[] =>
  readAuthoredFigure(input).issues.map(issueLine);

const withElements = (
  elements: AuthoredInput["drawing"]["elements"],
  height = 200,
): AuthoredInput => ({
  id: "t",
  title: "A test drawing shows one thing",
  drawing: { height, elements },
});

describe("authored figures", () => {
  it("reads a sound figure without issues", () => {
    const { model, issues, unchecked } = readAuthoredFigure(pipeline);
    expect(issues).toEqual([]);
    expect(unchecked).toEqual([]);
    expect(model.boxes.map((box) => box.id)).toEqual(["export", "gate", "swap"]);
    expect(model.cases.map((item) => [item.kind, item.id])).toEqual([
      ["replay", "a-good-update"],
      ["lens", "gate-fails"],
    ]);
  });

  it("sizes a box from its text on the 4 px grid, unless a width is given", () => {
    expect(boxSize({ label: "git archive" })).toEqual({ w: 96, h: 34 });
    expect(boxSize({ label: "git archive", detail: "clean tree, no .git" })).toEqual({
      w: 144,
      h: 46,
    });
    expect(boxSize({ label: "a", w: 200 })).toEqual({ w: 200, h: 34 });
    expect(boxSize({ label: "a longer label", shape: "queue" }).w).toBe(
      boxSize({ label: "a longer label" }).w + 16,
    );
  });

  it("reports overlapping boxes, text that does not fit, elements outside and crossing links", () => {
    const issues = issuesOf(
      withElements([
        { element: "box", props: { id: "a", x: 16, y: 16, label: "alpha" } },
        { element: "box", props: { id: "b", x: 40, y: 30, label: "beta" } },
        { element: "box", props: { id: "c", x: 16, y: 120, label: "a long label here", w: 60 } },
        { element: "box", props: { id: "d", x: 700, y: 120, label: "delta" } },
        { element: "box", props: { id: "e", x: 300, y: 16, label: "e" } },
        { element: "box", props: { id: "f", x: 600, y: 16, label: "f" } },
        { element: "box", props: { id: "g", x: 450, y: 16, label: "g" } },
        { element: "link", props: { from: "e", to: "f", label: "jumps" } },
        { element: "label", props: { x: 10, y: 260, text: "below" } },
      ]),
    );
    expect(issues).toEqual([
      'layout: boxes "a" and "b" overlap',
      'layout: the text of box "c" does not fit its box: it needs 136 px, the box is 60 px',
      'layout: box "d" is outside the drawing',
      'layout: label "below" is outside the drawing',
      'layout: link e -> f crosses box "g", which is not one of its ends',
    ]);
  });

  it("reports unknown ids, a missing id and label, duplicate ids, an unknown tint, shape and kind", () => {
    const issues = issuesOf({
      ...withElements([
        { element: "box", props: { x: 16, y: 16, label: "no id" } },
        { element: "box", props: { id: "a", x: 16, y: 80 } },
        { element: "box", props: { id: "a", x: 200, y: 80, label: "again" } },
        { element: "box", props: { id: "b", x: 300, y: 80, label: "b", tint: 9, shape: "blob" } },
        { element: "link", props: { from: "a", to: "zz", label: "x" } },
        { element: "badge", props: { at: "zz", n: 1 } },
        { element: "note", props: { x: 400, y: 150, text: "hi", to: "zz" } },
      ]),
      kind: "galaxy",
      startWith: ["zz"],
      replays: [{ label: "r", steps: [{ at: "zz", note: "x" }] }],
      lenses: [{ label: "l", note: "n", focus: ["zz"] }],
    });
    expect(issues).toEqual([
      'input: kind "galaxy" is unknown; drawn as system. Use architecture, system, schema or tree',
      "input: box 1 has no id; it takes part in no focus or case",
      'input: box "a" has no label',
      'input: duplicate id "a": box "again" is left out',
      'input: box "b" has tint 9; use 1 to 6. Drawn with no tint',
      'input: box "b" has unknown shape "blob"; drawn as plain',
      'input: link a -> zz names an unknown id "zz"',
      'input: badge 1 names an unknown box "zz"',
      'input: note "hi" points at an unknown box "zz"',
      'input: startWith names an unknown id "zz"',
      'input: replay "r" step 1 names an unknown id "zz"',
      'input: lens "l" names an unknown id "zz"',
    ]);
  });

  it("asks for a label or a legend entry on every link", () => {
    expect(
      issuesOf(
        withElements([
          { element: "box", props: { id: "a", x: 16, y: 16, label: "a" } },
          { element: "box", props: { id: "b", x: 300, y: 16, label: "b" } },
          { element: "link", props: { from: "a", to: "b", style: "muted" } },
        ]),
      ),
    ).toEqual([
      'input: link a -> b has no label, and its style "muted" has no legend entry; give one of them',
    ]);
  });

  it("asks for a drawing height, checks the budget, and says how many raw shapes it cannot check", () => {
    const { issues, unchecked } = readAuthoredFigure({
      id: "t",
      title: "A tank fills as events wait",
      drawing: {
        height: 1300,
        elements: [
          { element: "raw", props: {} },
          { element: "raw", props: {} },
        ],
      },
    });
    expect(issues.map(issueLine)).toEqual([
      `layout: the drawing is 1300 px tall; the budget is 1,200 px`,
    ]);
    expect(unchecked).toEqual(["2 raw shapes not checked"]);
    expect(issuesOf({ id: "t", title: "A drawing with no height at all" })).toEqual([
      "input: the figure has no <Drawing height={...}>; give the drawing and its height",
    ]);
    const many = Array.from({ length: authoredBudget.boxes + 1 }, (_, index) => ({
      element: "box" as const,
      props: {
        id: `b${index}`,
        x: 16 + (index % 6) * 116,
        y: 16 + Math.floor(index / 6) * 50,
        label: `b${index}`,
      },
    }));
    expect(issuesOf(withElements(many, 1200))).toContain(
      `input: ${authoredBudget.boxes + 1} boxes; the budget is ${authoredBudget.boxes}. Split the figure or use a figure component`,
    );
  });

  it("writes the text equivalent from bands, boxes, links, notes and cases", () => {
    const { model } = readAuthoredFigure(pipeline);
    expect(authoredReadable(model).split("\n")).toEqual([
      "Nothing outside staging/ changes until the gate passes",
      "Two places on disk.",
      "Left to right. Work moves from the checkout to the install.",
      "Your checkout: git archive (clean tree, no .git)",
      "~/.local/share/tack: gate-release (5 min cap), swap current",
      "git archive -> gate-release: staging/<uuid>",
      "gate-release -> swap current: a copy",
      "Note: Held commits never retry",
      "Build",
      "Replay A good update: 1. git archive: git archive into a clean tree. 2. gate-release: The built release is run for real.",
      "Lens Gate fails: Nothing moves. Focus: gate-release. Broken: swap current",
    ]);
  });

  it("drops a legend entry that is not text, and writes a bare link and a blocked-only lens", () => {
    const { model, issues } = readAuthoredFigure({
      id: "t",
      title: "Two boxes share one plain link",
      legend: { dashed: 5 },
      replays: [{ label: "!!!", steps: [{ at: "a", note: "n" }] }],
      lenses: [{ label: "Down", note: "b is down.", blocked: ["b"] }],
      drawing: {
        height: 100,
        elements: [
          { element: "box", props: { id: "a", x: 16, y: 16, label: "a", w: 200 } },
          { element: "box", props: { id: "b", x: 300, y: 16, label: "b" } },
          { element: "link", props: { from: "a", to: "b", style: "dashed" } },
        ],
      },
    });
    expect(issues.map(issueLine)).toEqual([
      'input: link a -> b has no label, and its style "dashed" has no legend entry; give one of them',
    ]);
    expect(model.legend).toEqual({});
    expect(model.cases.map((item) => item.id)).toEqual(["replay-1", "down"]);
    expect(authoredReadable(model).split("\n")).toEqual([
      "Two boxes share one plain link",
      "Boxes: a, b",
      "a -> b",
      "Replay !!!: 1. a: n",
      "Lens Down: b is down. Blocked: b",
    ]);
  });

  it("reports the remaining input issues of links, cases, bands and notes", () => {
    const steps = Array.from({ length: 13 }, () => ({ at: "a", note: "n" }));
    const { model, issues } = readAuthoredFigure({
      ...withElements([
        { element: "box", props: { id: "a", x: 16, y: 16, label: "a" } },
        { element: "box", props: { id: "b", x: 300, y: 16, label: "b" } },
        { element: "link", props: { from: "a" } },
        { element: "link", props: { from: "a", to: "b", label: "x", style: "wavy" } },
        { element: "band", props: { x: 600, y: 10, w: 200, h: 40, label: "wide", tint: 3 } },
        { element: "note", props: { x: 700, y: 150, text: "a note too far", toX: 10, toY: 10 } },
        { element: "label", props: { x: 364, y: 120, text: "centred", anchor: "middle" } },
        { element: "label", props: { x: 700, y: 120, text: "right", anchor: "end" } },
      ]),
      replays: [
        { steps },
        { label: "empty", steps: [] },
        { id: "dup", label: "same", steps: [{ at: "a", note: "n" }] },
      ],
      lenses: [{ id: "dup", focus: ["a"] }],
    });
    expect(issues.map(issueLine)).toEqual([
      "input: link 1 needs from and to; it is left out",
      'input: link a -> b has unknown style "wavy"; drawn solid',
      "input: replay 1 has no label",
      "input: replay 1 has 13 steps; the budget is 12",
      'input: replay "empty" has no steps',
      "input: lens 1 has no label",
      "input: lens 1 has no note",
      'layout: band "wide" is outside the drawing',
      'layout: note "a note too far" is outside the drawing',
    ]);
    expect(model.cases.map((item) => item.id)).toEqual(["replay-1", "dup", "dup-3"]);
    expect(model.notes[0]?.to).toEqual({ x: 10, y: 10 });
    expect(model.bands[0]?.tint).toBe(2);
    expect(model.links[0]?.style).toBe("solid");
    const unknown = readAuthoredFigure({
      id: "t",
      title: "An unknown element is left out",
      drawing: { height: 100, elements: [{ element: "nonsense", props: {} }, "text"] },
    });
    expect(unknown.issues).toEqual([]);
    expect(unknown.model.raw).toBe(0);
  });
});
