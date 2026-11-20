import { describe, expect, it } from "vitest";
import { lookUpDocsIcons } from "../../../features/reader/icon-lookup.ts";
import { docsIconsOutcome } from "../outcomes.ts";
import { createPublicEnvelope } from "../public-outcome.ts";
import { docsIconsView } from "./run-icons.ts";
import { makeStyle } from "./style.ts";

const style = makeStyle({ color: false, homeDirectory: "/home/me", width: 100 });
const view = (word: string | undefined) =>
  docsIconsView(
    createPublicEnvelope("docs icons", docsIconsOutcome(lookUpDocsIcons(word))),
    style,
  ) ?? "";

describe("the docs icons view", () => {
  it("prints each match under its category, an old name beside its current one", () => {
    const text = view("home");
    expect(text).toMatch(/Lucide\s+\d+\.\d+\.\d+/);
    expect(text).toMatch(/Matches\s+1/);
    expect(text).toContain("Objects and places");
    expect(text).toContain("  house (was home)");
  });

  it("warns when nothing matches", () => {
    const outcome = docsIconsOutcome(lookUpDocsIcons("qqqq"));
    expect(outcome.classification).toBe("success");
    expect(outcome.diagnostics).toEqual([
      {
        code: "docs-icons-none",
        message:
          'No docs icon matches "qqqq". Names say what an icon draws, so search for that (flask, not research), or run `tack docs icons` without a word to list them all.',
        severity: "warning",
      },
    ]);
  });
});
