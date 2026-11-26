import { agentPrompt } from "@tackup/harness/prompts/landing";
import type { DemoSession, ShellResult } from "./demo-shell.ts";
import { demoWalkthrough, sourceDocs, sourceSkills } from "./demo-walkthrough.ts";

/**
 * One thing that happens in the agent walkthrough. A shell call runs on the demo machine through
 * the real Tack CLI unless it carries a scripted `output`, for a command the demo shell cannot run.
 * A call that changes the machine names its `checkpoint`: the step of the CLI walkthrough that comes
 * next from the state it leaves, where the terminal picks up if the visitor opens it there.
 */
type AgentEvent =
  | { readonly kind: "user"; readonly text: string }
  /** The agent works with nothing new on screen but its spinner. */
  | { readonly kind: "thinking" }
  | {
      readonly kind: "tool-call";
      readonly tool: "shell";
      readonly command: string;
      readonly output?: string;
      readonly checkpoint?: number;
    }
  /** A reply, with inline `code`, **bold** and `- ` list items only. */
  | { readonly kind: "assistant"; readonly text: string };

/** One tool call of the walkthrough. */
export type AgentCall = Extract<AgentEvent, { readonly kind: "tool-call" }>;

/** One step of the agent walkthrough: one message from the person and the agent's whole turn. */
export type AgentBeat = {
  readonly caption: string;
  readonly events: ReadonlyArray<AgentEvent>;
};

/**
 * The index of the CLI walkthrough step that runs `command`, the `occurrence`-th one when it runs
 * more than once, so a checkpoint always names a real step.
 */
const stepOf = (command: string, occurrence = 0) => {
  const index = demoWalkthrough
    .flatMap((step, at) => (step.command === command ? [at] : []))
    .at(occurrence);
  // Coverage skip: a checkpoint naming a step that does not exist is a typo the tests reach first.
  /* v8 ignore next -- @preserve */
  if (index === undefined) throw new Error(`No CLI walkthrough step runs ${command}`);
  return index;
};

/**
 * What the recorded session printed for the commands the demo machine cannot run: npm, the guide,
 * which ships with the real package only, and `tack check` on docs, which needs a real machine.
 */
const recorded = {
  npm: "changed 268 packages in 4s\n\n148 packages are looking for funding\n  run `npm fund` for details\n",
  guide: [
    "tack guide · onboarding · ✓ success",
    "",
    "Read all 199 lines of this guide before you act. If your tool shortened this",
    "output, print the lines you missed:",
    "  tack guide onboarding | sed -n 'FIRST,LASTp'",
    "",
    "# Onboard a machine to Tack",
    "",
    "Follow this when Tack was just installed or someone asks you to set it up. Do the steps in order.",
    "Skip a step whose outcome already holds: `tack init` and `tack status` show what holds.",
    "",
  ].join("\n"),
  docsCheck: [
    "tack check · ✓ success",
    "",
    "Checks 3 · errors 0 · warnings 0",
    "",
    "source ~/team-docs",
    "  skill: 0",
    "  command: 1",
    "  context: 0",
    "  script: 0",
    "  docs: 1",
    "",
  ].join("\n"),
};

/**
 * The agent walkthrough: a coding agent setting Tack up from the landing page's prompt, shortened
 * from a session recorded on the same machine. Every `tack` command runs on the demo machine, and
 * tests check that each output says what the reply after it claims, that the agent ends where the
 * CLI walkthrough ends, and that the terminal can take over after any call.
 */
