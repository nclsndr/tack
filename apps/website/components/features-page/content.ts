/**
 * Features page copy: every Tack feature, in six parts a visitor cares about. Each part has a
 * claim, the situation it serves, plain lines, one command as its proof, a small figure, and its
 * features: the first three in view, the rest behind "More". Text in `backticks` shows as inline
 * code. Every `command` and `proof` is a real command path whose flags exist (`content.test.ts`
 * runs each one's help). Commands reach Cline, Cursor, OpenCode and Pi only, and context reaches no agent,
 * so no line here says otherwise.
 */

/** One feature: a title, a plain line and, when one shows it, a command. */
export type Detail = {
  readonly title: string;
  readonly text: string;
  readonly command?: string;
};

/** A part of the page: one thing a visitor cares about, and every feature that serves it. */
export type Lens = {
  readonly id: string;
  readonly name: string;
  /** The situation the part serves, for the index. */
  readonly when: string;
  readonly claim: string;
  readonly lines: ReadonlyArray<string>;
  readonly proof: string;
  /** The features; the first `keyDetails` show at once. */
  readonly details: ReadonlyArray<Detail>;
};

/** How many features of a part show at once; the rest wait behind "More". */
export const keyDetails = 3;

/** The page's head. */
export const intro = {
  label: "Features",
  heading: "Everything Tack does, in six parts.",
  problem:
    "Every coding agent looks for your setup in its own folder, in every project and every worktree. You fix one copy and the others drift.",
  tagline: "Write a skill once. Tack links it wherever your agents look, in every project.",
  facts: ["Local CLI", "No account, no telemetry", "Open source, MIT", "Not on npm yet"],
  limitsLink: "What Tack does not do ↓",
  indexLabel: "Jump to",
} as const;

/**
 * How to install Tack today. It is not published to npm yet, so a visitor installs a checkout of
 * the repository, as the contributing guide describes.
 */
export const install = {
  id: "install",
  heading: "Install Tack from a checkout.",
  text: "Tack is not on npm yet. Clone the repository and install it as your global `tack`; it needs Bun and npm. Then `tack init` sets up your machine.",
  commands: ["git clone https://github.com/nclsndr/tack.git", "cd tack", "bun run install:local"],
  guide: "Install guide",
  guideHref: "https://github.com/nclsndr/tack/blob/main/CONTRIBUTING.md#run-your-changes",
  docs: "Read the docs",
} as const;

/** One source with one of each kind, as the README's example shows it. */
export const sourceFigure = {
  root: "~/agent-setup",
  entries: [
    { path: "tack.yaml", kind: "declares" },
    { path: "skills/review/SKILL.md", kind: "skill" },
    { path: "commands/ship.md", kind: "command" },
    { path: "context/conventions.md", kind: "context · no agent yet" },
    { path: "docs/handbook/", kind: "docs" },
    { path: "scripts/report.ts", kind: "script" },
  ],
} as const;

/**
 * One skill folder and the links one sync makes from it in a project, and its commands, by the
 * project folders of the CLI's adapters (`apps/cli/src/domain/agents/agent-adapter.ts`).
 */
export const agentsFigure = {
  source: "~/agent-setup/skills/review",
  links: [
    { path: ".claude/skills/review", agent: "Claude Code" },
    { path: ".cline/skills/review", agent: "Cline" },
    { path: ".agents/skills/review", agent: "Codex" },
    { path: ".github/skills/review", agent: "Copilot CLI" },
    { path: ".cursor/skills/review", agent: "Cursor" },
    { path: ".gemini/skills/review", agent: "Gemini CLI" },
    { path: ".opencode/skills/review", agent: "OpenCode" },
    { path: ".pi/skills/review", agent: "Pi" },
  ],
  commandsLabel: "and the command ship.md, for the agents that take commands",
  commands: [
    { path: ".clinerules/workflows/ship.md", agent: "Cline" },
    { path: ".cursor/commands/ship.md", agent: "Cursor" },
    { path: ".opencode/commands/ship.md", agent: "OpenCode" },
    { path: ".pi/prompts/ship.md", agent: "Pi" },
  ],
} as const;

/** One project, its worktrees, and the same link in each. */
export const projectFigure = {
  project: "project app · picks review",
  link: ".claude/skills/review",
  worktrees: [
    { root: "~/code/app", note: "main worktree" },
    { root: "~/code/app-hotfix", note: "worktree" },
    { root: "~/code/app-spike", note: "worktree" },
  ],
} as const;

/** A script, as the built-in scripts reference writes one, shortened to fit a phone. */
export const scriptFigure = {
  file: "~/agent-setup/scripts/report.ts",
  code: [
    "// Tack provides this import at run time.",
    'import { defineScript } from "@tackup/cli";',
    "",
    "export default defineScript({",
    '  args: { repo: { type: "string" } },',
    '  secrets: ["GITHUB_TOKEN"],',
    "  run: async ({ args, secrets, exec }) => {",
    "    // …",
    "  },",
    "});",
  ],
} as const;

