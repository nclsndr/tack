import { agentAdapterDescriptors } from "@tackup/cli/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { intro, lenses, sharedAgents } from "../features-page/content.ts";
import { definingSentence, features, hero, questions } from "./content.ts";

/** A file of the repository, read from its root. */
const repoFile = (path: string) =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

/** Text with its line breaks and runs of spaces folded into single spaces. */
const folded = (text: string) => text.replaceAll(/\s+/gu, " ");

describe("features.agents.links", () => {
  it("shows one project skill link per CLI adapter, at the adapter's own folder", () => {
    // The landing page cannot import the CLI eagerly, so its figure repeats the adapter table and
    // this test keeps the two in step.
    const skill = features.agents.links.source.split("/").at(-1);
    expect(features.agents.links.destinations.map((link) => link.path)).toEqual(
      agentAdapterDescriptors.map((adapter) => [...adapter.projectSkillDirectory, skill].join("/")),
    );
  });
});

describe("the hero", () => {
  it("names the agent of every CLI adapter under the lead line", () => {
    for (const link of features.agents.links.destinations)
      expect(hero.agents).toContain(link.agent);
  });

  it("counts the agents reached through a shared folder from the features page's table", () => {
    expect(features.agents.lines[0]).toContain(`${sharedAgents.rows.length} more agents`);
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
