import { agentAdapterDescriptors } from "@tackup/cli/core";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { groundRules, lenses, sharedAgents } from "./components/features-page/content.ts";
import { makeDemoSession, shellWords } from "./demo/demo-shell.ts";
import config from "./rspress.config.ts";

const docsRoot = new URL("./docs/docs/", import.meta.url);

/** Every docs page, as its route under `/docs/` and its source text. */
const pages = readdirSync(docsRoot, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".mdx"))
  .map((path) => ({
    route: `/docs/${path.replace(/\.mdx$/u, "").replace(/(^|\/)index$/u, "$1")}`,
    text: readFileSync(new URL(path, docsRoot), "utf8"),
  }));

const pageText = (route: string): string => {
  const page = pages.find((candidate) => candidate.route === route);
  if (page === undefined) throw new Error(`No docs page at ${route}`);
  return page.text;
};

/**
 * The Tack commands a page shows: the `commands` of each `<Terminal>`, the lines of `sh` fences
 * and inline code, each starting with `tack `.
 */
const commandsOf = (page: string): ReadonlyArray<string> => {
  // The outputs a page exports are what Tack printed, not commands it shows.
  const text = page.replaceAll(/^export const \w+ = \[[\s\S]*?\]\.join\("\\n"\);$/gmu, "");
  const terminals = [...text.matchAll(/commands=\{\[([^\]]*)\]\}/gu)].flatMap((match) =>
    [...(match[1] ?? "").matchAll(/"([^"]*)"|'([^']*)'/gu)].map(
      (quoted) => quoted[1] ?? quoted[2] ?? "",
    ),
  );
  const fences = [...text.matchAll(/```sh\n([\s\S]*?)```/gu)].flatMap((match) =>
    (match[1] ?? "").split("\n"),
  );
  const inline = [...text.matchAll(/`(tack [^`]+)`/gu)].map((match) => match[1] ?? "");
  return [...terminals, ...fences, ...inline]
    .map((line) => line.replace(/\s+#.*$/u, "").trim())
    .filter((line) => line.startsWith("tack "));
};

/** The words of a command before `--`, where a script's own arguments start. */
const tackWords = (command: string) => {
  const words = shellWords(command);
  const end = words.indexOf("--");
  return end === -1 ? words : words.slice(0, end);
};

const escape = String.fromCharCode(27);
const plain = (text: string) => text.replaceAll(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");

/** Each distinct command the docs pages show. */
const commands = [...new Set(pages.flatMap((page) => commandsOf(page.text)))];

describe("docs page commands", () => {
  it("finds the commands of every guide", () => {
    expect(commands.length).toBeGreaterThan(60);
  });

  it.each(commands)("%s is a real command with real flags", async (command) => {
    const words = tackWords(command);
    const session = makeDemoSession();
    const help = plain((await session.run([...words, "--help"].join(" "), 100)).output);
    const header = /^tack help · (.+) · ✓ success$/mu.exec(help);
    expect(header, help).not.toBeNull();
    const path = header?.[1] ?? "";
    if (path === "root") {
      // A bare root command, such as `tack --version`, has only root flags.
      expect(words.slice(1).every((word) => word.startsWith("--"))).toBe(true);
    } else {
      expect(words.slice(1).join(" ").startsWith(path)).toBe(true);
    }
    for (const flag of words.filter((word) => word.startsWith("--")))
      expect(help).toMatch(new RegExp(`${flag}\\b`, "u"));
  });
});

describe("docs navigation", () => {
  const sidebar = config.themeConfig?.sidebar?.["/docs/"] ?? [];
  const links = JSON.stringify(sidebar)
    .match(/"link":"[^"]+"/gu)
    ?.map((link) => link.slice('"link":"'.length, -1));

  it("links every page from the sidebar, and only pages that exist", () => {
    expect(links?.toSorted()).toEqual(pages.map((page) => page.route).toSorted());
  });

  it("links every relative page link to a page that exists", () => {
    for (const page of pages) {
      for (const match of page.text.matchAll(/\]\((\.{1,2}\/[^)#]*)(#[^)]*)?\)/gu)) {
        const base = page.route.endsWith("/") ? page.route : page.route.replace(/[^/]*$/u, "");
        const target = new URL(match[1] ?? "", `https://tack.test${base}`).pathname;
        expect(
          pages.map((candidate) => candidate.route),
          `${page.route} links ${match[1]}`,
        ).toContain(target);
      }
    }
  });
});

