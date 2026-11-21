/**
 * The features page copy: one setup followed from first setup to day two. Each step says what the
 * visitor runs and what Tack does in return. Text in `backticks` shows as inline code.
 *
 * Every command is a real Tack command (`content.test.ts` checks each one against the CLI's own
 * help), and every `output` is an excerpt of what the checkout's CLI printed for that command in an
 * isolated home with all five agents present; `…` marks lines left out. Commands reach Cursor,
 * OpenCode and Pi only, and context reaches no agent, so no line here says otherwise.
 */

/** The page's opening. */
export const opening = {
  label: "Features",
  title: "From first setup to day two.",
  lead: "Write a skill once. Tack links it wherever your agents look, in every project.",
  intro:
    "Follow one setup through Tack, step by step: what you run, and what Tack does in return. Every command here is real, and each terminal shows what the CLI printed, trimmed where it repeats.",
} as const;

/** The two parts of the walkthrough, in order. */
export const days = [
  {
    id: "day-one",
    title: "Day one",
    text: "Set up the machine and link your skills into every agent.",
  },
  {
    id: "day-two",
    title: "Day two",
    text: "Keep up with the team, run scripts, pin a setup, and check on it.",
  },
] as const;

/** A step's terminal: the folder it runs in, the command and what it printed. */
type Output = { readonly cwd: string; readonly command: string; readonly text: string };

/** One step of the walkthrough. */
export type Step = {
  readonly id: string;
  readonly day: (typeof days)[number]["id"];
  readonly title: string;
  readonly summary: string;
  /** The command lines the visitor runs, in order. */
  readonly run: ReadonlyArray<string>;
  /** A second way to take the step, in one line. */
  readonly or?: string;
  /** An excerpt of what the step's main command printed. */
  readonly output?: Output;
  /** A source file the visitor writes for the step, in place of output. */
  readonly code?: { readonly file: string; readonly text: string };
  /** What Tack does in return, one fact per line. */
  readonly tack: ReadonlyArray<string>;
};