export const agentWalkthrough: ReadonlyArray<AgentBeat> = [
  {
    caption: "One prompt: the agent installs Tack and reads its onboarding guide.",
    events: [
      { kind: "user", text: agentPrompt },
      { kind: "thinking" },
      { kind: "assistant", text: "I'll start by installing the CLI, as you asked." },
      {
        kind: "tool-call",
        tool: "shell",
        command: "npm install --global @tackup/cli",
        output: recorded.npm,
      },
      {
        kind: "tool-call",
        tool: "shell",
        command: "tack guide onboarding",
        output: recorded.guide,
      },
      { kind: "thinking" },
      {
        kind: "assistant",
        text: [
          "Tack is installed and I've read the onboarding guide.",
          "",
          "**Machine.** `tack init` writes at once, with no preview: it records what Tack links in `~/.tack`, enables the agents it finds and links Tack's own skills into them. Shall I run it?",
          "",
          "Which folders hold your skills, commands or docs, and which projects should I link? Quick or full setup?",
        ].join("\n"),
      },
    ],
  },
  {
    caption: "The agent sets the machine up, then previews both folders before writing.",
    events: [
      {
        kind: "user",
        text: "Yes, run it. Quick. My skills are in ~/skills and the team handbook, with one command, is in ~/team-docs. Link them into ~/code/app and ~/code/api.",
      },
      { kind: "thinking" },
      {
        kind: "tool-call",
        tool: "shell",
        command: "tack init",
        checkpoint: stepOf("tack init") + 1,
      },
      { kind: "tool-call", tool: "shell", command: sourceSkills },
      { kind: "tool-call", tool: "shell", command: sourceDocs },
      { kind: "thinking" },
      {
        kind: "assistant",
        text: [
          "`tack init` found **Claude Code**, **Codex** and **Cursor**, and left your hand-made `~/.claude/skills/my-notes` alone.",
          "",
          "**Sources.** Neither folder has a `tack.yaml`, so I declared each as JSON. Both previews wrote nothing:",
          "- `~/skills` has **2 skills**, `commit` and `review`.",
          "- `~/team-docs` has 1 command, `release`, and the `handbook` docs.",
          "",
          "On a yes I register both, check them, and register `app` and `api`, which links nothing yet.",
        ].join("\n"),
      },
    ],
  },
  {
    caption: "On a yes, it registers the folders and projects, then previews every link.",
    events: [
      { kind: "user", text: "Yes." },
      { kind: "thinking" },
      {
        kind: "tool-call",
        tool: "shell",
        command: `${sourceSkills} --apply`,
        checkpoint: stepOf(`${sourceSkills} --apply`) + 1,
      },
      {
        kind: "tool-call",
        tool: "shell",
        command: `${sourceDocs} --apply`,
        checkpoint: stepOf(`${sourceDocs} --apply`) + 1,
      },
      { kind: "tool-call", tool: "shell", command: "tack check ~/skills" },
      {
        kind: "tool-call",
        tool: "shell",
        command: "tack check ~/team-docs",
        output: recorded.docsCheck,
      },
      {
        kind: "tool-call",
        tool: "shell",
        command: "cd ~/code/app && tack project add app",
        checkpoint: stepOf("cd ~/code/app && tack project add app") + 1,
      },
      {
        kind: "tool-call",
        tool: "shell",
        command: "tack project add api --repository-cwd ~/code/api",
        checkpoint: stepOf("cd ~/code/api && tack project add api") + 1,
      },
      { kind: "tool-call", tool: "shell", command: "tack sync --project app" },
      { kind: "tool-call", tool: "shell", command: "tack sync --project api" },
      { kind: "thinking" },
      {
        kind: "assistant",
        text: [
          "**Preview:** 11 changes in each project, 7 links and their folders, no conflicts:",
          "- `commit` and `review` for Claude Code, Codex and Cursor.",
          "- The `release` command for Cursor only: Claude Code and Codex take no commands.",
          "",
          "The links point to paths on this machine, so committed links break for teammates. Apply, and what about Git?",
        ].join("\n"),
      },
    ],
  },
  {
    caption: "Applied: links back to your files, never copies.",
    events: [
      { kind: "user", text: "Yes, apply. Leave .gitignore to me, and attach the handbook to app." },
      { kind: "thinking" },
      { kind: "tool-call", tool: "shell", command: "tack sync --project app --apply" },
      {
        kind: "tool-call",
        tool: "shell",
        command: "tack sync --project api --apply",
        checkpoint: stepOf("tack sync --all --apply") + 1,
      },
      {
        kind: "tool-call",
        tool: "shell",
        command: "tack docs attach handbook --project app",
        checkpoint: stepOf("cd ~/code/app && tack docs attach handbook") + 1,
      },
      { kind: "tool-call", tool: "shell", command: "tack sync --project app" },
      { kind: "thinking" },
      {
        kind: "assistant",
        text: [
          "Both projects are linked, and I left `.gitignore` to you. The handbook is attached to `app`.",
          "",
          "**Preview of the mount:** one docs link in `~/code/app/.tack/docs`, back to `~/team-docs/handbook`. Shall I sync `app` to create it?",
        ].join("\n"),
      },
    ],
  },
  {
    caption: "Docs mount like skills: one link back to the team's folder.",
    events: [
      { kind: "user", text: "Yes, mount it. No agent instructions for now." },
      { kind: "thinking" },
      {
        kind: "tool-call",
        tool: "shell",
        command: "tack sync --project app --apply",
        checkpoint: stepOf("tack sync --project app --apply") + 1,
      },
      { kind: "tool-call", tool: "shell", command: "tack status --project app" },
      { kind: "thinking" },
      {
        kind: "assistant",
        text: [
          "Your machine is set up:",
          "- **7 links** in each project, and the handbook mounted in `app`.",
          "- Your `my-notes` skill and `.gitignore` were left alone.",
          "- To undo, `tack project remove app` previews first and removes only Tack's links.",
        ].join("\n"),
      },
    ],
  },
  {
    caption: "A teammate pushes a new skill: the agent pulls it and previews.",
    events: [
      {
        kind: "user",
        text: "A teammate just pushed a new skill to ~/skills. Pull it and update my projects.",
      },
      { kind: "thinking" },
      {
        kind: "tool-call",
        tool: "shell",
        command: "cd ~/skills && git pull --ff-only",
        checkpoint: stepOf("cd ~/skills && git pull") + 1,
      },
      { kind: "tool-call", tool: "shell", command: "tack check ~/skills" },
      { kind: "tool-call", tool: "shell", command: "tack sync --project app" },
      { kind: "tool-call", tool: "shell", command: "tack sync --project api" },
      { kind: "thinking" },
      {
        kind: "assistant",
        text: [
          "The pull brought in one new skill, `ship`, and `tack check` is clean.",
          "",
          "**Preview:** 3 new links in each project, one per agent. Nothing else changes. Apply?",
        ].join("\n"),
      },
    ],
  },
  {
    caption: "One more yes, and every agent in both projects has it.",
    events: [
      { kind: "user", text: "Yes." },
      { kind: "thinking" },
      { kind: "tool-call", tool: "shell", command: "tack sync --project app --apply" },
      {
        kind: "tool-call",
        tool: "shell",
        command: "tack sync --project api --apply",
        checkpoint: stepOf("tack sync --all --apply", 1) + 1,
      },
      { kind: "thinking" },
      {
        kind: "assistant",
        text: "`ship` is now linked into `app` and `api` for Claude Code, Codex and Cursor. Open agent sessions may need a restart to see it.",
      },
    ],
  },
];

