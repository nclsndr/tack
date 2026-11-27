import { agentAdapterDescriptors } from "@tackup/cli/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeDemoSession, shellWords } from "../../demo/demo-shell.ts";
import { features, questions } from "../landing/content.ts";
import { groundRules, lenses, profileFigure, sharedAgents } from "./content.ts";

const escape = String.fromCharCode(27);
const plain = (text: string) => text.replaceAll(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");

/**
 * Every command the features data holds, from proofs, details, the ground rules and the profile
 * figure, and every proof the landing page's features print.
 */
const commands = [
  ...[
    features.team,
    features.projects,
    features.agents,
    features.docs,
    features.profiles,
    ...features.also.items,
  ].map((block) => block.proof),
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

describe("features commands", () => {
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

/** The agent of each CLI adapter, as the landing page's agents figure names it, in adapter order. */
const adapterAgents: ReadonlyArray<string> = features.agents.links.destinations.map(
  (link) => link.agent,
);

/** The agents of the adapters that take commands. */
const commandTakers = adapterAgents.filter((_, index) => {
  const adapter = agentAdapterDescriptors[index];
  return adapter !== undefined && "projectCommandDirectory" in adapter
    ? adapter.projectCommandDirectory !== undefined
    : false;
});

describe("features limits", () => {
  /** The agent names a sentence lists, by the agents of the CLI adapters. */
  const named = (sentence: string) => adapterAgents.filter((agent) => sentence.includes(agent));

  /** The landing page's question on what Tack does not do yet. */
  const notYetQuestion = questions.find((item) => item.question === "What doesn't Tack do yet?");

  it("leads the limits with what Tack does not do yet, and asks it on the landing page", () => {
    expect(groundRules.notYetHeading).toBe("What Tack does not do yet");
    expect(notYetQuestion).toBeDefined();
    expect(groundRules.notYet.map((limit) => limit.title)).toEqual([
      "Deliver context.",
      "Commands for every agent.",
      "Deliver without symbolic links.",
    ]);
  });

  /** The command limit as the limits say it, then as the landing page's answer says it. */
  const commandLimit =
    groundRules.notYet.find((limit) => limit.title.startsWith("Commands"))?.text ?? "";
  const answerCommands =
    notYetQuestion?.answer.split(". ").find((sentence) => sentence.startsWith("Commands")) ?? "";

  it.each([
    ["the limits", commandLimit.split(". ")],
    ["the landing page's answer", answerCommands.split("; ")],
  ])("%s name exactly the agents that take commands, then every other one", (_, parts) => {
    const [reach = "", without = ""] = parts;
    expect(named(reach).toSorted()).toEqual([...commandTakers].toSorted());
    expect(named(without).toSorted()).toEqual(
      adapterAgents.filter((agent) => !commandTakers.includes(agent)).toSorted(),
    );
  });

  it("puts every limit in the landing page's answer", () => {
    const answer = notYetQuestion?.answer ?? "";
    for (const word of ["context", "Commands", "symbolic link", "Windows"])
      expect(answer).toContain(word);
  });

  it("lists the same limits in the README as the features data", () => {
    const readme = readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");
    const section = readme.slice(readme.indexOf(`## ${groundRules.notYetHeading}`));
    const bullets = section
      .slice(0, section.indexOf("\n## ", 1))
      .split("\n- ")
      .slice(1)
      .map((bullet) => bullet.replaceAll(/\s+/gu, " ").trim());
    expect(bullets).toEqual(groundRules.notYet.map((limit) => `**${limit.title}** ${limit.text}`));
  });
});

describe("features shared agents", () => {
  const readme = readFileSync(new URL("../../../cli/README.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf("### Agents reached through a shared folder"));
  /** The table rows of the README section, as agent, link, folder and the scopes cell. */
  const tableRows = section
    .split("\n")
    .filter((line) => line.startsWith("| ["))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      const link = /^\[(.+)\]\((.+)\)$/u.exec(cells[1] ?? "");
      return [link?.[1], link?.[2], cells[2], cells[3]];
    });

  it("lists the same agents, folders and scopes in the CLI guide as the features data", () => {
    expect(tableRows).toEqual(
      sharedAgents.rows.map((row) => [
        row.agent,
        row.href,
        `\`${row.folder}\``,
        `${row.scope}${"note" in row ? `, ${row.note}` : ""}`,
      ]),
    );
  });

  it("names no agent that has an adapter of its own", () => {
    for (const row of sharedAgents.rows) expect(adapterAgents).not.toContain(row.agent);
  });
});