export const steps: ReadonlyArray<Step> = [
  {
    id: "set-up",
    day: "day-one",
    title: "Set up the machine.",
    summary: "One command, no flags. Tack finds the agents you already use and teaches them Tack.",
    run: ["tack init"],
    or: "Or ask your agent to run `tack guide onboarding` and follow it with you, one preview at a time.",
    output: {
      cwd: "~",
      command: "tack init",
      text: `tack init · user · ✓ success

Created ~/.tack. Enabled claude, codex, cursor, opencode, pi. Linked 25 skills
at user scope.

  found  claude ~/.claude, codex ~/.codex, cursor ~/.cursor, opencode
         ~/.config/opencode, pi ~/.pi

claude → user · 5 to link
  applied  create  .claude/skills/use-tack              skill use-tack
  …`,
    },
    tack: [
      "Creates its state in `~/.tack`.",
      "Enables each agent whose home folder it finds: Claude Code, Codex, Cursor, OpenCode and Pi.",
      "Links its five built-in skills into every agent, `use-tack` among them, so your agent can run Tack for you.",
      "Lists the skills you made by hand and leaves them where they are. Safe to run again, and the one step after an upgrade.",
    ],
  },
  {
    id: "add-a-source",
    day: "day-one",
    title: "Add a source.",
    summary:
      "A source is a folder you own or share. One `tack.yaml` declares its skills, commands, context, docs and scripts.",
    run: ["tack source add ~/skills --skills .", "tack source add ~/skills --skills . --apply"],
    output: {
      cwd: "~",
      command: "tack source add ~/skills --skills .",
      text: `tack source add · ✓ success

Would create ~/skills/tack.yaml and register source skills.
No files or state changed.

  version: 1
  kind: skills

skills collection · 2 skills
  commit, review`,
    },
    tack: [
      "Previews the `tack.yaml` it would write and what each entry finds. `--apply` writes it.",
      "Registers a folder that already has a `tack.yaml`, such as a team repository you cloned, at once.",
      "Reads nothing by convention: only what `tack.yaml` declares reaches the catalog.",
      "Never moves or copies your files.",
    ],
  },
  {
    id: "register-a-project",
    day: "day-one",
    title: "Register a project.",
    summary: "A project is a Git repository. Tack keeps every worktree of it in step.",
    run: ["tack project add app"],
    output: {
      cwd: "~/code/app",
      command: "tack project add app",
      text: `tack project add · app · ✓ success

Registered project app.

  anchor  ~/code/app/.git
  roots   ~/code/app`,
    },
    tack: [
      "Records the repository and every worktree it has.",
      "Writes no link yet.",
      "Lists files in the agents' folders that it did not make, and leaves them alone.",
    ],
  },
  {
    id: "pick",
    day: "day-one",
    title: "Pick what each project gets.",
    summary:
      "In a project, every skill is on unless its author made it opt-in. Choose per project, or for yourself everywhere.",
    run: ["tack pick exclude commit --project app", "tack pick include review --user"],
    or: "Or browse the catalog and stage picks in your terminal with `tack explore`.",
    output: {
      cwd: "~/code/app",
      command: "tack pick exclude commit --project app",
      text: `tack pick exclude · project app · ✓ success

Set skill commit to exclude for project app.

Next
  tack sync --project app`,
    },
    tack: [
      "Saves the choice at once. Nothing is linked until you sync.",
      "Brings along the skills a skill declares it needs.",
      "Links a skill you pick for yourself once, in your own agent folders, not again in each project.",
      "Keeps its own built-in skills locked in.",
    ],
  },
  {
    id: "sync",
    day: "day-one",
    title: "Sync into your agents.",
    summary: "Preview every link, then apply. Each agent gets a link to your folder, never a copy.",
    run: ["tack sync --project app", "tack sync --project app --apply"],
    output: {
      cwd: "~/code/app",
      command: "tack sync --project app",
      text: `tack sync · project app · ✓ success

Nothing was written. 13 changes planned.

claude → app · 2 to link
  create  .claude/skills/        directory
  create  .claude/skills/commit  skill commit
  create  .claude/skills/review  skill review
…
pi → app · 3 to link
  create  .pi/prompts/         directory
  create  .pi/skills/          directory
  create  .pi/prompts/ship.md  command ship
  create  .pi/skills/commit    skill commit
  create  .pi/skills/review    skill review

Commands reach cursor, opencode, pi only: Tack does not link commands for
claude, codex.`,
    },
    tack: [
      "Links each skill into Claude Code, Codex, Cursor, OpenCode and Pi, in every worktree of the project.",
      "Links commands into Cursor, OpenCode and Pi. Claude Code and Codex get skills only.",
      "Records every link it makes, removes only those, and never overwrites a file it did not create.",
      "An edit to a skill needs no sync: the links point at your folder.",
    ],
  },
  {
    id: "docs",
    day: "day-one",
    title: "Attach your docs.",
    summary:
      "Give a project its handbook. Agents read it as files and search it; you read it in a local reader.",
    run: [
      "tack docs attach handbook --project app",
      "tack sync --project app --apply",
      "tack docs search ownership --project app",
      "tack docs serve --project app",
    ],
    output: {
      cwd: "~/code/app",
      command: "tack docs search ownership --project app",
      text: `tack docs search · app · ✓ success

  Query     ownership
  Project   app · ~/code/app
  Results   1 hit, within the limit of 10
  Coverage  complete

Hits
  1. Ownership
     ownership.md · handbook
     ~/team/handbook/ownership.md:5`,
    },
    tack: [
      "Mounts the docs under `.tack/docs` in every worktree, as a link to the source.",
      "Searches them from the terminal, each hit with its file and line.",
      "Serves a local reader that reloads when you save, with figures, search, and copy that keeps file and line numbers.",
      "Tells an agent where to write new docs with `tack docs target`.",
    ],
  },
  {
    id: "team",
    day: "day-two",
    title: "Keep up with your team.",
    summary:
      "Keep the team's skills and docs in one Git repository. Each teammate clones it once and links it into the agent they use.",
    run: ["git pull", "tack sync --all", "tack project refresh --project app"],
    output: {
      cwd: "~/code/app-fix",
      command: "tack project refresh --project app",
      text: `tack project refresh · project app · ✓ success

Preview only: nothing was written. 1 root change, 1 docs link to create, 1 docs
link unchanged.

Project app 1 root change
  + add  ~/code/app-fix`,
    },
    tack: [
      "Edits to a skill arrive with the pull: the links already point at it.",
      "A new skill waits in the next sync preview before it is linked.",
      "Previews a new worktree with `project refresh`; `--apply` adds it and mounts its docs, and the next sync links its skills.",
      "Prints a Tack section for your `AGENTS.md` (`tack guide agent-instructions`), so an agent in a fresh clone links the skills before it starts.",
    ],
  },
  {
    id: "scripts",
    day: "day-two",
    title: "Run scripts by name.",
    summary:
      "Declare a TypeScript script in a source and run it in any registered project, with only the secrets it asks for.",
    run: [
      "tack script show report",
      "tack script run report --project app -- --limit 5",
      "tack script history",
    ],
    code: {
      file: "~/team/scripts/report.ts",
      text: `import { defineScript } from "@tackup/cli";

export default defineScript({
  args: { limit: { type: "number", default: 20 } },
  secrets: ["GITHUB_TOKEN"],
  run: async ({ args, exec, log }) => {
    const limit = String(args.limit);
    const { stdout } = await exec("gh", ["pr", "list", "--limit", limit]);
    log.info(stdout);
  },
});`,
    },
    tack: [
      "Runs the script in a fresh worker, in the project's root.",
      "Hands it only the secrets it declares, and redacts them from logs and results.",
      "Checks its arguments, and keeps a history of every run.",
      "Writes editor types for the script API with `tack types --apply`.",
    ],
  },
  {
    id: "profiles",
    day: "day-two",
    title: "Pin a setup with profiles.",
    summary:
      "A profile lists the exact resources a project gets. Review it like code, then apply it anywhere.",
    run: [
      "tack profile save ~/agent-setup reviewer --project app",
      "tack profile export agent-setup:reviewer reviewer.tar.gz --apply",
      "tack profile apply-bundle reviewer.tar.gz --project app --target-root ~/app --apply",
    ],
    tack: [
      "Saves what a project uses today as a profile file in your source.",
      "Gives a project exactly the profile's list; ordinary picks cannot change it.",
      "Packs the profile's files into one `.tar.gz` bundle with checksums.",
      "Sets up a fresh machine, container or CI runner from the bundle, without the original sources and without fetching anything.",
    ],
  },
  {
    id: "check",
    day: "day-two",
    title: "Check on it, or take it all back.",
    summary: "Every view ends with the next command to run. And Tack can undo everything it made.",
    run: [
      "tack status --project app",
      "tack doctor",
      "tack adapter disable cursor",
      "tack state reset --apply",
    ],
    output: {
      cwd: "~",
      command: "tack doctor",
      text: `No problems found.

Checked
  ✓ adapters
    Enabled: claude, codex, cursor, opencode, pi.
  ✓ sources
    2 registered sources, all healthy.
  …
  ✓ links
    41 managed destinations, all matching.
  ✓ docs
    1 project with attached docs, all mounted and loading.`,
    },
    tack: [
      "`status` reports every link of a project; `doctor` checks the whole machine, and each problem names the command that fixes it.",
      "Turning an agent off previews, then removes only that agent's links.",
      "`state reset --apply` removes every link Tack made, then its state. Your files stay.",
      "`--json` gives scripts a stable contract for `status`, `sync`, `doctor` and `upgrade`.",
    ],
  },
];

