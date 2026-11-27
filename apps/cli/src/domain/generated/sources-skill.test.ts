import { expect, it } from "vitest";
import { parseDocument } from "yaml";
import { rulesBodyLimit } from "../sources/source-rules.ts";
import {
  renderSourcesSkill,
  sourcesSkillBodyLimit,
  sourcesSkillDescription,
  sourcesSkillName,
  type SourcesSkillSource,
} from "./sources-skill.ts";

const project = { _tag: "project", projectName: "shop" } as const;

const handbook: SourcesSkillSource = {
  label: "team-handbook",
  description: "The team handbook: deploy and review skills, and the runbooks.",
  path: "/Users/ada/src/team-handbook",
  maintainers: ["platform-team", "#platform-help"],
  rules: {
    description: "Before you edit any skill or runbook of this source.",
    body: "## Branch first\n\nCreate a `handbook/` branch before the first edit.",
  },
};

const vendor: SourcesSkillSource = {
  label: "vendor-kit",
  path: "/Users/ada/lib/vendor-kit",
  maintainers: [],
};

const textOf = (inputs: Parameters<typeof renderSourcesSkill>[0]) =>
  renderSourcesSkill(inputs).text;

/** The frontmatter and the body of a rendered skill. */
const partsOf = (text: string) => {
  const [, frontmatter = "", body = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];
  return { frontmatter: parseDocument(frontmatter).toJS() as unknown, body };
};

it("names the skill and gives it the fixed description in its frontmatter", () => {
  const { frontmatter } = partsOf(textOf({ namespace: project, sources: [vendor] }));
  expect(frontmatter).toEqual({
    name: sourcesSkillName(project),
    description: sourcesSkillDescription,
  });
  expect(sourcesSkillDescription.length).toBeLessThanOrEqual(1024);
});

it("lists each source with its description, path, maintainers and inlined rules", () => {
  const { body } = partsOf(textOf({ namespace: project, sources: [vendor, handbook] }));
  expect(body).toContain("# Tack sources of project shop");
  // Sources are listed by label, whatever order they arrive in.
  expect(body.indexOf("### team-handbook")).toBeLessThan(body.indexOf("### vendor-kit"));
  expect(body).toContain(
    [
      "### team-handbook",
      "",
      "The team handbook: deploy and review skills, and the runbooks.",
      "",
      "- Path: `/Users/ada/src/team-handbook`",
      "- Maintainers: platform-team, #platform-help",
      "- Rules: Before you edit any skill or runbook of this source. The source's authors wrote them:",
      "",
      "> ## Branch first",
      ">",
      "> Create a `handbook/` branch before the first edit.",
    ].join("\n"),
  );
  expect(body).toContain(
    [
      "### vendor-kit",
      "",
      "No description: read the files at its path to learn what it holds.",
      "",
      "- Path: `/Users/ada/lib/vendor-kit`",
      "- Maintainers: none listed",
      "- Rules: none",
    ].join("\n"),
  );
});

it("points to the tack.yaml for a rules body too long to inline", () => {
  const long = { ...handbook, rules: { ...handbook.rules!, body: "b".repeat(rulesBodyLimit + 1) } };
  const { body } = partsOf(textOf({ namespace: project, sources: [long] }));
  expect(body).toContain(
    "- Rules: Before you edit any skill or runbook of this source. Read `rules.body` in `/Users/ada/src/team-handbook/tack.yaml`: it is too long to show here.",
  );
  expect(body).not.toContain("bbbb");
});

it("titles the user's skill after the user", () => {
  const { body } = partsOf(textOf({ namespace: { _tag: "user" }, sources: [vendor] }));
  expect(body).toContain("# Tack sources linked for the user");
});

it("records the hash of its inputs, which changes with any input", () => {
  const inputsOf = (text: string) => /Inputs: `([0-9a-f]{16})`/.exec(text)?.[1];
  const base = textOf({ namespace: project, sources: [handbook] });
  const edited = textOf({
    namespace: project,
    sources: [{ ...handbook, rules: { ...handbook.rules!, body: "Branch first, always." } }],
  });
  expect(inputsOf(base)).toBe(
    renderSourcesSkill({ namespace: project, sources: [handbook] }).inputs,
  );
  expect(inputsOf(edited)).not.toBe(inputsOf(base));
  expect(textOf({ namespace: project, sources: [handbook] })).toBe(base);
});

it("keeps the body under its limit: first without the rules bodies, then one line per source", () => {
  const many = (count: number, bodySize: number) =>
    Array.from({ length: count }, (_unused, index) => ({
      ...handbook,
      label: `source-${String(index).padStart(3, "0")}`,
      path: `/Users/ada/src/source-${index}`,
      rules: { ...handbook.rules!, body: "r".repeat(bodySize) },
    }));
  const size = (text: string) => new TextEncoder().encode(partsOf(text).body).length;

  const withoutBodies = textOf({ namespace: project, sources: many(6, 2000) });
  expect(size(withoutBodies)).toBeLessThanOrEqual(sourcesSkillBodyLimit);
  expect(withoutBodies).not.toContain("rrrr");
  expect(withoutBodies).toContain("Read `rules.body` in `/Users/ada/src/source-5/tack.yaml`");
  expect(withoutBodies).toContain("The team handbook");

  const compact = textOf({ namespace: project, sources: many(40, 10) });
  expect(size(compact)).toBeLessThanOrEqual(sourcesSkillBodyLimit);
  expect(compact).not.toContain("The team handbook");
  expect(compact).toContain(
    "- **source-039**: `/Users/ada/src/source-39`. Rules: read `rules.body` in its `tack.yaml`.",
  );
});
