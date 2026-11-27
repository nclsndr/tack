import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { existsSync } from "node:fs";
import {
  agentsFigure,
  intro,
  lenses,
  sharedAgents,
  sourceFigure,
} from "../features-page/content.ts";
import { repositoryUrl, siteUrl } from "../site.ts";
import { definingSentence, features, footer, hero, questions } from "./content.ts";
import { landingMarkdown } from "./markdown.ts";

/** A file of the repository, read from its root. */
const repoFile = (path: string) =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

/** Text with its line breaks and runs of spaces folded into single spaces. */
const folded = (text: string) => text.replaceAll(/\s+/gu, " ");

/** The agent of every CLI adapter, from the features page's figure, which its test checks. */
const adapterAgents = agentsFigure.links.map((link) => link.agent);

describe("the hero", () => {
  it("names the agent of every CLI adapter under the lead line", () => {
    for (const agent of adapterAgents) expect(hero.agents).toContain(agent);
  });
});

describe("the features strip", () => {
  it("leads to each part of the features page, in its order and by its name", () => {
    expect(features.parts.map((part) => [part.id, part.name])).toEqual(
      lenses.map((lens) => [lens.id, lens.name]),
    );
  });

  it("names the agent of every CLI adapter in the Agents part", () => {
    const agents = features.parts.find((part) => part.id === "agents");
    for (const agent of adapterAgents) expect(agents?.line).toContain(agent);
  });

  it("counts the agents reached through a shared folder from the features page's table", () => {
    const agents = features.parts.find((part) => part.id === "agents");
    expect(agents?.line).toContain(`${sharedAgents.rows.length} more agents`);
  });
});

describe("the tagline, lead line and defining sentence", () => {
  const readme = folded(repoFile("README.md"));

  it("lead the README as they lead the landing page", () => {
    expect(readme).toContain(`<strong>${hero.headline}</strong>`);
    expect(readme).toContain(hero.subhead);
  });

  it.each(["package.json", "apps/cli/package.json"])("describe the package in %s", (path) => {
    expect(JSON.parse(repoFile(path)).description).toBe(definingSentence);
  });

  it("open the docs overview", () => {
    const overview = folded(repoFile("apps/website/docs/docs/index.mdx"));
    expect(overview).toContain(`# Tack docs ${definingSentence}`);
  });
});

describe("the problem the site states", () => {
  /** Every line of copy on the landing page, the features page and the README. */
  const copy = [
    JSON.stringify([hero, features, questions, intro, lenses]),
    folded(repoFile("README.md")),
  ];

  it.each(["own folder", "its own place", "wherever your agents look"])(
    "is never that each agent looks in %s",
    (phrase) => {
      for (const text of copy) expect(text).not.toContain(phrase);
    },
  );

  it.each(["in one repository", "one folder of", "a repository you own", "One repository holds"])(
    "never puts the whole setup in a single source: %s",
    (phrase) => {
      for (const text of [...copy, definingSentence]) expect(text).not.toContain(phrase);
    },
  );

  it("says Tack combines personal and team sources, in the lead line and the defining sentence", () => {
    for (const text of [hero.subhead, definingSentence]) {
      expect(text).toMatch(/combine/iu);
      expect(text).toMatch(/team/u);
    }
  });

  it("names the team's pain, then one developer's, on the features page and in the README", () => {
    const team = "A team's skills end up copied";
    const alone = "Working alone,";
    for (const text of [intro.problem, folded(repoFile("README.md"))]) {
      expect(text).toContain(team);
      expect(text.indexOf(alone)).toBeGreaterThan(text.indexOf(team));
    }
  });
});

describe("the landing page's problem", () => {
  it("is the features page's, the team's pain then one developer's, in the page and its twin", () => {
    expect(features.problem).toBe(intro.problem);
    expect(landingMarkdown()).toContain(intro.problem);
  });
});

describe("the install", () => {
  it("reads as published in the README", () => {
    expect(folded(repoFile("README.md"))).not.toContain("not yet published");
  });
});

describe("context, which no agent receives", () => {
  /** The README's table of what Tack manages, from its heading to the next section. */
  const readme = repoFile("README.md");
  const manages = readme.slice(
    readme.indexOf("## What Tack manages"),
    readme.indexOf("## Install"),
  );
  const overview = repoFile("apps/website/docs/docs/index.mdx");
  const sources = lenses.find((lens) => lens.id === "sources");

  it("stays off the first screens: the hero, the features, the README table, the docs overview", () => {
    for (const text of [JSON.stringify([hero, features]), manages, overview]) {
      expect(text).not.toMatch(/context/iu);
    }
  });

  it("is not in the source the features page draws first, nor in its first line", () => {
    expect(sourceFigure.entries.map((entry) => entry.kind).join(" ")).not.toMatch(/context/iu);
    expect(sources?.lines[0]).not.toMatch(/context/iu);
  });
});

describe("the footer", () => {
  it("links to the docs, the comparison and the repository", () => {
    expect(footer.links).toEqual([
      { label: "Docs", href: "/docs/" },
      { label: "Compare", href: "/docs/compare" },
      { label: "GitHub", href: repositoryUrl },
    ]);
  });

  it("leads to a comparison page that exists", () => {
    expect(existsSync(new URL("../../docs/docs/compare.mdx", import.meta.url))).toBe(true);
    expect(siteUrl("/docs/compare")).toBe("https://tackup.dev/docs/compare");
  });
});
