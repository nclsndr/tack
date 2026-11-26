/**
 * Landing page copy. The landing page carries no benchmark figures, and no count of agents leads
 * it.
 */

import { sharedAgents } from "../features-page/content.ts";

/**
 * What Tack is, in one sentence, word for word wherever a page or package describes it: the site,
 * the docs overview and the package descriptions (`content.test.ts` checks each one).
 */
export const definingSentence =
  "Tack is an open-source CLI that combines the agent skills, commands, docs and scripts in the folders and Git repositories you and your team own into one setup, links it into every coding agent, project and Git worktree, and shows every change before it writes.";

/**
 * Hero copy: the tagline, the lead line beside it, the agents Tack has an adapter for, and a strip
 * of facts a reader can check.
 */
export const hero = {
  headline: "One setup. Every agent, project and worktree.",
  subhead:
    "Combine your own skills and docs with your team's, from as many repositories as you keep. Tack links them into every project and worktree, for each agent you use, and shows the plan before it writes.",
  agents: "Claude Code, Codex, Cursor, Copilot CLI, Gemini CLI, Cline, OpenCode and Pi today.",
  facts: [
    "Preview before every write",
    "Your repositories, no registry",
    "No account, no telemetry",
    "Open source, MIT",
  ],
} as const;

/** The landing page's title, for the browser tab and for a shared link. */
export const pageTitle = "Tack: one setup for every agent, project and worktree";

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
      text: "Skills, commands and docs live in folders you own and in Git repositories your team shares.",
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
 * The features, one block per lens, the team first: team, projects, agents, docs, then profiles
 * for a CI runner. Each block has a headline, plain lines and one command as its proof. Text in
 * `backticks` shows as inline code. Commands reach Cline, Cursor, OpenCode and Pi only, and
 * context reaches no agent, so no line here says otherwise.
 */
export const features = {
  heading: "Share skills like code.",
  intro:
    "Your skills and your team's live in Git repositories, side by side. A pull brings a teammate's edit. A sync shows what would change before it changes anything.",
  team: {
    title: "One setup for the whole team.",
    lines: [
      "Keep the team's skills and docs in a Git repository. Each teammate clones it once, adds it beside their own skills, and links both into the agent they use: Claude Code for one, Cursor or Codex for another.",
      "A change goes through review like any code. Edits arrive with `git pull`. New skills wait for your sync preview.",
    ],
    note: "No account and no registry: Git does the sharing.",
    proof: "tack source add ~/code/acme-agent-skills",
    alt: "Illustration: a blue wireframe horse at a gallop, wearing a leather saddle with brass stirrups.",
  },
  projects: {
    title: "Each project picks its own. Every worktree follows.",
    lines: [
      "Register a repository once and choose the skills it needs. Each of its worktrees gets the same links.",
      "After `git worktree add`, one refresh and one sync bring the new worktree level with the others.",
    ],
    proof: "tack project refresh --project app --apply",
  },
  agents: {
    title: "Whatever agent each person uses.",
    lines: [
      `One skill folder reaches Claude Code, Codex, Cursor, Copilot CLI, Gemini CLI, Cline, OpenCode and Pi, and ${sharedAgents.rows.length} more agents that read the same folders.`,
      "Turn on a new agent and one sync links every skill you use. Turn it off and only Tack's links go.",
    ],
    note: "Each agent also gets the `use-tack` skill, so it can run Tack for you.",
    proof: "tack adapter enable codex",
    /**
     * One skill folder, and the link one sync makes to it in a project for each agent, in the CLI's
     * adapter order. `content.test.ts` checks the paths against the CLI's adapter table.
     */
    links: {
      source: "~/skills/review",
      destinations: [
        { agent: "Claude Code", path: ".claude/skills/review" },
        { agent: "Cline", path: ".cline/skills/review" },
        { agent: "Codex", path: ".agents/skills/review" },
        { agent: "Copilot CLI", path: ".github/skills/review" },
        { agent: "Cursor", path: ".cursor/skills/review" },
        { agent: "Gemini CLI", path: ".gemini/skills/review" },
        { agent: "OpenCode", path: ".opencode/skills/review" },
        { agent: "Pi", path: ".pi/skills/review" },
      ],
    },
    alt: "Illustration: a blue wireframe horse fitted with a leather driving harness and brass rings.",
  },
  docs: {
    title: "The docs your skills point to, in every worktree.",
    lines: [
      "Attach a docs folder to a project and each worktree gets it under `.tack/docs`, as a link to the one copy you maintain.",
      "Agents read it there or search it with `tack docs search`. You read it in a local reader.",
    ],
    proof: "tack docs attach handbook --project app",
    alt: "Screenshot: the Tack docs reader showing an architecture walkthrough, with its document index, metadata and a figure.",
  },
  profiles: {
    title: "The same set on a CI runner.",
    lines: [
      "A profile is a file in one of your sources that lists an exact set. You review it like any change.",
      "`tack profile export` packs it into one file with checksums. On a fresh machine, `tack profile apply-bundle` sets it up without the source and without fetching anything.",
    ],
    proof: "tack profile export agent-setup:reviewer reviewer.tar.gz",
  },
  also: {
    heading: "Also in Tack",
    items: [
      {
        title: "Scripts, declared beside your skills.",
        text: "Each run gets only the secrets it declares and leaves a history.",
        proof: "tack script run report --project app",
      },
      {
        title: "Skills from GitHub, as your own copy.",
        text: "Tack copies a skill into one of your sources and records where it came from. It changes only when you commit a change.",
        proof: "tack import add github:org/repo --skill pdf --into team-skills",
      },
    ],
  },
  /** The way on to the features page, which details every feature by lens. */
  more: { label: "See every feature, lens by lens →", href: "/features" },
} as const;

