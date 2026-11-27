import type { LlmsTxtContext, LlmsTxtPage } from "@rspress/core";
import { describe, expect, it } from "vitest";

import { llmsTxt } from "./llms-txt.ts";

/** A page as Rspress hands it to the renderer. */
const page = (routePath: string, title: string, description?: string): LlmsTxtPage => ({
  routePath,
  link: `https://tackup.dev${routePath.endsWith("/") ? `${routePath}index` : routePath}.md`,
  title,
  ...(description === undefined ? {} : { description }),
  frontmatter: {},
  lang: "",
  version: "",
});

/** Rspress's own sections, by the nav, then "Others". */
const features = {
  title: "Features",
  pages: [page("/docs/features", "Features", "Every feature."), page("/features", "features")],
};
const others = {
  title: "Others",
  pages: [
    page("/docs/reference/setup", "Setup", "What init does."),
    page("/docs/guides/add-a-source", "Add a source", "Register a folder."),
    page("/docs/getting-started", "Get started", "Install Tack."),
    page("/docs/", "Tack docs", "Where to start."),
  ],
};

/** The context Rspress hands the renderer. */
const context: LlmsTxtContext = {
  title: "Tack",
  description: "Tack is a CLI.",
  lang: "",
  version: "",
  base: "/",
  siteOrigin: "https://tackup.dev",
  sections: [features, others],
};

const render = llmsTxt({
  details: "Install it with `npm install --global @tackup/cli`.",
  pages: [
    { routePath: "/", markdown: "/index.md", title: "Tack: one setup", description: "The pitch." },
    { routePath: "/features", markdown: "/features.md", title: "Features", description: "Depth." },
  ],
  order: [
    "/",
    "/features",
    "/docs/",
    "/docs/getting-started",
    "/docs/features",
    "/docs/guides/add-a-source",
    "/docs/reference/setup",
  ],
});

describe("llmsTxt", () => {
  it("lists the landing page first, every page with its description, in three named sections", () => {
    expect(render(context)).toBe(`# Tack

> Tack is a CLI.

Install it with \`npm install --global @tackup/cli\`.

## Start here

- [Tack: one setup](https://tackup.dev/index.md): The pitch.
- [Features](https://tackup.dev/features.md): Depth.
- [Tack docs](https://tackup.dev/docs/index.md): Where to start.
- [Get started](https://tackup.dev/docs/getting-started.md): Install Tack.
- [Features](https://tackup.dev/docs/features.md): Every feature.

## Guides

- [Add a source](https://tackup.dev/docs/guides/add-a-source.md): Register a folder.

## Reference

- [Setup](https://tackup.dev/docs/reference/setup.md): What init does.
`);
  });

  it("puts a page the order does not name after the pages of its section", () => {
    const extra = page("/docs/guides/zzz", "Late", "Unordered.");
    const text = render({
      ...context,
      sections: [features, { title: "Others", pages: [extra, ...others.pages] }],
    });
    expect(text).toContain(
      "- [Add a source](https://tackup.dev/docs/guides/add-a-source.md): Register a folder.\n- [Late](https://tackup.dev/docs/guides/zzz.md): Unordered.",
    );
  });

  it("leaves out the description of a page that has none", () => {
    const text = render({
      ...context,
      sections: [{ title: "Others", pages: [page("/docs/bare", "Bare")] }],
    });
    expect(text).toContain("- [Bare](https://tackup.dev/docs/bare.md)\n");
  });
});
