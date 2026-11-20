import { describe, expect, it } from "vitest";
import { envelopeOf, hintRecorder, plainStyle } from "../human.test-support.ts";
import { renderHuman } from "../render.ts";
import { renderExplore } from "./result.ts";

const closed = envelopeOf({ command: "explore", result: { kind: "explore-session" } });

describe("explore result", () => {
  // Applied edits are reported inside the session, so the closing line claims nothing else.
  it("says only that the session closed", () => {
    expect(renderExplore(closed, plainStyle)).toBe("tack explore  closed\n");
  });

  it("is the explore view, and declines anything else", () => {
    const { style } = hintRecorder();
    expect(renderHuman(closed, style)).toContain("tack explore  closed");
    expect(
      renderExplore(envelopeOf({ command: "explore", result: { kind: "other" } }), plainStyle),
    ).toBe(undefined);
  });
});
