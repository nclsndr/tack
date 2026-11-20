import { describe, expect, it } from "vitest";
import { makeDemoSession, shellWords } from "./demo-shell.ts";
import { demoWalkthrough } from "./demo-walkthrough.ts";

const escape = String.fromCharCode(27);
const plain = (text: string) => text.replaceAll(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");

/** Runs lines in order on one session and returns the last result, with colors stripped. */
const runAll = async (
  session: ReturnType<typeof makeDemoSession>,
  lines: ReadonlyArray<string>,
) => {
  const results = [];
  for (const line of lines) results.push(await session.run(line, 80));
  const last = results.at(-1);
  return { ...last, output: plain(last?.output ?? "") };
};

describe("demo shell words", () => {
  it("splits on whitespace, groups quotes and expands the home", () => {
    expect(shellWords(`tack  source add ~/skills "two words" 'x y' ~ a~b`)).toEqual([
      "tack",
      "source",
      "add",
      "/home/you/skills",
      "two words",
      "x y",
      "/home/you",
      "a~b",
    ]);
  });
});

describe("demo session", () => {
  it("sets the machine up the way a first run does: tack init, then sources declared by folder", async () => {
    const session = makeDemoSession();
    const volume = session.machine().volume;
    const commands = demoWalkthrough.map((step) => step.command);

    expect(commands.filter((command) => command.startsWith("tack init"))).toEqual(["tack init"]);
    expect(commands.some((command) => /tack (state init|adapter enable)/.test(command))).toBe(
      false,
    );
    expect([
      volume.exists("/home/you/skills/tack.yaml"),
      volume.exists("/home/you/team-docs/tack.yaml"),
    ]).toEqual([false, false]);

    for (const step of demoWalkthrough) await session.run(step.command, 80);

    const text = (path: string) => new TextDecoder().decode(volume.readFile(path));
    expect(text("/home/you/skills/tack.yaml")).toBe("version: 1\nkind: skills\n");
    expect(text("/home/you/team-docs/tack.yaml")).toContain(
      "docs:\n  - name: handbook\n    path: handbook\n",
    );
  });

  it("runs the whole walkthrough through the real CLI and leaves the links it shows", async () => {
    const session = makeDemoSession();
    const outcomes = [];
    for (const step of demoWalkthrough) outcomes.push(await session.run(step.command, 80));
    const volume = session.machine().volume;

    expect(outcomes.map((outcome) => outcome.exitCode)).toEqual(demoWalkthrough.map(() => 0));
    expect(volume.readdir("/home/you/code/api/.claude/skills")).toEqual([
      "commit",
      "review",
      "ship",
    ]);
    expect(volume.readlink("/home/you/code/app/.cursor/skills/ship")).toBe(
      "../../../../skills/ship",
    );
    expect(volume.realpath("/home/you/.claude/skills/use-tack")).toBe(
      "/opt/tack/builtins/skills/use-tack",
    );
    expect(plain(outcomes.at(-1)?.output ?? "")).toContain("ship -> ../../../../skills/ship");
    expect(session.prompt()).toBe("~/skills");
  });

  it("starts with the team's command, a skill made by hand, and Git ignores, which reset restores", async () => {
    const session = makeDemoSession();
    const volume = () => session.machine().volume;
    const starting = () => [
      volume().readdir("/home/you/team-docs/commands"),
      volume().readdir("/home/you/.claude/skills"),
      volume().exists("/home/you/code/app/.gitignore"),
      volume().exists("/home/you/code/api/.gitignore"),
    ];
    const before = starting();

    expect(before).toEqual([["release.md"], ["my-notes"], true, true]);
    await runAll(session, ["tack init", "cd ~/code", "reset"]);
    expect([session.prompt(), volume().exists("/home/you/.tack"), ...starting()]).toEqual([
      "~",
      false,
      ...before,
    ]);
  });

  it("changes directory, prints it and refuses a file or a missing folder", async () => {
    const session = makeDemoSession();

    expect(await runAll(session, ["cd code/app", "pwd"])).toMatchObject({
      output: "/home/you/code/app\n",
      exitCode: 0,
    });
    expect(await runAll(session, ["cd ../../skills/../code/./api", "pwd"])).toMatchObject({
      output: "/home/you/code/api\n",
    });
    expect(await runAll(session, ["cd README.md"])).toMatchObject({
      output: "cd: ~/code/api/README.md: Not a directory\n",
      exitCode: 1,
    });
    expect(await runAll(session, ["cd /nowhere"])).toMatchObject({
      output: "cd: /nowhere: No such file or directory\n",
      exitCode: 1,
    });
    expect(await runAll(session, ["cd", "pwd"])).toMatchObject({ output: "/home/you\n" });
    expect(await runAll(session, ["cd /", "cd ..", "pwd"])).toMatchObject({ output: "/\n" });
  });

  it("lists folders, hides dotfiles unless asked and shows link targets in long form", async () => {
    const session = makeDemoSession();

    expect(await runAll(session, ["ls code/app"])).toMatchObject({ output: "README.md\n" });
    expect(await runAll(session, ["ls -a code/app"])).toMatchObject({
      output: ".git  .gitignore  README.md\n",
    });
    expect(await runAll(session, ["ls code/app/README.md"])).toMatchObject({
      output: "~/code/app/README.md\n",
    });
    expect(await runAll(session, ["ls code/app/.git/missing"])).toMatchObject({ exitCode: 1 });
    await runAll(session, ["cd /home/you/code/app", "ls -al"]);
    const linked = await runAll(session, [
      "tack init --adapter claude && tack source add ~/skills --skills . --apply",
      "tack project add app && tack sync --apply",
      "ls -l .claude/skills",
    ]);
    expect(linked.output).toBe(
      "commit -> ../../../../skills/commit\nreview -> ../../../../skills/review\n",
    );
    expect(await runAll(session, ["ls .claude/skills"])).toMatchObject({
      output: "commit  review\n",
    });
    expect(await runAll(session, ["mkdir empty"])).toMatchObject({ exitCode: 127 });
  });

  it("draws trees without .git and refuses to draw a file", async () => {
    const session = makeDemoSession();

    expect(await runAll(session, ["tree team-docs"])).toMatchObject({
      output: [
        "~/team-docs",
        "├── commands",
        "│   └── release.md",
        "└── handbook",
        "    ├── index.md",
        "    └── releases.md",
        "",
      ].join("\n"),
    });
    expect(await runAll(session, ["cd code/app", "tree"])).toMatchObject({
      output: "~/code/app\n├── .gitignore\n└── README.md\n",
    });
    expect(await runAll(session, ["tree README.md"])).toMatchObject({
      output: "tree: ~/code/app/README.md: Not a directory\n",
      exitCode: 1,
    });
    expect(await runAll(session, ["tree missing"])).toMatchObject({ exitCode: 1 });
  });

  it("prints files and reports a folder or a missing file", async () => {
    const session = makeDemoSession();

    expect(await runAll(session, ["cat team-docs/handbook/releases.md"])).toMatchObject({
      output: "# Releases\n\nTag from main, write the changelog, then announce in #releases.\n",
    });
    expect(await runAll(session, ["cat team-docs"])).toMatchObject({
      output: "cat: ~/team-docs: Is a directory\n",
    });
    expect(await runAll(session, ["cat"])).toMatchObject({ exitCode: 1 });
  });

  it("pulls the waiting upstream change once, and only inside a source with one", async () => {
    const session = makeDemoSession();

    expect(await runAll(session, ["git pull"])).toMatchObject({ exitCode: 1 });
    expect(await runAll(session, ["cd ~/skills/review", "git status"])).toMatchObject({
      output: "git: only git pull is available in this demo\n",
    });
    expect((await runAll(session, ["git pull"])).output).toContain(" ship/SKILL.md | 6 ++++++");
    expect(await runAll(session, ["git pull"])).toMatchObject({
      output: "Already up to date.\n",
    });
    expect(session.machine().volume.exists("/home/you/skills/ship/SKILL.md")).toBe(true);
  });

  it("passes a failing Tack invocation's exit code through", async () => {
    const result = await runAll(makeDemoSession(), ["tack pick exclude commit"]);

    expect(result).toMatchObject({ exitCode: 2 });
    expect(result.output).toContain("Choose exactly one namespace with --project or --user.");
  });

  it("stops a chain at the first failure and keeps the earlier output", async () => {
    const session = makeDemoSession();

    expect(await runAll(session, ["pwd && cd missing && pwd"])).toMatchObject({
      output: "/home/you\ncd: ~/missing: No such file or directory\n",
      exitCode: 1,
    });
    expect(await runAll(session, ["", "unknown"])).toMatchObject({
      output: "unknown: command not found; type help\n",
      exitCode: 127,
    });
  });

  it("clears, lists its commands and resets to the starting machine", async () => {
    const session = makeDemoSession();
    await runAll(session, ["tack state init", "cd code"]);

    expect(await runAll(session, ["pwd && clear"])).toMatchObject({ output: "", clear: true });
    expect((await runAll(session, ["help"])).output).toContain("git pull");
    expect(await runAll(session, ["reset"])).toMatchObject({ clear: true, exitCode: 0 });
    expect(session.prompt()).toBe("~");
    expect(session.machine().volume.exists("/home/you/.tack")).toBe(false);
  });
});

describe("tab completion", () => {
  /** What Tab turns `line` into, and the choices it lists when it cannot pick one. */
  const tab = async (line: string, setup: ReadonlyArray<string> = []) => {
    const session = makeDemoSession();
    await runAll(session, setup);
    const completion = await session.complete(line);
    return {
      line: completion.line,
      head: completion.head,
      options: completion.options.map((option) => option.value),
    };
  };

  it.each([
    ["ta", "tack "],
    ["tack sy", "tack sync "],
    ["tack sync --pro", "tack sync --project "],
    ["tack state init && tack ad", "tack state init && tack adapter "],
    ["cd ~/co", "cd ~/code/"],
    ["cat ~/team-docs/handbook/r", "cat ~/team-docs/handbook/releases.md "],
  ])("completes %j to %j", async (line, completed) => {
    expect(await tab(line)).toMatchObject({ line: completed, options: [] });
  });

  it("extends to the common prefix and lists the choices when several fit", async () => {
    expect(await tab("cd ~/code/")).toEqual({
      line: "cd ~/code/ap",
      head: "cd ",
      options: ["~/code/api/", "~/code/app/"],
    });
    expect(await tab("tack state init && tack s")).toEqual({
      line: "tack state init && tack s",
      head: "tack state init && tack ",
      options: ["script", "source", "sync", "status", "state"],
    });
  });

  it("offers the shell's commands for the first word", async () => {
    expect((await tab("")).options).toEqual([
      "tack",
      "cd",
      "ls",
      "tree",
      "cat",
      "git",
      "pwd",
      "clear",
      "reset",
      "help",
    ]);
  });

  it("reads Tack's state for the values it offers", async () => {
    const registered = ["tack state init", "cd ~/code/app && tack project add app"];

    expect(await tab("tack sync --project a", registered)).toMatchObject({
      line: "tack sync --project app ",
      options: [],
    });
  });

  it("leaves a line it cannot complete as it is", async () => {
    expect(await tab("echo hel")).toMatchObject({ line: "echo hel", options: [] });
    expect(await tab("cd ~/nowhere/x")).toMatchObject({ line: "cd ~/nowhere/x", options: [] });
  });
});
