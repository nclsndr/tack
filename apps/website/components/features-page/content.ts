/**
 * Features page copy: every Tack feature, grouped by the lens a visitor cares about. Each lens has
 * a claim, plain lines, one command as its proof, a small figure, and the details under it. Text in
 * `backticks` shows as inline code. Every `command` and `proof` that starts with `tack ` is a real
 * command path whose flags exist (`content.test.ts` runs each one's help). Commands reach Cursor,
 * OpenCode and Pi only, and context reaches no agent, so no line here says otherwise.
 */

/** One feature under a lens: a title, a plain line and, when one shows it, a command. */
export type Detail = {
  readonly title: string;
  readonly text: string;
  readonly command?: string;
};

/** A lens: one thing a visitor cares about, and every feature that serves it. */
export type Lens = {
  readonly id: string;
  readonly name: string;
  readonly claim: string;
  readonly lines: ReadonlyArray<string>;
  readonly proof: string;
  readonly details: ReadonlyArray<Detail>;
};

/** The page's head. */
export const intro = {
  label: "Features",
  heading: "Everything Tack does, one lens at a time.",
  tagline: "Write a skill once. Tack links it wherever your agents look, in every project.",
  indexLabel: "Lenses",
} as const;

/** One source with one of each kind, as the README's example shows it. */
export const sourceFigure = {
  root: "~/agent-setup",
  entries: [
    { path: "tack.yaml", kind: "declares" },
    { path: "skills/review/SKILL.md", kind: "skill" },
    { path: "commands/ship.md", kind: "command" },
    { path: "context/conventions.md", kind: "context" },
    { path: "docs/handbook/", kind: "docs" },
    { path: "scripts/report.ts", kind: "script" },
  ],
} as const;

/** One skill folder and the links one sync makes from it in a project, and a command for OpenCode. */
export const agentsFigure = {
  source: "~/agent-setup/skills/review",
  links: [
    { path: ".claude/skills/review", agent: "Claude Code" },
    { path: ".agents/skills/review", agent: "Codex" },
    { path: ".cursor/skills/review", agent: "Cursor" },
    { path: ".opencode/skills/review", agent: "OpenCode" },
    { path: ".pi/skills/review", agent: "Pi" },
    { path: ".opencode/commands/ship.md", agent: "OpenCode · command" },
  ],
} as const;

/** One project, its worktrees, and the same link in each. */
export const projectFigure = {
  project: "project app · picks review",
  worktrees: [
    { root: "~/code/app", link: ".claude/skills/review", note: "main worktree" },
    { root: "~/code/app-hotfix", link: ".claude/skills/review", note: "worktree" },
    { root: "~/code/app-spike", link: ".claude/skills/review", note: "worktree" },
  ],
} as const;

/** A script, as the built-in scripts reference writes one, shortened. */
export const scriptFigure = {
  file: "~/agent-setup/scripts/report.ts",
  code: [
    'import { defineScript } from "@tackup/cli";',
    "",
    "export default defineScript({",
    '  args: { repo: { type: "string" } },',
    '  secrets: ["GITHUB_TOKEN"],',
    "  run: async ({ args, secrets, exec, log }) => {",
    "    // …",
    "  },",
    "});",
  ],
} as const;

/** A profile's way from a reviewed file to a machine that never saw the source. */
export const profileFigure = {
  file: "~/agent-setup/profiles/reviewer.yaml",
  steps: [
    { what: "reviewer.tar.gz", how: "tack profile export", note: "one file, with checksums" },
    { what: "~/app on a CI runner", how: "tack profile apply-bundle", note: "no fetch, no source" },
  ],
} as const;

/** The docs lens's figure: the reader, as the landing page shows it. */
export const docsFigure = {
  alt: "Screenshot: the Tack docs reader showing an architecture walkthrough, with its document index, metadata and a figure.",
} as const;

