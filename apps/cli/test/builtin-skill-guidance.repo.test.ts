import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { guideTopics } from "../src/domain/guides/guide-schema.ts";
import { readContracts } from "./support/contracts.ts";
import { sourceEntrypoint as entrypoint } from "./support/tack-process.ts";

/**
 * A path counts as documented by `tack <path>` only when the next word is not a
 * subcommand, so `tack docs search` does not document `docs`.
 */
const undocumentedCommands = (
  commandPaths: ReadonlyArray<ReadonlyArray<string>>,
  text: string,
): ReadonlyArray<string> =>
  commandPaths
    .map((path) => path.join(" "))
    .filter((command, _, commands) => {
      const subcommands = new Set(
        commands
          .filter((other) => other.startsWith(`${command} `))
          .map((other) => other.slice(command.length + 1).split(" ")[0]),
      );
      return ![...text.matchAll(new RegExp(`tack ${command}(?![\\w-])( [\\w-]+)?`, "g"))].some(
        ([, next]) => next === undefined || !subcommands.has(next.trim()),
      );
    });

it("documents every executable command of the command tree in the use-tack skill", async () => {
  const { commands } = await readContracts();
  const commandPaths = commands.map(({ commandPath }) => commandPath);
  const skill = resolve(dirname(entrypoint), "builtins/skills/use-tack");
  const text = ["SKILL.md", "references/operations.md"]
    .map((file) => readFileSync(join(skill, file), "utf8"))
    .join("\n");

  expect(commandPaths.length).toBeGreaterThan(30);
  expect(undocumentedCommands(commandPaths, text)).toEqual([]);
  // The skill teaches the text view: no command example carries `--json`.
  expect(text).not.toMatch(/(?<![\w-])(?:bun )?tack (?:--[\w-]+ )*--json\b/);
  // The check itself must notice a command that only a longer sibling mentions.
  expect(undocumentedCommands([["docs"], ["docs", "search"]], "tack docs search QUERY")).toEqual([
    "docs",
  ]);
  expect(undocumentedCommands([["catalog"]], "run catalog")).toEqual(["catalog"]);
  for (const path of commandPaths) {
    const command = path.join(" ");
    const without = text.replaceAll(new RegExp(`tack ${command}(?![\\w-])`, "g"), "tack");
    expect(undocumentedCommands(commandPaths, without), command).toContain(command);
  }
});

it("tells agents to use --user for an everywhere request and --all only for every project", () => {
  const skill = resolve(dirname(entrypoint), "builtins/skills/use-tack/SKILL.md");
  const text = readFileSync(skill, "utf8").replaceAll(/\s+/g, " ");
  // Real Claude Code and Codex sessions ran --all for "install this skill for me everywhere".
  expect(text).toContain('"for me", "everywhere" or "globally" means `--user`');
  expect(text).toContain("do not add `--all` in response");
  expect(text).toContain("state its selector and targets in your reply before you apply");
  expect(text).toContain("only when the operator asks for every project by name or number");
});

it("ships manage-tack-sources as one short skill that matches the commands", async () => {
  const { commands } = await readContracts();
  const known = new Set(commands.map(({ commandPath }) => commandPath.join(" ")));
  const directory = resolve(dirname(entrypoint), "builtins/skills/manage-tack-sources");
  // One short skill, plus the references it links: the rules of each declaration entry, the
  // resource metadata, dependency rules, the script API and a complete worked source.
  expect(readdirSync(directory).toSorted()).toEqual(["SKILL.md", "references"]);
  expect(readdirSync(join(directory, "references")).toSorted()).toEqual([
    "metadata.md",
    "scripts.md",
    "tack-yaml.md",
    "worked-source.md",
  ]);
  const text = readFileSync(join(directory, "SKILL.md"), "utf8");
  const description = /^description: (.+)$/m.exec(text)?.[1] ?? "";
  expect(description.length).toBeGreaterThan(100);
  expect(description.length).toBeLessThanOrEqual(300);
  expect(text.split("\n").length).toBeLessThan(200);

  // Every Tack call reads the text view, and names a command the release publishes.
  expect(text).not.toMatch(/(?<![\w-])(?:bun )?tack (?:--[\w-]+ )*--json\b/);
  for (const [, words] of text.matchAll(/tack ((?:[a-z]+ ?)+)/g)) {
    const path = (words ?? "").trim().split(" ");
    expect(
      path.some((_, length) => known.has(path.slice(0, length + 1).join(" "))),
      words,
    ).toBe(true);
  }

  // The outline: advice about maintainers, the declared keys, and the repair of removed layout.
  const flat = text.replaceAll(/\s+/g, " ");
  expect(flat).toContain(
    "`maintainers` is descriptive contact information, not an edit permission",
  );
  const workedSource = readFileSync(join(directory, "references/worked-source.md"), "utf8");
  const guide = `${text}\n${workedSource}`;
  for (const key of ["version: 1", "name:", "maintainers:", "depends-on:", "docs:"])
    expect(guide).toContain(key);
  for (const word of ["tack source", "tack catalog", "source add", "source relocate"])
    expect(text).toContain(word);
  expect(text).toContain("`source:name`");
  expect(text).toContain("references/worked-source.md");
  expect(text).not.toMatch(/edits\s*:/);
});

