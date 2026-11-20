import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { figureReference } from "@tackup/reader/figure-reference";

const skill = resolve(import.meta.dirname, "../src/builtins/skills/write-reader-figures");

it("ships the component reference generated from the reader's contracts", () => {
  // Run `bun run figures:reference` after changing a contract in packages/reader.
  expect(readFileSync(join(skill, "references/figure-components.md"), "utf8")).toBe(
    figureReference(),
  );
});

it("teaches the catalog that exists, the figure check, and grounds as a default", () => {
  const text = readFileSync(join(skill, "SKILL.md"), "utf8");
  for (const name of [
    "ArchitectureMap",
    "System",
    "Links follow the data",
    "Schema",
    "Entity names in boxes",
    "FileTree",
    "`tree` block",
    "Walkthrough",
    "Chart",
    "## 8. Authored figures",
    "tack check",
  ])
    expect(text, name).toContain(name);
  // Removed components must not come back through the guidance.
  expect(text).not.toMatch(/\b(?:Flow)?Diagram\b/);
  expect(text.replaceAll(/\s+/g, " ")).toContain("It is a default the reader picks");
});