/** The lenses, in the order the page shows them. */
export const lenses = [
  {
    id: "set-up-once",
    name: "Set up once",
    claim: "Write it once, in a folder you own.",
    lines: [
      "Skills, commands, context, docs and scripts live in a source: a folder with a `tack.yaml`, under your own version control. Tack reads it where it is and moves nothing.",
      "Keep the source in a Git repository and your team shares it. Each teammate clones it and adds it; edits arrive with `git pull`.",
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
        text: "Tack copies the skills you choose into a source you own and records where they came from.",
        command: "tack import add github:org/repo --skill pdf --into agent-setup",
      },
      {
        title: "Skills that need other skills.",
        text: "A skill can declare the skills and commands it depends on, in its own source or one it names. Selecting it brings them along.",
      },
      {
        title: "Checked before anyone uses it.",
        text: "`tack check` reads sources, profiles, bundles and docs without state, network or running your code, and reports each problem by file and line.",
        command: "tack check ~/agent-setup",
      },
      {
        title: "Move the folder, keep the setup.",
        text: "`tack source relocate` points a registered source at its new folder. It keeps its registration, so every pick stays.",
      },
    ],
  },
  {
    id: "every-agent",
    name: "Reach every agent",
    claim: "One skill, in every agent's folder.",
    lines: [
      "Claude Code, Codex, Cursor, OpenCode and Pi each look for skills in their own folder. Tack links one skill folder into each of them.",
      "Links, never copies: edit the skill once and every agent sees the change.",
    ],
    proof: "tack adapter enable opencode pi",
    details: [
      {
        title: "Finds the agents you have.",
        text: "`tack init` enables each agent whose folder exists in your home: `~/.claude`, `~/.codex` or `~/.agents`, `~/.cursor`, `~/.config/opencode`, `~/.pi`.",
      },
      {
        title: "For you, or for one project.",
        text: "Link a skill at user level and every project sees it, or link it into one project's own agent folders.",
        command: "tack sync --user --apply",
      },
      {
        title: "Commands where agents read them.",
        text: "Cursor, OpenCode and Pi also get your commands, as the same Markdown file; Pi calls them prompt templates. Claude Code and Codex get skills.",
      },
      {
        title: "Turn an agent off cleanly.",
        text: "Disabling an agent previews removing its links. Tack removes only the links it made.",
        command: "tack adapter disable cursor",
      },
      {
        title: "Your agent can run Tack.",
        text: "Every enabled agent gets Tack's built-in skills, `use-tack` among them, so you can ask the agent to pick, sync or check for you.",
      },
      {
        title: "A guide for agents.",
        text: "`tack guide onboarding` prints the setup steps for an agent to follow, from the Tack that runs it.",
        command: "tack guide onboarding",
      },
    ],
  },
  {
    id: "per-project",
    name: "Per project",
    claim: "Each project picks its own. Every worktree follows.",
    lines: [
      "Register a Git repository once and Tack finds its worktrees. Include or exclude skills for that project; every worktree gets the same links.",
      "One sync previews the changes for every project and for you, before it writes.",
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
        title: "New clones set themselves up.",
        text: "`tack guide agent-instructions` prints a section for the repository's `AGENTS.md`, so an agent in a fresh clone links the repository's skills before it starts.",
        command: "tack guide agent-instructions",
      },
    ],
  },
  {
    id: "docs",
    name: "Docs",
    claim: "Docs your agents can search and you can read.",
    lines: [
      "Attach a source's docs to a project. Every worktree gets them under `.tack/docs`, as links to the one copy you maintain.",
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
        title: "Copy that cites its source.",
        text: "Copy a passage as rendered text with its source lines, as raw Markdown, or as references only, ready to hand to an agent.",
      },
      {
        title: "Figures that stay true.",
        text: "Docs can draw architecture maps, systems, schemas, file trees, walkthroughs and charts. The built-in `write-reader-figures` skill teaches agents to write them.",
      },
      {
        title: "Where to write new docs.",
        text: "`tack docs target` gives an agent the verified folder to write new documents into.",
        command: "tack docs target --project app",
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
        title: "Arguments, checked.",
        text: "Pass arguments after `--`, or as JSON. Every problem is reported at once, before the script runs.",
        command: "tack script run report --project app -- --repo org/app",
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
    claim: "The exact same set, for a teammate, a CI runner or a remote agent.",
    lines: [
      "A profile is a file in your source that lists the exact resources a project gets. You review it like any other change.",
      "Apply it to a project, or pack it into one file that sets up a machine without the source.",
    ],
    proof: "tack profile export agent-setup:reviewer reviewer.tar.gz",
    details: [
      {
        title: "Save what you use now.",
        text: "`tack profile save` copies your current picks into a profile file, after a preview.",
        command: "tack profile save ~/agent-setup reviewer --project app",
      },
      {
        title: "A fixed set.",
        text: "An applied profile gives the project exactly its list. Ordinary picks cannot change it, and `tack status` and `tack doctor` show it.",
        command: "tack profile apply agent-setup:reviewer --project app --target-root ~/code/app",
      },
      {
        title: "One file to carry.",
        text: "`tack profile export` previews, then packs the profile's files into one `.tar.gz` with checksums. No code, hook or installer runs.",
      },
      {
        title: "Set up a fresh machine.",
        text: "On a CI runner or in a container, `apply-bundle` links the same set without the original source and without fetching anything.",
        command:
          "tack profile apply-bundle reviewer.tar.gz --project app --target-root ~/app --apply",
      },
      {
        title: "Look inside a bundle.",
        text: "Read a bundle's inventory before you apply it; `tack check` validates it.",
        command: "tack profile inspect-bundle reviewer.tar.gz",
      },
    ],
  },
] as const satisfies ReadonlyArray<Lens>;

/** A lens's id, which is also its anchor on the page. */
export type LensId = (typeof lenses)[number]["id"];

/** The rules that hold under every lens. */
export const groundRules = {
  label: "Under every lens",
  heading: "Nothing changes until you say so.",
  rules: [
    {
      title: "Preview first.",
      text: "Every command that changes links prints its plan first, and `--apply` writes it. Only `tack init` writes at once, to set Tack up.",
      command: "tack sync --all",
    },
    {
      title: "Links, never copies.",
      text: "Tack records every link it makes and removes only those. Files it did not make stay where they are.",
    },
    {
      title: "Each problem names its fix.",
      text: "`tack doctor` checks the whole machine; every problem it finds ends with the command that fixes it.",
      command: "tack doctor",
    },
    {
      title: "Local and quiet.",
      text: "Tack calls no model and has no telemetry. Only `tack import add` reaches the network, to fetch from GitHub.",
    },
    {
      title: "Built for agents too.",
      text: "Every view ends with the next command to run, and `--json` gives programs a stable contract for status, sync, init, doctor and upgrade.",
    },
    {
      title: "Leave without a trace.",
      text: "`tack state reset --apply` removes every link Tack made and its state. Your files stay.",
      command: "tack state reset",
    },
  ],
} as const satisfies {
  readonly label: string;
  readonly heading: string;
  readonly rules: ReadonlyArray<Detail>;
};

/** The page's close. */
export const outro = {
  heading: "Start with one prompt.",
  text: "Paste the prompt from the home page into your coding agent, or run the commands yourself.",
  start: "Get started",
  docs: "Read the docs",
} as const;
