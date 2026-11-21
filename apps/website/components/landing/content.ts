/**
 * Landing page copy. The landing page carries no benchmark figures.
 */

/** Hero copy. */
export const hero = {
  headline: "One setup. Every coding agent.",
  subhead: "Write a skill once. Tack links it wherever your agents look, in every project.",
} as const;

/**
 * The story plate, after the features: the metaphor of what they said. The agent is the horse and
 * Tack the gear fitted to it, and each beat lights the part of the plate it stands for: the
 * studies (your sources), the saddle (the links), the track (the syncs that keep it running).
 * `region` and `caption` are percentages of the plate, which is 1916 by 821. A `proof` is one
 * command or fact a reader can check, set in monospace.
 */
export const story = {
  heading: "Tack is the gear, not the horse.",
  intro:
    "Your coding agent does the running. Tack fits your skills onto whichever you ride, and takes them off clean.",
  beats: [
    {
      id: "sources",
      title: "Write it once.",
      text: "Skills, commands and docs live in folders you own, or in a Git repository your team shares.",
      proof: "~/skills/review/SKILL.md",
      region: { left: 1.6, top: 5.5, width: 27.6, height: 67.5 },
      caption: { left: 31, top: 12 },
    },
    {
      id: "fit",
      title: "Fit every agent.",
      text: "Tack links your skills into each agent you use. Linked, never copied: edit a skill once and every agent sees it.",
      proof: ".claude/skills/review → ~/skills/review",
      region: { left: 44.6, top: 29, width: 11.4, height: 31 },
      caption: { left: 58, top: 46 },
    },
    {
      id: "track",
      title: "Stay on track.",
      text: "Every sync shows its plan before it writes, and keeps each project and its worktrees current. Tack removes only the links it made.",
      proof: "tack sync --all --apply",
      region: { left: 69, top: 4.3, width: 29.6, height: 43 },
      caption: { left: 40, top: 8 },
    },
  ],
} as const;

/** The labels of a read-only file or link tab in the demo window. */
export const entryView = {
  readOnly: "read-only",
  pointsTo: "Points to",
  resolvesTo: "Resolves to",
  reaches: "Reaches",
  folder: "a folder",
  file: "a file",
  dangling: "nothing: the destination is gone",
  notACopy: "A link, not a copy: an edit in the source shows up here at once.",
  empty: "Empty folder.",
  missing: "Gone: a command removed it.",
} as const;

/**
 * The demo window under the hero: a terminal and a file explorer over a machine with two sources
 * (skills and team docs) and two Git projects. The page says nothing about how it runs.
 */
export const demo = {
  heading: "See it run",
  yourTurn: "Your turn. Tab completes commands, flags and names; reset restores the machine.",
  screenLabel: "Demo terminal output",
  inputLabel: "Type a command",
  play: "Play",
  pause: "Pause",
  resume: "Resume",
  replay: "Replay",
  openTerminal: "Open a terminal",
  markdown: "In the landing page's terminal, the same setup walks through these commands:",
  agent: {
    intro: "A coding agent sets Tack up from one prompt, on a machine that lives in this page.",
    done: "That's the setup. Open a terminal to look around the same machine.",
    interrupted: "Interrupted · continuing in the terminal",
    header: "Coding agent session, replayed. Every tack command runs for real.",
    screenLabel: "Coding agent session",
    tab: "agent — ~/code/app",
    footerMode: "◆ previews before each write",
    footerHint: " · esc to interrupt",
  },
  terminal: {
    note: "# Same machine, your keyboard. The tack CLI walkthrough continues from where the agent stopped: its next step is typed for you, Enter runs it. Tab completes, Up recalls, help lists commands.",
    next: "Next:",
  },
} as const;

/**
 * The features, one block per lens: agents, team, docs. Each block has a headline, plain lines and
 * one command as its proof. Text in `backticks` shows as inline code. Commands reach Cursor only
 * and context reaches no agent, so no line here says otherwise.
 */
