import { describe, expect, it } from "vitest";

import {
  agentsFigure,
  profileFigure,
  projectFigure,
  scriptFigure,
  sourceFigure,
} from "./features-page/content.ts";
import { featuresMarkdown } from "./features-page/markdown.ts";
import { closing, getStarted } from "./landing/content.ts";
import { landingMarkdown } from "./landing/markdown.ts";

/** The Markdown twins agents read in place of the two custom pages. */
const twins = [
  ["landing", landingMarkdown()],
  ["features", featuresMarkdown()],
] as const;

describe("the Markdown twins", () => {
  it.each(twins)("of the %s page link only to absolute addresses", (_page, text) => {
    expect(text).toMatch(/\]\(https:\/\/tackup\.dev\//u);
    expect(text).not.toMatch(/\]\(\//u);
  });
});

describe("the features page's twin", () => {
  const text = featuresMarkdown();

  it("carries each agent's skill folder and command folder, which the page draws", () => {
    for (const link of [...agentsFigure.links, ...agentsFigure.commands]) {
      expect(text).toMatch(new RegExp(`\\| ${link.agent} \\|.*\`${link.path}\``, "u"));
    }
  });

  it("carries the source tree, the worktrees, the script and the profile's way", () => {
    const facts = [
      sourceFigure.root,
      ...sourceFigure.entries.flatMap((entry) => [entry.path, entry.kind]),
      projectFigure.link,
      ...projectFigure.worktrees.map((worktree) => worktree.root),
      ...scriptFigure.code,
      ...profileFigure.steps.flatMap((step) => [step.what, step.how]),
    ];
    for (const fact of facts) expect(text).toContain(fact);
  });
});

describe("the landing page's twin", () => {
  it("carries the page's headings and its closing, not only its sections", () => {
    const text = landingMarkdown();
    for (const line of [`## ${getStarted.heading}`, `## ${closing.heading}`, closing.text]) {
      expect(text).toContain(line);
    }
  });
});