describe("features reference", () => {
  const text = pageText("/docs/features");

  it("has a section for each part of the features page, in its order", () => {
    const headings = [...text.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
    const names: ReadonlyArray<string> = lenses.map((lens) => lens.name);
    expect(headings.filter((heading) => heading !== undefined && names.includes(heading))).toEqual(
      names,
    );
  });

  it("lists what Tack does not do yet and does not do, as the features page does", () => {
    const section = (heading: string) =>
      text
        .split(`## ${heading}\n`)[1]
        ?.split("\n## ")[0]
        ?.split("\n")
        .flatMap((line) => /^- \*\*(.+?)\*\*/u.exec(line)?.[1] ?? []);
    expect(section(groundRules.notYetHeading)).toEqual(
      groundRules.notYet.map((limit) => limit.title),
    );
    expect(section(groundRules.limitsHeading)).toEqual(
      groundRules.limits.map((limit) => limit.title),
    );
  });

  it("names every adapter's project and user skill folders", () => {
    for (const adapter of agentAdapterDescriptors) {
      expect(text).toContain(`\`${adapter.projectSkillDirectory.join("/")}\``);
      expect(text).toContain(`\`~/${adapter.userSkillDirectory.join("/")}\``);
    }
  });

  it("names the command folders of exactly the adapters that take commands", () => {
    for (const adapter of agentAdapterDescriptors) {
      if ("projectCommandDirectory" in adapter && adapter.projectCommandDirectory !== undefined) {
        expect(text).toContain(`\`${adapter.projectCommandDirectory.join("/")}\``);
        expect(text).toContain(`\`~/${adapter.userCommandDirectory?.join("/")}\``);
      }
    }
  });

  it("lists every agent reached through a shared folder, with its folder and scope", () => {
    for (const row of sharedAgents.rows) {
      const line = text.split("\n").find((candidate) => candidate.includes(`[${row.agent}]`));
      expect(line, row.agent).toBeDefined();
      expect(line).toContain(`(${row.href})`);
      expect(line).toContain(`\`${row.folder}\``);
      expect(line).toContain(row.scope);
    }
  });
});

describe("agent support", () => {
  const lines = pageText("/docs/agent-support").split("\n");
  /** The table rows whose first cell names `agent`, as their trimmed cells. */
  const rows = (agent: string) =>
    lines
      .filter((line) => line.startsWith(`| ${agent} `) || line.startsWith(`| [${agent}]`))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
  const row = (agent: string) => rows(agent)[0];
  const names: Record<string, string> = {
    claude: "Claude Code",
    cline: "Cline",
    codex: "Codex",
    copilot: "GitHub Copilot CLI",
    cursor: "Cursor",
    gemini: "Gemini CLI",
    opencode: "OpenCode",
    pi: "Pi",
  };
  const code = (path: string) => `\`${path}\``;

  it.each(agentAdapterDescriptors)("lists the $id adapter's folders", (adapter) => {
    const [skills, commandRow] = rows(names[adapter.id] ?? adapter.id);
    expect(skills?.slice(1, 4)).toEqual([
      code(adapter.id),
      code(adapter.projectSkillDirectory.join("/")),
      code(`~/${adapter.userSkillDirectory.join("/")}`),
    ]);
    if ("projectCommandDirectory" in adapter && adapter.projectCommandDirectory !== undefined) {
      expect(commandRow?.slice(1, 4)).toEqual([
        code(adapter.id),
        code(adapter.projectCommandDirectory.join("/")),
        code(`~/${adapter.userCommandDirectory?.join("/")}`),
      ]);
    } else {
      expect(commandRow).toBeUndefined();
    }
  });

  it.each(sharedAgents.rows)("lists $agent with its folder and scope", (shared) => {
    const cells = row(shared.agent);
    expect(cells?.[0]).toBe(`[${shared.agent}](${shared.href})`);
    expect(cells?.[1]).toBe(shared.scope === "User only" ? "-" : code(shared.folder));
    expect(cells?.[2]).toBe(shared.scope === "Project only" ? "-" : code(`~/${shared.folder}`));
    expect(cells?.[3]).toBe(`${shared.scope}${"note" in shared ? `, ${shared.note}` : ""}`);
  });
});

describe("docs privacy", () => {
  it("uses only the neutral example home", () => {
    for (const page of pages) {
      expect(page.text, page.route).not.toMatch(/\/Users\/(?!ada\b)|\/private\/|\/var\/folders/u);
    }
  });
});
