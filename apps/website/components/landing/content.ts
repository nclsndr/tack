/**
 * Landing page copy. The landing page carries no benchmark figures, and no count of agents leads
 * it.
 */

import { intro, sharedAgents } from "../features-page/content.ts";
import { repositoryUrl } from "../site.ts";

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

/** The docs overview, where every page sends a reader for more. */
export const docsHref = "/docs/";

/** The landing page's title, for the browser tab and for a shared link. */
export const pageTitle = "Tack: one setup for every agent, project and worktree";

/**
 * The story plate, right after the demo: the metaphor of what it showed. The agent is the horse and
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
      text: "Skills, commands and docs live in sources: folders you own and Git repositories your team shares.",
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
 * The features, as a strip of six parts that each lead to their section of the features page,
 * which has the commands, figures and details. The parts follow the features page's order, and
 * `content.test.ts` keeps their ids and names in step with it. Text in `backticks` shows as inline
 * code. Commands reach Cline, Cursor, OpenCode and Pi only, and context reaches no agent, so no
 * line here says otherwise.
 */
export const features = {
  label: "Features",
  heading: "Share skills like code.",
  /** The features page's problem: the team's pain, then one developer's. */
  problem: intro.problem,
  intro: "Six parts, each one sync away. Every part has its page section, with every command.",
  parts: [
    {
      id: "sources",
      name: "Sources",
      line: "A source hosts your skills, commands, docs and scripts, yours beside your team's. Every project links to it; edits arrive with `git pull`.",
    },
    {
      id: "projects",
      name: "Projects",
      line: "Each project picks its own skills, and every Git worktree gets the same links.",
    },
    {
      id: "agents",
      name: "Agents",
      line: `Claude Code, Codex, Cursor, Copilot CLI, Gemini CLI, Cline, OpenCode, Pi, and ${sharedAgents.rows.length} more agents that read the same folders.`,
    },
    {
      id: "profiles",
      name: "Profiles",
      line: "One reviewed file sets up a CI runner or a container, without the source and without fetching anything.",
    },
    {
      id: "docs",
      name: "Docs",
      line: "Your docs in every worktree under `.tack/docs`, searched by agents, read by you in a local reader.",
    },
    {
      id: "scripts",
      name: "Scripts",
      line: "Scripts declared beside your skills. Each run gets only the secrets it declares.",
    },
  ],
  /** The way on to the features page, which details every feature by part. */
  more: { label: "See every feature, part by part →", href: "/features" },
} as const;

/** The `tack.yaml` of the getting-started source, as the JSON `tack source add --config` takes. */
const agentSetupConfig = '{"version": 1, "name": "agent-setup", "skills": [{"path": "skills"}]}';

/** Getting started: the install command, the first commands and the Node requirement. */
export const getStarted = {
  heading: "Start with one prompt.",
  manualIntro:
    "tack init sets up Tack at once. Every later command that changes links prints a preview first.",
  commands: [
    "npm install --global @tackup/cli",
    "tack init",
    `tack source add ~/agent-setup --config '${agentSetupConfig}'`,
    `tack source add ~/agent-setup --config '${agentSetupConfig}' --apply`,
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
    question: "How is Tack different from the skills CLI or skillshare?",
    answer:
      "The skills CLI installs skills from a repository into a project or your home, and tracks their updates in a lockfile. skillshare syncs skills, MCP servers, hooks and plugins from one folder to many tools. Tack links your skills and your team's, from as many repositories as you keep, into every project and worktree for each agent, shows its plan before it writes, and carries docs and scripts with the skills. Compare, in the docs, has the table and says when another tool fits better.",
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
    question: "What if I stop using Tack?",
    answer:
      "Your skills are plain SKILL.md folders in your own sources. tack state reset --apply removes every link Tack created and its state. Your files stay.",
  },
  {
    question: "Does it call a model or send data?",
    answer:
      "No. Tack is a local CLI. It calls no model and has no telemetry. Only tack import add reaches the network, to fetch from GitHub.",
  },
] as const;

/** The footer's links: the docs, how Tack compares with the other ways, and its repository. */
export const footer = {
  links: [
    { label: "Docs", href: docsHref },
    { label: "Compare", href: "/docs/compare" },
    { label: "GitHub", href: repositoryUrl },
  ],
} as const;

/** The closing section and the footer line. */
export const closing = {
  heading: "Change agents. Keep your setup.",
  text: "Your skills stay in your sources. Tack links them into the next agent you try.",
  footerLine: "Tack up any agent.",
} as const;