/** The rest of Tack, one line and one command each. */
export const also = {
  heading: "Also in Tack",
  items: [
    {
      title: "Skills from GitHub.",
      text: "Copies a skill into a source you own and records where it came from. The one command that reaches the network.",
      proof: "tack import add github:anthropics/skills --skill pdf --into my-skills",
    },
    {
      title: "Checks for what you write.",
      text: "Validates sources, profiles, bundles and docs figures without state, network or running your code, with a file and line for each finding.",
      proof: "tack check ~/skills",
    },
    {
      title: "Another agent, one command.",
      text: "Turn an agent on; the next sync links every skill you use into it.",
      proof: "tack adapter enable opencode",
    },
    {
      title: "Guides for your agent.",
      text: "Prints the onboarding, `AGENTS.md` and day-two guides of the Tack you run, for an agent to follow.",
      proof: "tack guide onboarding",
    },
    {
      title: "Upgrades you run.",
      text: "Tack never upgrades itself: it names the command that does, without the network.",
      proof: "tack upgrade",
    },
    {
      title: "Icons for docs.",
      text: "Finds the icon names a document may draw, so an agent picks one instead of guessing.",
      proof: "tack docs icons database",
    },
  ],
} as const;

/** What Tack leaves to you today, so the page claims nothing more. */
export const limits = {
  heading: "What Tack leaves to you",
  items: [
    "Context is catalogued, but no agent receives it yet.",
    "Commands reach Cursor, OpenCode and Pi. Claude Code and Codex get skills only.",
    "Tack does not run `git pull` for you, or edit your `.gitignore`.",
    "No server, no account, no telemetry. Only `tack import add` reaches the network.",
    "Tack is under active development and is not yet published to npm.",
  ],
} as const;

/** The closing call to action. */
export const closing = {
  heading: "See it run, then make it yours.",
  text: "The landing page runs the same walkthrough on a machine that lives in the page.",
  demo: "Watch the demo",
  start: "Get started",
} as const;