/** Every tool call of the walkthrough, in the order they run. */
export const agentCalls: ReadonlyArray<AgentCall> = agentWalkthrough.flatMap((beat) =>
  beat.events.filter((event): event is AgentCall => event.kind === "tool-call"),
);

/**
 * The CLI walkthrough step the terminal suggests once the first `done` agent calls have run: the
 * checkpoint of the last of them that changed the machine, or the first step before any did.
 */
export const resumeStep = (done: number) =>
  agentCalls
    .slice(0, done)
    .reduce((step, call) => (call.checkpoint !== undefined ? call.checkpoint : step), 0);

/** The step suggested after the visitor ran `line` at `step`: the next one if they ran this one. */
export const nextStep = (step: number, line: string) =>
  demoWalkthrough[step]?.command === line.trim() ? step + 1 : step;

/**
 * Plays one tool call on `session`: it runs there unless its output is scripted.
 */
export const runAgentCall = async (
  session: DemoSession,
  call: AgentCall,
  columns: number,
): Promise<ShellResult> => {
  if (call.output !== undefined) return { output: call.output, exitCode: 0 };
  return session.run(call.command, columns);
};

/** How long an agent's turn took and how many tokens it wrote, as its spinner reports them. */
export type TurnFigures = { readonly seconds: number; readonly tokens: number };

/**
 * Plausible figures for a beat, derived from what it does: the reply's length, its tool calls and
 * its pauses to think. Nothing here was measured; the figures only have to grow with the work.
 */
export const beatFigures = (beat: AgentBeat): TurnFigures => {
  const tokens = beat.events.reduce(
    (sum, event) =>
      sum +
      (event.kind === "assistant"
        ? Math.ceil(event.text.length / 4)
        : event.kind === "tool-call"
          ? 45
          : event.kind === "thinking"
            ? 90
            : 0),
    0,
  );
  const calls = beat.events.filter((event) => event.kind === "tool-call").length;
  return { seconds: Math.ceil(tokens / 80) + calls, tokens };
};

/** The live spinner's figures once `played` of a beat's `total` events have played. */
export const spinnerFigures = (
  figures: TurnFigures,
  played: number,
  total: number,
): TurnFigures => ({
  seconds: Math.round((figures.seconds * played) / total),
  tokens: Math.round((figures.tokens * played) / total),
});

/**
 * Every speed and pause of the agent walkthrough, in milliseconds, so they tune in one place.
 * Reduced motion shows typed and streamed text whole, but keeps the pauses.
 */
export const agentPacing = {
  /** A message longer than this is pasted into the input box, not typed. */
  pasteOver: 80,
  /** Each typed character takes between these two delays. */
  typeMinimum: 30,
  typeMaximum: 70,
  /** The message stays in the input box this long before it is sent. */
  beforeSend: 650,
  /** A thinking pause, with only the spinner moving. */
  thinking: 1100,
  /** A call shows as running this long before its output lands, and its output this long after. */
  beforeOutput: 450,
  afterOutput: 800,
  /** A reply streams in one word at a time, this far apart. */
  word: 32,
  /** How many lines of a call's output the screen keeps. */
  outputLines: 5,
  /** After a reply, a pause to read it: a base plus a little per word, up to a ceiling. */
  afterReply: 1600,
  afterReplyPerWord: 45,
  afterReplyMaximum: 5200,
} as const;

/** Whether `text` is pasted into the input box at once rather than typed. */
export const pastes = (text: string) => text.length > agentPacing.pasteOver;

/** The delay before the next typed character; `random` is a number in [0, 1). */
export const agentTypingDelay = (random: number) =>
  agentPacing.typeMinimum +
  Math.floor(random * (agentPacing.typeMaximum - agentPacing.typeMinimum));

/** How long to leave a reply of `words` words on screen before the next beat. */
export const replyPause = (words: number) =>
  Math.min(
    agentPacing.afterReplyMaximum,
    agentPacing.afterReply + words * agentPacing.afterReplyPerWord,
  );
