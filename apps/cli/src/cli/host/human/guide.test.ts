import { describe, expect, it } from "vitest";
import { envelopeOf, expectViewContract, hintRecorder, styleOf } from "./human.test-support.ts";
import { renderGuide } from "./guide.ts";

const markdown = [
  "# Onboard a machine to Tack",
  "",
  "Follow this when Tack was just installed or someone asks you to set it up, in this order.",
  "",
  "## 1. Machine",
  "",
].join("\n");

const guide = envelopeOf({
  command: "guide",
  result: { kind: "guide", topic: "onboarding", version: "0.5.0+dev", markdown },
});

const index = envelopeOf({
  command: "guide",
  result: {
    kind: "guide-index",
    guides: [
      { topic: "onboarding", title: "Onboard a machine to Tack" },
      { topic: "agent-instructions", title: "The Tack section in a project's agent instructions" },
    ],
  },
});

describe("guide view", () => {
  it("prints the guide as it ships, after the version and how to read the lines a tool cut", () => {
    const { hints, style } = hintRecorder(styleOf({ width: 80 }));
    expect(renderGuide(guide, style)).toBe(
      [
        "tack guide · onboarding · tack 0.5.0+dev · ✓ success",
        "",
        "Read all 5 lines of this guide before you act. If your tool shortened this",
        "output, print the lines you missed:",
        "  tack guide onboarding | sed -n 'FIRST,LASTp'",
        "",
        markdown,
      ].join("\n"),
    );
    expect(hints).toEqual([]);
  });

  it("wraps only its own lines: the guide keeps the line breaks it ships with", () => {
    const narrow = renderGuide(guide, styleOf({ width: 40 })) ?? "";
    expect(narrow.endsWith(`\n\n${markdown}`)).toBe(true);
    expect(
      narrow
        .split(`\n\n${markdown}`)[0]
        ?.split("\n")
        .every((line) => line.length <= 40),
    ).toBe(true);
  });

  it("lists the guides by title and names the onboarding guide next", () => {
    const { hints, style } = hintRecorder(styleOf({ width: 80 }));
    expect(renderGuide(index, style)).toBe(
      [
        "tack guide · ✓ success",
        "",
        "Guides",
        "  onboarding          Onboard a machine to Tack",
        "  agent-instructions  The Tack section in a project's agent instructions",
        "",
        "Next",
        "  tack guide onboarding",
        "",
      ].join("\n"),
    );
    expect(hints).toEqual(["tack guide onboarding"]);
    expectViewContract(index);
  });

  it("names the guides after a refused topic, and leaves a payload it cannot read to the generic view", () => {
    const refused = envelopeOf({
      command: "guide",
      classification: "invalid-invocation",
      diagnostics: [
        {
          code: "guide-topic-unknown",
          severity: "error",
          message: 'Tack has no guide named "setup". The guides are onboarding, day-two.',
          details: { topic: "setup", topics: ["onboarding", "day-two"] },
        },
      ],
    });
    const { hints, style } = hintRecorder(styleOf({ width: 80 }));
    expect(renderGuide({ ...refused, next: ["tack guide"] }, style)).toContain(
      'Tack has no guide named "setup". The guides are onboarding, day-two.',
    );
    expect(hints).toEqual(["tack guide"]);
    expect(
      renderGuide(envelopeOf({ command: "guide", result: { kind: "other" } }), styleOf()),
    ).toBeUndefined();
  });
});
