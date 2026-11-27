import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { agentsFigure, intro, lenses, sharedAgents } from "../features-page/content.ts";
import { definingSentence, features, hero, questions } from "./content.ts";

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