/** A profile's way from a reviewed file to a machine that never saw the source. */
export const profileFigure = {
  steps: [
    { what: "~/agent-setup/profiles/reviewer.yaml", how: "reviewed like any change" },
    { what: "reviewer.tar.gz", how: "one file, with checksums", command: "tack profile export" },
    {
      what: "~/ci/app on a CI runner",
      how: "no source, no fetch",
      command: "tack profile apply-bundle",
    },
  ],
} as const;

/**
 * A real sync preview, from the CLI in a throwaway home where Claude Code and Codex were found:
 * one source with the skill `review`, and the project `app`.
 */
export const previewFigure = {
  command: "tack sync --project app",
  output: `tack sync · project app · ✓ success

Nothing was written. 2 changes planned.

claude → app · 1 to link
  create  .claude/skills/        directory
  create  .claude/skills/review  skill review

codex → app · 1 to link
  create  .agents/skills/        directory
  create  .agents/skills/review  skill review

Preview only: nothing was written. There are no docs links to reconcile.

Next
  tack sync --project app --apply`,
  caption: "A real preview, on a machine with Claude Code and Codex.",
} as const;

/** The docs part's figure: the reader, as the landing page shows it. */
export const docsFigure = {
  alt: "Screenshot: the Tack docs reader showing an architecture walkthrough, with its document index, metadata and a figure.",
} as const;

