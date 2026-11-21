import { describe, expect, it } from "vitest";
import { makeDemoSession, shellWords } from "../../demo/demo-shell.ts";
import { groundRules, lenses, profileFigure } from "./content.ts";

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
