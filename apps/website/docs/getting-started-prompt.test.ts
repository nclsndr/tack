import { agentPrompt } from "@tackup/harness/prompts/landing";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./docs/getting-started.mdx", import.meta.url), "utf8");

/** Joins the first Markdown blockquote of the page into one line, as it renders. */
const firstQuote = (text: string): string => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("> "));
  const end = lines.findIndex((line, index) => index > start && line.startsWith("> ") === false);
  return lines
    .slice(start, end)
    .map((line) => line.slice(2).trim())
    .join(" ");
};

describe("getting-started prompt", () => {
  it("equals the agent prompt the evals test", () => {
    expect(firstQuote(page)).toBe(agentPrompt);
  });
});
