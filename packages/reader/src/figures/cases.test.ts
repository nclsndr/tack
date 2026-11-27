import { describe, expect, it } from "vitest";
import { readCases } from "./cases.ts";
import { type FigureIssue, inputIssue, issueLine, text } from "./issues.ts";

describe("reading replays and lenses", () => {
  it("passes each step and lens to its figure's reader and reports defects in author order", () => {
    const issues: FigureIssue[] = [];
    const cases = readCases(
      {
        replays: [
          { label: "One call", steps: [{ at: "a", note: "It starts." }, { at: "zz" }, "b"] },
          { id: "one-call", steps: [] },
          { label: "!!!", steps: [{ at: "a" }] },
          "not a record",
        ],
        lenses: [{ id: "one-call", label: "Again", note: "n", focus: "a" }, "not a record"],
      },
      {
        steps: 2,
        issues,
        step: (fields, where) => {
          const at = text(fields["at"]) ?? "?";
          if (at === "a") return { at, note: text(fields["note"]) ?? "" };
          issues.push(inputIssue(`${where} names an unknown id "${at}"`));
          return undefined;
        },
        lens: (lens, name) => ({ focus: [text(lens["focus"]) ?? name] }),
      },
    );
    expect(issues.map(issueLine)).toEqual([
      'input: replay "One call" has 3 steps; the budget is 2',
      'input: replay "One call" step 2 names an unknown id "zz"',
      'input: replay "One call" step 3 names an unknown id "?"',
      "input: replay 2 has no label",
      "input: replay 2 has no steps",
      "input: replay 4 has no label",
      "input: replay 4 has no steps",
      "input: lens 2 has no label",
      "input: lens 2 has no note",
    ]);
    expect(cases).toEqual([
      {
        kind: "replay",
        id: "one-call",
        label: "One call",
        steps: [{ at: "a", note: "It starts." }],
      },
      { kind: "replay", id: "replay-3", label: "!!!", steps: [{ at: "a", note: "" }] },
      { kind: "lens", id: "one-call-3", label: "Again", note: "n", focus: ["a"] },
      { kind: "lens", id: "lens-2", label: "Lens 2", note: "", focus: ["lens 2"] },
    ]);
  });
});
