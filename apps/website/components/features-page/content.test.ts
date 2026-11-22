import { agentAdapterDescriptors } from "@tackup/cli/core";
import { describe, expect, it } from "vitest";
import { makeDemoSession, shellWords } from "../../demo/demo-shell.ts";
import {
  agentsFigure,
  groundRules,
  install,
  intro,
  lenses,
  previewFigure,
  profileFigure,
} from "./content.ts";

const escape = String.fromCharCode(27);
const plain = (text: string) => text.replaceAll(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");

/** Every command the page prints, from proofs, details, the ground rules and the figures. */
const commands = [
  ...lenses.flatMap((lens) => [
    lens.proof,
    ...lens.details.flatMap((detail) => ("command" in detail ? [detail.command] : [])),
  ]),
  ...groundRules.rules.flatMap((rule) => ("command" in rule ? [rule.command] : [])),
  ...profileFigure.steps.flatMap((step) => ("command" in step ? [step.command] : [])),
  previewFigure.command,
];

/** The words of a command before `--`, where a script's own arguments start. */
const tackWords = (command: string) => {
  const words = shellWords(command);
  const end = words.indexOf("--");
  return end === -1 ? words : words.slice(0, end);
};

describe("features page commands", () => {
  it("prints only Tack commands", () => {
    expect(commands.length).toBeGreaterThan(20);
    for (const command of commands) expect(command.startsWith("tack ")).toBe(true);
  });

  it.each(commands)("%s is a real command with real flags", async (command) => {
    const words = tackWords(command);
    const session = makeDemoSession();
    const help = plain((await session.run([...words, "--help"].join(" "), 100)).output);
    const header = /^tack help · (.+) · ✓ success$/mu.exec(help);
    expect(header, help).not.toBeNull();
    const path = header?.[1] ?? "";
    // The CLI resolved the command's own leading words, not a shorter path or the root.
    expect(path).not.toBe("root");
    expect(words.slice(1).join(" ").startsWith(path)).toBe(true);
    for (const flag of words.filter((word) => word.startsWith("--")))
      expect(help).toMatch(new RegExp(`${flag}\\b`, "u"));
  });
});

/** The folder a figure row links into: its path without the skill or command it names. */
const folder = (path: string) => path.split("/").slice(0, -1).join("/");

describe("features page agents", () => {
  it("draws a skill link for every adapter, in its project skills folder", () => {
    expect(agentsFigure.links.map((link) => folder(link.path)).toSorted()).toEqual(
      agentAdapterDescriptors.map((adapter) => adapter.projectSkillDirectory.join("/")).toSorted(),
    );
  });

  it("draws a command link for exactly the adapters that take commands", () => {
    expect(agentsFigure.commands.map((link) => folder(link.path)).toSorted()).toEqual(
      agentAdapterDescriptors
        .flatMap((adapter) =>
          "projectCommandDirectory" in adapter && adapter.projectCommandDirectory !== undefined
            ? [adapter.projectCommandDirectory.join("/")]
            : [],
        )
        .toSorted(),
    );
  });
});

describe("features page install", () => {
  it("installs from a checkout and never from npm", () => {
    expect(intro.facts).toContain("Not on npm yet");
    expect(install.commands.at(-1)).toBe("bun run install:local");
    expect(JSON.stringify([intro, install, lenses, groundRules])).not.toContain("npm install");
  });
});