export const features = {
  heading: "One copy, linked everywhere.",
  intro:
    "Edit a skill once. Every agent and project that links it sees the change. Teammates get it with a pull.",
  agents: {
    title: "Every agent, every project, every worktree.",
    lines: [
      "One skill folder, linked into Claude Code, Codex and Cursor: for you, and in each project you register, worktrees included.",
      "Turn on a new agent and one sync links every skill you use. Turn it off and only Tack's links go.",
    ],
    note: "Each agent also gets the `use-tack` skill, so it can run Tack for you.",
    proof: "tack adapter enable codex",
    /** One skill folder, and the three links one sync makes to it in a project. */
    links: {
      source: "~/skills/review",
      destinations: [
        { agent: "Claude Code", path: ".claude/skills/review" },
        { agent: "Codex", path: ".agents/skills/review" },
        { agent: "Cursor", path: ".cursor/skills/review" },
      ],
    },
    alt: "Illustration: a blue wireframe horse fitted with a leather driving harness and brass rings.",
  },
  team: {
    title: "Share skills like code.",
    lines: [
      "Keep the team's skills and docs in a Git repository. Each teammate clones it once and links it into the agent they use.",
      "Edits arrive with `git pull`. New skills wait for your sync preview.",
    ],
    note: "Each project picks its own skills, and every worktree of a project gets the same links.",
    proof: "tack source add ~/code/acme-agent-skills",
    alt: "Illustration: a blue wireframe horse at a gallop, wearing a leather saddle with brass stirrups.",
  },
  docs: {
    title: "Docs your agents can find.",
    lines: [
      "Attach a docs folder to a project and every worktree gets it under `.tack/docs`. Agents search it with `tack docs search`.",
      "You read it in a local reader, and a passage you copy keeps its file and line numbers.",
    ],
    proof: "tack docs attach handbook --project app",
    alt: "Screenshot: the Tack docs reader showing an architecture walkthrough, with its document index, metadata and a figure.",
  },
  also: {
    heading: "Also in Tack",
    more: "See every feature, with real output",
    items: [
      {
        title: "Scripts, run by name.",
        text: "Each run gets only the secrets it declares and leaves a history.",
        proof: "tack script run report --project app",
      },
      {
        title: "Skills from GitHub.",
        text: "Copies a skill into your source and records where it came from.",
        proof: "tack import add github:org/repo --skill pdf --into team-skills",
      },
      {
        title: "One file for CI.",
        text: "Packs a reviewed set of skills into one bundle that sets up a fresh machine without fetching.",
        proof: "tack profile export",
      },
    ],
  },
} as const;

/** Getting started: the install command, the first commands and the Node requirement. */
export const getStarted = {
  heading: "Start with one prompt.",
  manualIntro:
    "tack init sets up Tack at once. Every later command that changes links prints a preview first.",
  commands: [
    "npm install --global @tackup/cli",
    "tack init",
    "tack source add ~/agent-setup --skills skills",
    "tack source add ~/agent-setup --skills skills --apply",
    "tack project add app",
    "tack sync --project app",
    "tack sync --project app --apply",
  ],
  note: "Requires Node 22.12 or later, or Bun. Your files are not moved or copied.",
} as const;

/** Questions, from the common objections. */
export const questions = [
  {
    question: "Will it touch my files?",
    answer:
      "Commands that change links to your files preview first and write only with --apply; tack init writes at once to set up Tack and link its own skills. Tack writes symlinks, never copies, and never overwrites a file it did not create.",
  },
  {
    question: "I can symlink my skills myself.",
    answer:
      "You can, for one agent and one folder. Tack does it for three agents, at user level and in every project and worktree, keeps a record of what it created, and removes only that.",
  },
  {
    question: "What if I stop using Tack?",
    answer:
      "Your skills are plain SKILL.md folders in your own directories. tack state reset --apply removes every link Tack created and its state. Your files stay.",
  },
  {
    question: "Does it call a model or send data?",
    answer:
      "No. Tack is a local CLI. It calls no model and has no telemetry. Only tack import add reaches the network, to fetch from GitHub.",
  },
  {
    question: "Can I share a setup with my team?",
    answer:
      "Yes. Keep the team's skills and docs in a Git repository. Each teammate clones it, registers it with tack source add, and gets edits with git pull. Fixed profiles and portable bundles reproduce an exact setup.",
  },
  {
    question: "Is Tack open source?",
    answer: "Yes. Tack is open source under the MIT license.",
  },
] as const;

/** The closing section and the footer line. */
export const closing = {
  heading: "Change agents. Keep your setup.",
  text: "Your skills stay in your folders. Tack links them into the next agent you try.",
  footerLine: "Tack up any agent.",
} as const;
