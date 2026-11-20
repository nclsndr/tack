import { describe, expect, it } from "vitest";
import { markdownPath, prefersMarkdown } from "./markdown.ts";

describe("markdownPath", () => {
  it("maps a page to its Markdown twin", () => {
    expect(markdownPath("/docs/getting-started")).toBe("/docs/getting-started.md");
    expect(markdownPath("/docs/getting-started.html")).toBe("/docs/getting-started.md");
  });

  it("maps a directory to its index twin", () => {
    expect(markdownPath("/")).toBe("/index.md");
    expect(markdownPath("/docs/")).toBe("/docs/index.md");
  });

  it("leaves Markdown, text and asset requests alone", () => {
    expect(markdownPath("/docs/getting-started.md")).toBeUndefined();
    expect(markdownPath("/llms.txt")).toBeUndefined();
    expect(markdownPath("/illustrations/hero-saddle-768.webp")).toBeUndefined();
    expect(markdownPath("/static/js/index.3f2a.js")).toBeUndefined();
  });
});

describe("prefersMarkdown", () => {
  it("accepts an Accept header that names text/markdown", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
    expect(prefersMarkdown("text/markdown, text/html;q=0.9")).toBe(true);
    expect(prefersMarkdown("text/html, text/markdown;q=0.5")).toBe(true);
  });

  it("ignores browsers, missing headers and a refused text/markdown", () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown("text/html,application/xhtml+xml,*/*;q=0.8")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0")).toBe(false);
  });
});