/** The parts, in the order the page shows them. */
export const lenses = [
  {
    id: "sources",
    name: "Sources",
    when: "You keep skills, docs and scripts in folders, alone or as a team.",
    claim: "Write it once, in a folder you own.",
    lines: [
      "Skills, commands, context, docs and scripts live in a source: a folder with a `tack.yaml`, under your own version control. Tack reads it where it is and moves nothing.",
      "Keep the source in a Git repository and your team shares it. Each teammate clones it and adds it; edits arrive with their own `git pull`.",
    ],
    proof: "tack source add ~/agent-setup",
    details: [
      {
        title: "One command sets up the machine.",
        text: "`tack init` creates Tack's state, enables the agents it finds in your home and links the built-in skills. It is safe to repeat.",
        command: "tack init",
      },
      {
        title: "No tack.yaml yet? Tack drafts it.",
        text: "Name the folders that hold each kind. Tack previews the `tack.yaml` it would write; `--apply` writes it and registers the source.",
        command: "tack source add ~/agent-setup --skills skills",
      },
      {
        title: "Skills from GitHub, copied into your source.",
        text: "Tack copies the skills you choose into a source you own and records where they came from. The next sync links them into your projects; at user level a skill is opt-in by default, so it reaches you there only once you pick it.",
        command: "tack import add github:org/repo --skill pdf --into agent-setup",
      },
      {
        title: "Skills that need other skills.",
        text: "A skill can declare the skills and commands it depends on, in its own source or in a source its source depends on. Selecting it brings them along.",
      },
      {
        title: "Context is catalogued, not delivered.",
        text: "Rules and notes in a source show in `tack catalog` and can be picked, but no agent receives context yet.",
      },
      {
        title: "Checked before anyone uses it.",
        text: "`tack check` reads sources, profiles, bundles and docs without state, network or running your code, and reports each problem by file and line.",
        command: "tack check ~/agent-setup",
      },
      {
        title: "Move the folder, keep the setup.",
        text: "`tack source relocate` points a registered source at its new folder. It keeps its registration, so every pick stays, and the next sync points the links at the new folder.",
      },
    ],
  },
  {
    id: "agents",
    name: "Agents",
    when: "You use more than one coding agent, or want to try the next one.",
    claim: "One skill, in every agent's folder.",
    lines: [
      "Claude Code, Cline, Codex, GitHub Copilot CLI, Cursor, Gemini CLI, OpenCode and Pi each look for skills in their own folder. Tack links one skill folder into each of them.",
      "Edit the skill once and every agent sees the change, because each one reads the same folder.",
    ],
    proof: "tack sync --project app",
    details: [
      {
        title: "Add an agent at any time.",
        text: "Enable it, and the next sync links every skill you already use into its folder.",
        command: "tack adapter enable opencode pi",
      },
      {
        title: "Commands where agents read them.",
        text: "Cline, Cursor, OpenCode and Pi also get your commands, as the same Markdown file; Cline calls them workflows and Pi prompt templates. Claude Code, Codex, Copilot CLI and Gemini CLI get skills only.",
      },
      {
        title: "Your agent can run Tack.",
        text: "After `tack init`, every enabled agent has Tack's built-in skills, `use-tack` among them, and `tack guide onboarding` prints setup steps for an agent to follow.",
        command: "tack guide onboarding",
      },
      {
        title: "Turn an agent off cleanly.",
        text: "Disabling an agent previews removing its links. Tack removes only the links it made.",
        command: "tack adapter disable cursor",
      },
      {
        title: "Finds the agents you have.",
        text: "`tack init` enables each agent whose folder exists in your home: `~/.claude`, `~/.cline` or `~/Documents/Cline`, `~/.codex` or `~/.agents`, `~/.copilot`, `~/.cursor`, `~/.gemini`, `~/.config/opencode`, `~/.pi`.",
      },
      {
        title: "Agents without an adapter.",
        text: "Zed, Goose and Amp read `.agents/skills`, so the Codex adapter reaches them too.",
      },
      {
        title: "For you, or for one project.",
        text: "Pick a skill for yourself with `--user` and every project sees it, or pick it for one project's own agent folders; the next sync links it.",
        command: "tack pick include review --user",
      },
    ],
  },
  {
    id: "projects",
    name: "Projects",
    when: "Each repository needs its own skills, in every worktree.",
    claim: "Each project picks its own. Every worktree follows.",
    lines: [
      "Register a Git repository once and Tack finds its worktrees. Include or exclude skills for that project, and every worktree gets the same links.",
      "`tack sync --all` previews the changes for every project and for you before it writes.",
    ],
    proof: "tack pick include review --project app",
    details: [
      {
        title: "A project is a Git repository.",
        text: "Registering records the repository and every worktree it has, so `--project app` works from any directory.",
        command: "tack project add app",
      },
      {
        title: "New worktree, same setup.",
        text: "After you add a worktree, refresh the project and the next sync links it like the others.",
        command: "tack project refresh --project app --apply",
      },
      {
        title: "Browse and pick in the terminal.",
        text: "`tack explore` lists every resource with its state in the project. Stage picks and docs, review the sync, then apply.",
        command: "tack explore --project app",
      },
      {
        title: "Skills that choose their projects.",
        text: "A skill can be on by default or opt-in, and can limit its default to named projects. An explicit pick always wins.",
      },
      {
        title: "Every link, accounted for.",
        text: "`tack status` shows each link's health. A file you made by hand is listed and left alone.",
        command: "tack status --project app",
      },
      {
        title: "Setup steps for the repository's AGENTS.md.",
        text: "`tack guide agent-instructions` prints a section to add to the repository's `AGENTS.md`. An agent that follows it in a fresh clone links the repository's skills before it starts.",
        command: "tack guide agent-instructions",
      },
    ],
  },
  {
    id: "docs",
    name: "Docs",
    when: "Your agents should read the same docs your team does.",
    claim: "Docs your agents can search and you can read.",
    lines: [
      "Attach a source's docs to a project, then sync: every worktree gets them under `.tack/docs`, as links to the one copy you maintain.",
      "Agents search them from the terminal. You read them in a local reader that reloads when you save.",
    ],
    proof: "tack docs attach handbook --project app",
    details: [
      {
        title: "Search with sources.",
        text: "Each hit names its file and the lines it came from, without starting a server.",
        command: 'tack docs search "release process" --project app',
      },
      {
        title: "A local reader.",
        text: "One view of every attached source, with search, metadata filters and an Open in editor menu for Zed, Cursor and VSCode.",
        command: "tack docs serve --project app",
      },
      {
        title: "Where to write new docs.",
        text: "`tack docs target` gives an agent the verified folder to write new documents into.",
        command: "tack docs target --project app",
      },
      {
        title: "Copy that cites its source.",
        text: "Copy a passage as rendered text with its source lines, as raw Markdown, or as references only, ready to hand to an agent.",
      },
      {
        title: "Figures that stay true.",
        text: "Docs can draw architecture maps, systems, schemas, file trees, walkthroughs and charts. The built-in `write-reader-figures` skill teaches agents to write them.",
      },
      {
        title: "Checked like code.",
        text: "`tack check` reads a document's figures and components without a browser and reports each issue by line.",
        command: "tack check docs/architecture.mdx",
      },
    ],
  },
  {
    id: "scripts",
    name: "Scripts",
    when: "Your agents should run your tools without seeing every secret.",
    claim: "Scripts, run by name, with only the secrets they declare.",
    lines: [
      "Declare a TypeScript script in your source. Run it by name in any registered project.",
      "Each run gets a fresh worker and only the secrets the script declares, and leaves a history.",
    ],
    proof: "tack script run report --project app",
    details: [
      {
        title: "See before you run.",
        text: "`tack script show` prints a script's arguments and secrets. It loads the script but never runs it.",
        command: "tack script show report",
      },
      {
        title: "Secrets stay redacted.",
        text: "Secret values come from `TACK_<NAME>` in Tack's `.env` or your environment. Logs and results show `<redacted>`.",
      },
      {
        title: "Every run, on record.",
        text: "History keeps each run's input, logs and outcome until you clear it.",
        command: "tack script history",
      },
      {
        title: "Arguments, checked.",
        text: "Pass arguments after `--`, or as JSON. Every problem is reported at once, before the script runs.",
        command: "tack script run report --project app -- --repo org/app",
      },
      {
        title: "Typed in your editor.",
        text: "`tack types` writes the script API's types into the source, from the Tack you run.",
        command: "tack types ~/agent-setup --apply",
      },
      {
        title: "A run that stops on time.",
        text: "`--timeout` interrupts a run and waits for its cleanup.",
        command: "tack script run report --project app --timeout 30000",
      },
    ],
  },
  {
    id: "profiles",
    name: "Profiles",
    when: "A CI runner or a remote agent needs exactly the set you reviewed.",
    claim: "The exact same set, for a teammate, a CI runner or a remote agent.",
    lines: [
      "A profile is a file in your source that lists the exact resources a project gets. You review it like any other change.",
      "Each teammate or runner applies it themselves: `tack profile apply` previews the fixed set at one explicit target, then `--apply` writes it. A bundle carries it to a machine without the source.",
    ],
    proof: "tack profile export agent-setup:reviewer reviewer.tar.gz",
    details: [
      {
        title: "Save what you use now.",
        text: "`tack profile save` copies the set you use now, defaults and picks, into a profile file, after a preview.",
        command: "tack profile save ~/agent-setup reviewer --project app",
      },
      {
        title: "A fixed set.",
        text: "`tack profile apply` previews the profile's exact list at one explicit target: every root of a project with `--target-root`, or a home with `--target-home`. `--apply` writes it, and ordinary picks cannot change it.",
        command: "tack profile apply agent-setup:reviewer --project ci --target-root ~/ci/app",
      },
      {
        title: "Set up a fresh machine.",
        text: "On a CI runner or in a container, `apply-bundle` links the same set without the original source and without fetching anything.",
        command: "tack profile apply-bundle reviewer.tar.gz --project ci --target-root ~/ci/app",
      },
      {
        title: "One file to carry.",
        text: "`tack profile export` previews, then packs the profile's files into one `.tar.gz` with checksums. No code, hook or installer runs.",
      },
      {
        title: "Look inside a bundle.",
        text: "Read a bundle's inventory before you apply it; `tack check` validates it.",
        command: "tack profile inspect-bundle reviewer.tar.gz",
      },
      {
        title: "Visible everywhere.",
        text: "`tack status` and `tack doctor` show the profile a project runs, with its links.",
      },
    ],
  },
] as const satisfies ReadonlyArray<Lens>;