it("ships the guides `tack guide` prints, and points agents at the command, not the file", () => {
  const directory = resolve(dirname(entrypoint), "builtins/skills/use-tack");
  const read = (file: string) => readFileSync(join(directory, file), "utf8");
  const skill = read("SKILL.md");
  // Every reference the skill links ships beside it.
  for (const [, path = ""] of skill.matchAll(/\]\((references\/[\w-]+\.md)\)/g))
    expect(readdirSync(join(directory, "references")), path).toContain(
      path.slice("references/".length),
    );
  // A guide reaches an agent the same way from the skill, `tack init` and the landing prompt.
  for (const topic of guideTopics) {
    expect(readdirSync(join(directory, "references"))).toContain(`${topic}.md`);
    expect(skill, topic).not.toContain(`references/${topic}.md`);
    // Printed, a guide has no folder: a relative link in it leads nowhere.
    expect(read(`references/${topic}.md`), topic).not.toMatch(/\]\((?!https?:)[^)]*\)/);
    // `tack guide` lists a guide by its first line, its title.
    expect(read(`references/${topic}.md`), topic).toMatch(/^# \S/);
  }
  expect(skill).toContain("`tack guide onboarding`");
  expect(skill).toContain("`tack guide day-two`");
  for (const topic of ["onboarding", "day-two"])
    expect(read(`references/${topic}.md`), topic).toContain("`tack guide agent-instructions`");
  expect(skill.replaceAll(/\s+/g, " ")).toContain("`doctor`, except during onboarding");

  const guide = read("references/onboarding.md");
  const flat = guide.replaceAll(/\s+/g, " ");
  const steps = [...guide.matchAll(/^## (\d\w?)\. /gm)].map(([, step]) => step);
  expect(steps).toEqual(["1", "2", "3", "4", "5", "6", "6b", "7"]);
  // Worker mode needs an explicit statement, or `CI` as the backup signal.
  expect(flat).toContain("only when your instructions say no person will answer");
  expect(flat).toContain("the environment variable `CI` is set");
  expect(flat).toContain("Quick: steps 1, 3, 5, 6, 6b and 7");
  // One yes per step, over previews shown together, and nothing unseen.
  expect(flat).toContain("One yes per step that changes something");
  expect(flat).toContain('"yes except X"');
  expect(flat).toContain("Never apply or run anything that was not shown in that step.");
  // The person may still ask for the ignore lines of step 6, which status prints.
  expect(flat).toContain("Never edit `.gitignore` unless the person asks you to in step 6.");
  expect(flat).toContain("`tack status --project NAME --details`");
  expect(flat).toContain("its line never ends with `/`");
  expect(flat).toContain("names the docs mount folder, such as `/.tack/`, and ends with `/`");
  // A skill picked for everywhere reaches each project through the user's folder.
  expect(flat).toContain("`skip … linked for the user`");
  expect(flat).not.toContain("selected-twice");
  expect(flat).toContain("never stops setup");
  expect(flat).toContain("To undo, each with a preview first");
  expect(flat).toContain("After upgrading Tack, run `tack init` again.");
  // init writes at once, so the guide names it before running it.
  expect(flat).toContain("`tack init` writes at once and has no preview.");

  const dayTwo = read("references/day-two.md");
  for (const heading of [
    "A new project",
    "A new worktree or clone",
    "A new source",
    "A skill everywhere",
  ])
    expect(dayTwo).toContain(`## ${heading}`);
  expect(read("references/operations.md").replaceAll(/\s+/g, " ")).toContain(
    "After an upgrade, `tack init` relinks them to the new version.",
  );
});

it("ships prepare-tack-checkout and the agent instructions section it looks for", () => {
  const builtins = resolve(dirname(entrypoint), "builtins/skills");
  const read = (file: string) => readFileSync(join(builtins, file), "utf8");
  // One small skill: every new checkout loads it, so its body stays short.
  expect(readdirSync(join(builtins, "prepare-tack-checkout"))).toEqual(["SKILL.md"]);
  const skill = read("prepare-tack-checkout/SKILL.md");
  const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
  expect(description.split(" ").length).toBeLessThanOrEqual(55);
  expect(skill).toContain("user-activation: default");
  expect(skill.split(/\s+/).length).toBeLessThan(600);

  // The section the skill detects is the one the reference tells agents to write.
  const guide = read("use-tack/references/agent-instructions.md");
  const section = /```md\n(<!-- tack-block v\d+ -->\n[\s\S]*?\n<!-- \/tack-block -->)\n```/.exec(
    guide,
  )?.[1];
  expect(section).toBeDefined();
  const [, version] = /^<!-- (tack-block v\d+) -->/.exec(section ?? "") ?? [];
  expect(skill).toContain(`\`${version}\``);
  expect(section).toContain("`prepare-tack-checkout`");
  expect(section).toContain("project `PROJECT`");
  // The section is committed to the repository, so it names no path of this machine.
  const body = (section ?? "").split("\n").slice(1, -1).join("\n");
  expect(body).not.toMatch(/(?:^|\s)[~/]\S/m);

  const flat = `${skill}\n${guide}`.replaceAll(/\s+/g, " ");
  // The section is the standing approval for the bridge, for its project only.
  expect(flat).toContain("standing approval");
  expect(flat).toContain("for this project only");
  // AGENTS.md; CLAUDE.md as well when both exist and CLAUDE.md does not import AGENTS.md, or alone
  // when it is the only one; never a new CLAUDE.md.
  expect(flat).toContain(
    "Both exist and `CLAUDE.md` imports `AGENTS.md` (a line `@AGENTS.md`): write it to `AGENTS.md` only.",
  );
  expect(flat).toContain("Both exist otherwise: write it to both.");
  expect(flat).toContain("Only `CLAUDE.md` exists");
  expect(flat).toContain("`@AGENTS.md`");
  expect(flat).toContain("Never create `CLAUDE.md`.");
  expect(flat).toContain("Never commit it.");
  // A clone takes the section's name; a taken name becomes NAME-FOLDER for workers.
  expect(flat).toContain("`project-registration-conflict`");
  expect(flat).toContain("`PROJECT-FOLDER`");
});
