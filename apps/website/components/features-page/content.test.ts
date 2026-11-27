import { agentAdapterDescriptors } from "@tackup/cli/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeDemoSession, shellWords } from "../../demo/demo-shell.ts";
import { getStarted } from "../landing/content.ts";
import {
  agentsFigure,
  groundRules,
  install,
  intro,
  lenses,
  previewFigure,
  profileFigure,
  sharedAgents,
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
  it("installs from npm, with the landing's command", () => {
    expect(install.commands).toEqual(["npm install --global @tackup/cli"]);
    expect(install.commands[0]).toBe(getStarted.commands[0]);
  });

  it("no longer says Tack is missing from npm or installs from a checkout", () => {
    const page = JSON.stringify([intro, install, lenses, groundRules]);
    expect(page).not.toContain("npm yet");
    expect(page).not.toContain("install:local");
    expect(page).not.toContain("checkout");
  });
});

describe("features page limits", () => {
  /** The agent names a sentence lists, by the agents the skills figure names. */
  const named = (sentence: string) =>
    agentsFigure.links.map((link) => link.agent).filter((agent) => sentence.includes(agent));

  it("leads the limits with what Tack does not do yet, and links to it from the head", () => {
    expect(groundRules.notYetHeading).toBe("What Tack does not do yet");
    expect(intro.limitsLink.startsWith(groundRules.notYetHeading)).toBe(true);
    expect(groundRules.notYet.map((limit) => limit.title)).toEqual([
      "Deliver context.",
      "Commands for every agent.",
      "Deliver without symbolic links.",
    ]);
  });

  it("names exactly the agents that take commands, then every other one", () => {
    const commandLimit = groundRules.notYet.find((limit) => limit.title.startsWith("Commands"));
    const [reach = "", without = ""] = commandLimit?.text.split(". ") ?? [];
    const takers: ReadonlyArray<string> = agentsFigure.commands.map((link) => link.agent);
    expect(named(reach).toSorted()).toEqual(takers.toSorted());
    expect(named(without).toSorted()).toEqual(
      agentsFigure.links
        .map((link) => link.agent)
        .filter((agent) => !takers.includes(agent))
        .toSorted(),
    );
  });

  it("lists the same limits in the README as on the page", () => {
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

describe("features page shared agents", () => {
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

  it("lists the same agents, folders and scopes in the CLI guide as on the page", () => {
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
    const adapterAgents = agentsFigure.links.map((link) => link.agent);
    for (const row of sharedAgents.rows) expect(adapterAgents).not.toContain(row.agent);
  });
});