/** A part's id, which is also its anchor on the page. */
export type LensId = (typeof lenses)[number]["id"];

/** The rules that hold under every part, and what Tack does not do. */
export const groundRules = {
  label: "Under everything",
  heading: "No link changes until you say so.",
  rules: [
    {
      title: "Preview first.",
      text: "Commands that change links, or write into your source, print their plan first; `--apply`, or your yes in `tack explore`, writes it. Picks, registrations and settings save at once and link nothing. Only `tack init` links at once, to set Tack up.",
      command: "tack sync --all",
    },
    {
      title: "Each problem names its fix.",
      text: "`tack doctor` checks the whole machine; every problem it finds ends with the command that fixes it.",
      command: "tack doctor",
    },
    {
      title: "Leave without a trace.",
      text: "`tack state reset --apply` removes every link Tack made and its state. Your files stay.",
      command: "tack state reset",
    },
    {
      title: "Links, never copies.",
      text: "Tack records every link it makes and removes only those. Files it did not make stay where they are.",
    },
    {
      title: "Local and quiet.",
      text: "Tack calls no model and has no telemetry. Tack itself reaches the network only for `tack import add`, to fetch from GitHub.",
    },
    {
      title: "Built for agents too.",
      text: "Views end with the next command to run, and `--json` gives programs a stable contract for status, sync, doctor and upgrade.",
    },
  ],
  limitsHeading: "What Tack does not do",
  limits: [
    {
      title: "Deliver context.",
      text: "Tack catalogues context; no agent receives it yet.",
    },
    {
      title: "Pull for you.",
      text: "Teammates run `git pull`; Tack links what is on disk.",
    },
    {
      title: "Convert skills.",
      text: "Every agent gets a link to the same `SKILL.md` folder.",
    },
    {
      title: "Host anything.",
      text: "No hosted service and no account: the docs reader runs on your machine.",
    },
  ],
} as const satisfies {
  readonly label: string;
  readonly heading: string;
  readonly rules: ReadonlyArray<Detail>;
  readonly limitsHeading: string;
  readonly limits: ReadonlyArray<Detail>;
};
