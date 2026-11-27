import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { definingSentence, getStarted } from "./landing/content.ts";

/** A file of the repository, read from its root, as bytes. */
const repoBytes = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url));

const skill = repoBytes("skills/set-up-tack/SKILL.md").toString("utf8");
const frontmatter = /^---\nname: (.+)\ndescription: (.+)\n---\n/u.exec(skill);
const index = JSON.parse(
  repoBytes("apps/website/docs/public/.well-known/agent-skills/index.json").toString("utf8"),
);

describe("the set-up-tack skill that skill installers find", () => {
  it("says what Tack is, word for word, and how to install it", () => {
    expect(skill).toContain(definingSentence);
    expect(skill).toContain(`\`${getStarted.commands[0]}\``);
  });

  it("hands every later step to the guide of the installed version", () => {
    expect(skill).toContain("`tack guide onboarding`");
  });

  it("has a name and a description within the Agent Skills limits", () => {
    expect(frontmatter?.[1]).toBe("set-up-tack");
    expect(frontmatter?.[2]?.length).toBeLessThanOrEqual(1024);
  });
});

describe("the site's agent skills index", () => {
  it("lists the skill with its own name and description, at the address the site serves it", () => {
    expect(index).toEqual({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name: frontmatter?.[1],
          type: "skill-md",
          description: frontmatter?.[2],
          url: "/.well-known/agent-skills/set-up-tack/SKILL.md",
          digest: `sha256:${createHash("sha256").update(repoBytes("skills/set-up-tack/SKILL.md")).digest("hex")}`,
        },
      ],
    });
  });
});