/** The `tack.yaml` of the getting-started source, as the JSON `tack source add --config -` reads. */
const agentSetupConfig = '{"version": 1, "name": "agent-setup", "skills": [{"path": "skills"}]}';

/** Getting started: the install command, the first commands and the Node requirement. */
export const getStarted = {
  heading: "Start with one prompt.",
  manualIntro:
    "tack init sets up Tack at once. Every later command that changes links prints a preview first.",
  commands: [
    "npm install --global @tackup/cli",
    "tack init",
    `tack source add ~/agent-setup --config - <<'EOF'\n${agentSetupConfig}\nEOF`,
    `tack source add ~/agent-setup --config - --apply <<'EOF'\n${agentSetupConfig}\nEOF`,
    "tack project add app",
    "tack sync --project app",
    "tack sync --project app --apply",
  ],
  note: "Requires Node 22.12 or later, or Bun. Your files are not moved or copied.",
  teammate:
    "Joining a repository that already uses Tack? Its `AGENTS.md` tells your agent what to run.",
} as const;

/** Questions, from the common objections, the likeliest first. */
export const questions = [
  {
    question: "I can symlink my skills myself.",
    answer:
      "You can, and for one agent, one repository and one machine a script is enough. Tack adds what a script does not have: a set for each project, every worktree of each project, a preview before each write, a record of every link so that it removes only its own, and your own skills combined with your team's. tack status tells you when a link is broken.",
  },
  {
    question: "Most agents read .agents/skills now. Do I still need Tack?",
    answer:
      "Not always. With one repository, one machine and agents that all read .agents/skills, commit the folder and use no tool. Tack is for the next step: the same skills in several repositories, a different set for each project, worktrees, a teammate on Claude Code, which reads .claude/skills, and a CI runner.",
  },
  {
    question: "Does it work in CI, or for a remote agent?",
    answer:
      "Yes. tack profile export packs a profile your team reviewed into one file with checksums, and tack profile apply-bundle sets it up on a fresh machine without the source and without fetching anything.",
  },
  {
    question: "Will it touch my files?",
    answer:
      "Commands that change links to your files preview first and write only with --apply; tack init writes at once to set up Tack and link its own skills. Tack writes symlinks, never copies, and never overwrites a file it did not create.",
  },
  {
    question: "Can I share a setup with my team?",
    answer:
      "Yes. Keep the team's skills and docs in a Git repository. Each teammate clones it, registers it with tack source add --apply beside their own sources, and gets edits with git pull. Fixed profiles and portable bundles reproduce an exact setup.",
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
