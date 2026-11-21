/**
 * The features page copy: one setup followed from first setup to day two. Each step says what the
 * visitor runs and what Tack does in return. Text in `backticks` shows as inline code.
 *
 * The steps chain: run in page order on a fresh machine, they give the outputs shown. Every command
 * is a real Tack command (`content.test.ts` checks each one against the CLI's own help), and every
 * `output` is an excerpt of what the checkout's CLI printed for it in that run, in an isolated home
 * with all five agents present; a `…` line marks lines left out. The machine holds `~/skills`, a
 * folder of two skills, and `~/team`, a clone of the team's Git repository whose `tack.yaml`
 * declares its skills, a command, the handbook, a script and a profile. Commands reach Cursor,
 * OpenCode and Pi only, and context reaches no agent, so no line here says otherwise.
 */

/** The page's opening. */
export const opening = {
  label: "Features",
  title: "From first setup to day two.",
  lead: "Write a skill once. Tack links it wherever your agents look, in every project.",
  intro:
    "Follow one setup through Tack, step by step: what you run, and what Tack does in return. Every command here is real, and each terminal shows what the CLI printed; a `…` line marks what is left out.",
  /** Where to get Tack while it is not on npm. */
  install: {
    text: "Tack is not published to npm yet. To try it today, install it from a checkout of",
    link: "its repository",
    href: "https://github.com/nclsndr/tack/blob/main/CONTRIBUTING.md#run-your-changes",
  },
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
type Output = {
  readonly cwd: string;
  readonly command: string;
  readonly text: string;
  /** What the excerpt leaves out, when it leaves out more than a repeat. */
  readonly cut?: string;
};

/** One step of the walkthrough. */
export type Step = {
  readonly id: string;
  readonly day: (typeof days)[number]["id"];
  readonly title: string;
  readonly summary: string;
  /** The command lines the visitor runs, in order. */
  readonly run: ReadonlyArray<string>;
  /** Commands the step runs on another machine, after `run`, and where. */
  readonly elsewhere?: { readonly label: string; readonly run: ReadonlyArray<string> };
  /** A second way to take the step, in one line. */
  readonly or?: string;
  /** An excerpt of what one of the step's commands printed. */
  readonly output?: Output;
  /** A file of the team's source the step uses. */
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
  applied  create  .claude/skills/                      directory
…`,
    },
    tack: [
      "Creates its state in `~/.tack`.",
      "Enables each agent whose home folder it finds: Claude Code, Codex, Cursor, OpenCode and Pi.",
      "Links its five built-in skills into each of them, `use-tack` among them, so your agent can run Tack for you. Five skills, five agents: 25 links.",
      "Lists the skills you made by hand and leaves them where they are. Safe to run again, and the one step after an upgrade.",
    ],
  },
  {
    id: "add-a-source",
    day: "day-one",
    title: "Add your sources.",
    summary:
      "A source is a folder you own, or a Git repository your team shares. Its `tack.yaml` declares the skills, commands, context, docs and scripts in it.",
    run: [
      "tack source add ~/skills --skills .",
      "tack source add ~/skills --skills . --apply",
      "tack source add ~/team",
    ],
    output: {
      cwd: "~",
      command: "tack source add ~/skills --skills .",
      text: `tack source add · ✓ success

Would create ~/skills/tack.yaml and register source skills.
No files or state changed.

  version: 1
  kind: skills

skills collection · 2 skills
  commit, review

Next
  tack source add \\
    ~/skills \\
    --skills . --apply`,
    },
    tack: [
      "`--skills .` says the folder itself holds skills. Tack previews the `tack.yaml` it would write and what it finds; `--apply` writes it.",
      "Registers the team's clone at once: it already has a `tack.yaml`. Two skills, one command, one script and the handbook.",
      "Reads nothing by convention: only what `tack.yaml` declares reaches the catalog.",
      "Never moves or copies your files.",
    ],
  },
  {
    id: "register-a-project",
    day: "day-one",
    title: "Register a project.",
    summary:
      "A project is a Git repository. Run this inside it; Tack keeps every worktree of it in step.",
    run: ["tack project add app"],
    output: {
      cwd: "~/code/app",
      command: "tack project add app",
      text: `tack project add · app · ✓ success

Registered project app.

  anchor  ~/code/app/.git
  roots   ~/code/app

Next
  tack catalog
  tack sync --project app`,
    },
    tack: [
      "Records the repository and every worktree it has.",
      "Writes no link yet.",
      "Lists files in the agents' folders that it did not make, and leaves them alone.",
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

Nothing was written. 23 changes planned.

claude → app · 4 to link
  create  .claude/skills/        directory
  create  .claude/skills/commit  skill commit
  create  .claude/skills/deploy  skill deploy
  create  .claude/skills/review  skill review
  create  .claude/skills/triage  skill triage
…
pi → app · 5 to link
  create  .pi/prompts/         directory
  create  .pi/skills/          directory
  create  .pi/prompts/ship.md  command ship
  create  .pi/skills/commit    skill commit
  create  .pi/skills/deploy    skill deploy
  create  .pi/skills/review    skill review
  create  .pi/skills/triage    skill triage

Commands reach cursor, opencode, pi only: Tack does not link commands for
claude, codex.

Preview only: nothing was written. There are no docs links to reconcile.

Next
  tack sync --project app --apply`,
      cut: "Cut to Claude Code and Pi. Codex gets the same skills; Cursor and OpenCode get them and the command.",
    },
    tack: [
      "Links every skill from both sources into Claude Code, Codex, Cursor, OpenCode and Pi, in every worktree of the project.",
      "Links commands into Cursor, OpenCode and Pi. Claude Code and Codex get skills only.",
      "Records every link it makes, removes only those, and never overwrites a file it did not create.",
      "An edit to a skill needs no sync: the links point at your folder.",
    ],
  },
  {
    id: "pick",
    day: "day-one",
    title: "Pick what each project gets.",
    summary:
      "In a project, every skill is on unless its author made it opt-in. Turn one off, and the next sync takes its links away.",
    run: [
      "tack pick exclude commit --project app",
      "tack sync --project app",
      "tack sync --project app --apply",
    ],
    or: "Or browse the catalog, stage picks and review the sync in your terminal with `tack explore`.",
    output: {
      cwd: "~/code/app",
      command: "tack sync --project app",
      text: `tack sync · project app · ✓ success

Nothing was written. 5 changes planned.

claude → app · 1 to remove
  remove  .claude/skills/commit  skill commit · deselected

codex → app · 1 to remove
  remove  .agents/skills/commit  skill commit · deselected
…
pi → app · 1 to remove
  remove  .pi/skills/commit  skill commit · deselected
…
Next
  tack sync --project app --apply`,
    },
    tack: [
      "Saves the choice at once; nothing changes on disk until you sync.",
      "Brings along the skills a skill declares it needs.",
      "`--user` turns a skill on for you in every project: one link in your own agent folders.",
      "Keeps its own built-in skills locked in.",
    ],
  },
  {
    id: "docs",
    day: "day-one",
    title: "Attach your docs.",
    summary:
      "Give a project the team's handbook. Agents read it as files and search it; you read it in a local reader.",
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
  Results   2 hits, within the limit of 10
  Coverage  complete

Hits
  1. Ownership
     ownership.md · handbook
     ~/team/handbook/ownership.md:5
       Ownership
  2. Team handbook
     index.md · handbook
     ~/team/handbook/index.md:7
       How we build, review and ship. Start with ownership.`,
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
      "A teammate adds a skill to the team repository. You pull it like any other change, and the next sync offers it.",
    run: ["git -C ~/team pull", "tack sync --all", "tack sync --all --apply"],
    output: {
      cwd: "~",
      command: "tack sync --all",
      text: `tack sync · all projects and user · ✓ success

Nothing was written. 5 changes planned.

claude → app · 1 to link
  create  .claude/skills/incident  skill incident
…
pi → app · 1 to link
  create  .pi/skills/incident  skill incident

claude → user · up to date
…`,
    },
    tack: [
      "Edits to a skill arrive with the pull: the links already point at it.",
      "A new skill waits in the sync preview before it is linked.",
      "Previews a new worktree with `tack project refresh`; `--apply` adds it and mounts its docs, and the next sync links its skills.",
      "Prints a Tack section for your `AGENTS.md` (`tack guide agent-instructions`), so an agent in a fresh clone links the skills before it starts.",
    ],
  },
  {
    id: "scripts",
    day: "day-two",
    title: "Run scripts by name.",
    summary:
      "The team's `tack.yaml` declares a TypeScript script. Run it by name, inside any registered project.",
    run: [
      "tack script show report",
      "tack script run report --quiet -- --limit 3",
      "tack script history",
    ],
    code: {
      file: "~/team/scripts/report.ts",
      text: `import { defineScript } from "@tackup/cli";

export default defineScript({
  args: { limit: { type: "number", default: 5 } },
  run: async ({ args, exec, log }) => {
    const { stdout } = await exec("git", ["log", "--oneline", "-n", String(args.limit)]);
    log.info(stdout.trim());
    return { commits: stdout.trim().split("\\n").length };
  },
});`,
    },
    output: {
      cwd: "~/code/app",
      command: "tack script run report --quiet -- --limit 3",
      text: `tack script run · ✓ success

  Run           ecb9710e-165c-4f97-9028-511e260f41c0
  Outcome       ✓ success at output stage
  Message       The script completed.
  Finalization  complete
  History       full record saved

Value
  {"commits":3}

Logs
  3 of 3 events kept, 161 B observed (script 1, shell 2)
  Not truncated; the limits are 10000 events and 10 MiB.
…`,
    },
    tack: [
      "Runs the script in a fresh worker, in the root of the project you run it from.",
      "Checks its arguments against the declaration, and keeps its logs and result in a history of every run. `--quiet` keeps them there instead of on screen.",
      "Hands a script only the secrets it declares, from `TACK_<NAME>`, and redacts them from logs and results.",
      "Writes editor types for the script API with `tack types --apply`.",
    ],
  },
  {
    id: "profiles",
    day: "day-two",
    title: "Pin a setup with profiles.",
    summary:
      "A profile is a file in the team's source that lists the exact skills a project gets. Export it once, and a CI runner with only Tack and Claude Code gets the same set.",
    run: ["tack check ~/team", "tack profile export team:on-call ~/on-call.tar.gz --apply"],
    elsewhere: {
      label: "On the CI runner",
      run: [
        "tack init",
        "tack project add app",
        "tack profile apply-bundle ~/on-call.tar.gz --project app --target-root ~/work/app --apply",
      ],
    },
    or: "Or save what a project uses today as a new profile with `tack profile save`.",
    code: {
      file: "~/team/profiles/on-call.yaml",
      text: `version: 1
name: on-call
members:
  - deploy
  - triage`,
    },
    output: {
      cwd: "CI runner · ~/work/app",
      command:
        "tack profile apply-bundle ~/on-call.tar.gz --project app --target-root ~/work/app --apply",
      text: `tack profile apply-bundle · ✓ success
…
Direct members (2)
  skill deploy
  skill triage
Required dependencies (0)

skill deploy: claude → .claude/skills/deploy
skill triage: claude → .claude/skills/triage

claude → app · 2 to link
  applied  create  .claude/skills/        directory
  applied  create  .claude/skills/deploy  skill deploy
  applied  create  .claude/skills/triage  skill triage`,
    },
    tack: [
      "Checks the profile with the rest of the source, without state or network.",
      "Packs the profile's files into one `.tar.gz` bundle with checksums.",
      "Applies the bundle on a fresh machine, container or CI runner that has Tack, without the original sources and without fetching anything.",
      "Gives the project exactly the profile's list; ordinary picks cannot change it.",
    ],
  },
  {
    id: "check",
    day: "day-two",
    title: "Check on it, or take it all back.",
    summary:
      "Sync and cleanup previews end with the command that applies them, and each problem `doctor` finds names its fix. Tack can also undo everything it made.",
    run: [
      "tack status --project app",
      "tack doctor",
      "tack adapter disable cursor",
      "tack state reset",
    ],
    output: {
      cwd: "~",
      command: "tack doctor",
      text: `tack doctor · 0.1.0+dev · 11 ok · ✓ success

No problems found.

Checked
…
  ✓ adapters
    Enabled: claude, codex, cursor, opencode, pi.
  ✓ sources
    2 registered sources, all healthy.
…
  ✓ links
    48 managed destinations, all matching.
  ✓ docs
    1 project with attached docs, all mounted and loading.`,
    },
    tack: [
      "`status` counts a project's links and flags any that need attention; `doctor` checks the whole machine.",
      "`adapter disable` previews; with `--apply` it removes only that agent's links, then turns it off.",
      "`state reset` previews; with `--apply` it removes every link Tack made, then its state. Your files stay.",
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
      text: "Previews copying a skill from a GitHub repository; `--apply` copies it into a source you own and records where it came from. The one command that reaches the network.",
      proof: "tack import add github:anthropics/skills --skill pdf --into skills",
    },
    {
      title: "Checks for what you write.",
      text: "Validates sources, profiles, bundles and docs figures without state, network or running your code, with a file and line for each finding.",
      proof: "tack check ~/skills",
    },
    {
      title: "Turn an agent back on.",
      text: "After `adapter disable`, or for an agent you install after `tack init`: the next sync links every skill you use into it.",
      proof: "tack adapter enable cursor",
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
    "No hosted service, no account, no telemetry. Only `tack import add` reaches the network.",
  ],
} as const;

/** The closing call to action. */
export const closing = {
  heading: "See it run, then make it yours.",
  text: "The landing page replays a coding agent setting Tack up, on a machine that lives in the page.",
  demo: "Watch the demo",
  start: "Get started",
} as const;
