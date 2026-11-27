import { describe, expect, it } from "vitest";
import { envelopeOf, hintRecorder, plainStyle } from "./human.test-support.ts";
import { renderDedicated, renderHuman } from "./render.ts";

const closed = envelopeOf({ command: "explore", result: { kind: "explore-session" } });

describe("explore result", () => {
  // Applied edits are reported inside the session, so the closing line claims nothing else.
  it("says only that the session closed", () => {
    expect(renderDedicated(closed, plainStyle)).toBe("tack explore  closed\n");
  });

  it("is the explore view, and declines anything else", () => {
    const { style } = hintRecorder();
    expect(renderHuman(closed, style)).toContain("tack explore  closed");
    expect(
      renderDedicated(envelopeOf({ command: "explore", result: { kind: "other" } }), plainStyle),
    ).toBe(undefined);
  });
});
