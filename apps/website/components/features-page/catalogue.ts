import { hero } from "../landing/content.ts";
import init from "./captures/01-init.ansi?raw";
import sourceAddPreview from "./captures/02a-source-add-preview.ansi?raw";
import sourceAddExisting from "./captures/03-source-add-existing.ansi?raw";
import catalog from "./captures/04-catalog.ansi?raw";
import projectAdd from "./captures/05-project-add.ansi?raw";
import syncPreview from "./captures/06a-sync-preview.ansi?raw";
import links from "./captures/07b-ls-links-no-owner.ansi?raw";
import adapterDisable from "./captures/08b-adapter-disable-preview.ansi?raw";
import pickInclude from "./captures/09a-pick-include.ansi?raw";
import projectRefresh from "./captures/10-project-refresh.ansi?raw";
import status from "./captures/11-status.ansi?raw";
import doctor from "./captures/12-doctor.ansi?raw";
import docsAttach from "./captures/13a-docs-attach.ansi?raw";
import docsSearch from "./captures/13d-docs-search.ansi?raw";
import docsTarget from "./captures/13e-docs-target.ansi?raw";
import docsServe from "./captures/13f-docs-serve.ansi?raw";
import scriptShow from "./captures/14a-script-show.ansi?raw";
import scriptRun from "./captures/14b-script-run.ansi?raw";
import scriptHistory from "./captures/14c-script-history.ansi?raw";
import profileSave from "./captures/15a-profile-save-preview.ansi?raw";
import profileApply from "./captures/15b-profile-apply-preview.ansi?raw";
import profileExport from "./captures/15d-profile-export-preview.ansi?raw";
import check from "./captures/16-check.ansi?raw";
import guide from "./captures/17a-guide.ansi?raw";
import statusJson from "./captures/18-status-json.ansi?raw";
import stateReset from "./captures/19-state-reset-preview.ansi?raw";
import importAdd from "./captures/25-import-add-skill-preview.ansi?raw";
import { excerpt, type LineRanges } from "./excerpt.ts";

/**
 * What running a command does, keyed and worded as the legend of `tack --help` (a test holds them
 * to the CLI's own map). `label` is the tag a card shows and `plain` says it for a newcomer, with
 * `backticks` for inline code.
 */
export const modes = {
  read: { label: "Reads only", plain: "Changes nothing.", meaning: "changes nothing" },
  now: { label: "Saves at once", plain: "Saves its change at once.", meaning: "saves at once" },
  plan: {
    label: "Previews first",
    plain: "Prints its plan and writes nothing until you add `--apply`.",
    meaning: "previews; add --apply to write",
  },
  run: {
    label: "Runs a script",
    plain: "Runs a script a source declares.",
    meaning: "executes a declared script",
  },
  conditional: {
    label: "Saves or previews",
    plain:
      "Saves at once when it can, and previews otherwise. A folder with a `tack.yaml` registers at once; without one, Tack previews the file it would write.",
    meaning: "may save at once; see the command help conditions",
  },
} as const;

/** The tag of a card whose command is a plain shell command, not Tack. */
export const shellMode = {
  label: "Shell",
  plain: "A plain shell command, not Tack.",
  meaning: "a plain shell command, not Tack",
} as const;

type Mode = keyof typeof modes;

/** A card as written: its words, the command, and the lines of the real capture it shows. */
type CapabilitySource = {
  /** The card's anchor on the page. */
  readonly id: string;
  readonly title: string;
  /** One line on what the capability gives you. Text in `backticks` shows as inline code. */
  readonly benefit: string;
  /** The command line as typed, with `~` for the home folder. */
  readonly command: string;
  /** The folder the command ran in, shown in the terminal's title bar. */
  readonly cwd: string;
  /**
   * The full output the command printed in the capture sandbox, styles included. Captured at 64
   * columns with `FORCE_COLOR=1`; the sandbox's home folder reads as `~`.
   */
  readonly capture: string;
  /** The capture lines the card shows; omit it to show the whole capture. */
  readonly lines?: LineRanges;
  /** A short name for the card in the opening's "Start here" list, for the first cards to read. */
  readonly start?: string;
} & (
  | {
      /** The `tack` operation the command runs, as `tack --help` names it. */
      readonly operation: string;
      readonly mode: Mode;
    }
  | { readonly operation?: undefined; readonly mode?: undefined }
);

/** A card: as written, with the output it shows derived from its capture. */
export type Capability = CapabilitySource & { readonly output: string };

/** A group of cards under one heading. */
export type CapabilityGroup = {
  readonly id: string;
  readonly label: string;
  readonly heading: string;
  /** Text in `backticks` shows as inline code. */
  readonly intro: string;
  readonly capabilities: ReadonlyArray<Capability>;
};

const card = (source: CapabilitySource): Capability => ({
  ...source,
  output: excerpt(source.capture, source.lines),
});

/** The page's own copy, around the catalogue. */
export const featuresPage = {
  label: "Features",
  headline: "Everything Tack does, in its own output.",
  lead: hero.subhead,
  intro:
    "Each agent reads skills from its own folders, so copies pile up and drift. Tack keeps the one copy you maintain and links it everywhere. Each card below names one thing Tack does and shows what its command printed in a test sandbox: five agents, four projects, a skills folder and a team repository. Where output runs long, the card says how many lines it leaves out.",
  /** The three words the rest of the page builds on. */
  terms: [
    {
      term: "Source",
      definition:
        "A folder you keep, alone or in a shared Git repository, with skills, commands, context, scripts or docs.",
    },
    {
      term: "Project",
      definition: "A Git repository Tack links into, with each of its worktrees.",
    },
    {
      term: "Agent",
      definition:
        "Claude Code, Codex, Cursor, OpenCode or Pi. Each reads its own folders, and Tack links into them.",
    },
  ],
  startHeading: "Start here",
  legend: "Each card tags how its command behaves, with the mode `tack --help` gives it:",
  closing: {
    heading: "Try it on your own folders.",
    text: "Set Tack up once, register a folder of skills, and preview your first sync.",
    note: "Tack is not published to npm yet. Until it is, it installs from a clone of its repository.",
  },
} as const;

/** Every capability, grouped by what it is for, in reading order. */
export const catalogue: ReadonlyArray<CapabilityGroup> = [
  {
    id: "agents",
    label: "Agents",
    heading: "One skill folder, every agent.",
    intro:
      "Tack links the same folders into Claude Code, Codex, Cursor, OpenCode and Pi, for you and in each project. Agents get links, never copies.",
    capabilities: [
      card({
        id: "set-up-a-machine",
        title: "Set up a machine in one command",
        benefit:
          "`tack init` finds the agents on the machine, turns them on and links Tack's own skills for you. Skills you made by hand stay untouched.",
        command: "tack init",
        cwd: "~",
        operation: "init",
        mode: "now",
        capture: init,
        lines: [
          [1, 8],
          [78, 83],
        ],
        start: "Set up a machine",
      }),
      card({
        id: "preview-every-link",
        title: "See every link before it is made",
        benefit:
          "A sync prints its plan for each agent and writes nothing until you add `--apply`.",
        command: "tack sync --project app",
        cwd: "~/code/app",
        operation: "sync",
        mode: "plan",
        capture: syncPreview,
        lines: [
          [1, 16],
          [44, 48],
        ],
        start: "Preview a sync",
      }),
      card({
        id: "commands-where-read",
        title: "Commands for the agents that read them",
        benefit:
          "Commands link into Cursor, OpenCode and Pi (Pi reads them as prompt templates). The plan names the agents that get none.",
        command: "tack sync --project app",
        cwd: "~/code/app",
        operation: "sync",
        mode: "plan",
        capture: syncPreview,
        lines: [[33, 42]],
      }),
      card({
        id: "turn-an-agent-off",
        title: "Turn an agent off cleanly",
        benefit:
          "Disabling an agent previews every link Tack would remove, for you and in each project. Your files stay.",
        command: "tack adapter disable cursor",
        cwd: "~",
        operation: "adapter disable",
        mode: "plan",
        capture: adapterDisable,
        lines: [
          [1, 6],
          [23, 26],
          [32, 33],
        ],
      }),
      card({
        id: "links-not-copies",
        title: "Links, not copies",
        benefit:
          "Each agent folder holds links back to your folder, so an edit to a skill reaches every agent at once, without a sync.",
        command: "ls -go .claude/skills",
        cwd: "~/code/app",
        capture: links,
        start: "Links, not copies",
      }),
    ],
  },
  {
    id: "sources",
    label: "Sources",
    heading: "Your folders, where they already are.",
    intro:
      "A source is a folder you already keep, with skills, commands, context, scripts or docs. Tack reads it where it is and never moves it.",
    capabilities: [
      card({
        id: "any-folder",
        title: "Turn any folder into a source",
        benefit:
          "Point Tack at a folder of skills: it previews the `tack.yaml` it would write, and registers the folder with `--apply`.",
        command: "tack source add ~/skills --skills .",
        cwd: "~",
        operation: "source add",
        mode: "conditional",
        capture: sourceAddPreview,
      }),
      card({
        id: "team-repository",
        title: "Share a team repository",
        benefit:
          "A clone that already has a `tack.yaml` registers at once. Teammates get each edit with `git pull`.",
        command: "tack source add ~/team-docs",
        cwd: "~",
        operation: "source add",
        mode: "conditional",
        capture: sourceAddExisting,
        start: "Share with a team",
      }),
      card({
        id: "catalog",
        title: "See everything your sources declare",
        benefit:
          "One list of the skills, commands, scripts and docs across your sources, each with its description.",
        command: "tack catalog",
        cwd: "~",
        operation: "catalog",
        mode: "read",
        capture: catalog,
        lines: [
          [1, 1],
          [9, 9],
          [47, 67],
        ],
      }),
      card({
        id: "check",
        title: "Check a source before you push",
        benefit:
          "`tack check` validates sources, profiles and docs pages without any Tack state, so it runs on any machine.",
        command: "tack check ~/team-docs ~/skills",
        cwd: "~",
        operation: "check",
        mode: "read",
        capture: check,
        lines: [[1, 17]],
      }),
      card({
        id: "import",
        title: "Copy skills from GitHub",
        benefit:
          "Preview what a GitHub repository offers, then copy the skills you choose into a source you own, with a record of where they came from.",
        command: "tack import add github:anthropics/skills --skill pdf --into skills",
        cwd: "~",
        operation: "import add",
        mode: "plan",
        capture: importAdd,
        lines: [
          [1, 8],
          [72, 72],
          [120, 134],
        ],
      }),
    ],
  },
  {
    id: "projects",
    label: "Projects",
    heading: "Every project, every worktree.",
    intro:
      "Register a Git project once, and refresh it when you add a worktree: Tack links into each of its worktrees, and each project can pick its own skills.",
    capabilities: [
      card({
        id: "register-a-project",
        title: "Register a project",
        benefit:
          "Run it inside a Git repository: Tack records the project and the roots it links into.",
        command: "tack project add app",
        cwd: "~/code/app",
        operation: "project add",
        mode: "now",
        capture: projectAdd,
      }),
      card({
        id: "pick-per-project",
        title: "Pick skills per project",
        benefit:
          "Include an opt-in skill in one project, or exclude one it does not need. The next sync applies it.",
        command: "tack pick include ship --project api",
        cwd: "~",
        operation: "pick include",
        mode: "now",
        capture: pickInclude,
      }),
      card({
        id: "worktrees",
        title: "Add worktrees as you make them",
        benefit:
          "Add a worktree and refresh the project: Tack adds it as a root, and the next sync links it too.",
        command: "tack project refresh --project app",
        cwd: "~",
        operation: "project refresh",
        mode: "plan",
        capture: projectRefresh,
      }),
      card({
        id: "status",
        title: "Know what is linked",
        benefit:
          "One view of a project's links, agents, sources and catalog, and of anything that needs attention.",
        command: "tack status --project app",
        cwd: "~/code/app",
        operation: "status",
        mode: "read",
        capture: status,
      }),
    ],
  },
  {
    id: "docs",
    label: "Docs",
    heading: "Docs your agents can find.",
    intro:
      "Attach a docs folder to a project. Every worktree gets it under `.tack/docs`, agents search it from the terminal, and you read it in a local reader.",
    capabilities: [
      card({
        id: "attach-docs",
        title: "Attach docs to a project",
        benefit:
          "Attach a source's docs once. The next sync mounts them in every worktree of the project.",
        command: "tack docs attach handbook --project app",
        cwd: "~/code/app",
        operation: "docs attach",
        mode: "now",
        capture: docsAttach,
      }),
      card({
        id: "search-docs",
        title: "Search from the terminal",
        benefit: "Agents search the attached docs and get each hit with its file and line numbers.",
        command: "tack docs search changelog",
        cwd: "~/code/app",
        operation: "docs search",
        mode: "read",
        capture: docsSearch,
      }),
      card({
        id: "write-docs",
        title: "Tell agents where to write",
        benefit:
          "`tack docs target` gives an agent the verified folder for new docs, inside the project.",
        command: "tack docs target",
        cwd: "~/code/app",
        operation: "docs target",
        mode: "read",
        capture: docsTarget,
      }),
      card({
        id: "read-docs",
        title: "Read them in a local reader",
        benefit:
          "`tack docs serve` serves the attached docs in a reader on your own machine, at a local address.",
        command: "tack docs serve --no-open --port 4815",
        cwd: "~/code/app",
        operation: "docs serve",
        mode: "read",
        capture: docsServe,
        lines: [[3, 10]],
      }),
    ],
  },
  {
    id: "scripts",
    label: "Scripts",
    heading: "Scripts, run by name.",
    intro:
      "Declare a script in a source, with its arguments, and run it by name in any registered project. Every run leaves a record.",
    capabilities: [
      card({
        id: "run-a-script",
        title: "Run a script by name",
        benefit:
          "The script's own output comes first, then Tack's report of the run: its outcome and the value it returned.",
        command: "tack script run changelog -- --limit 3",
        cwd: "~/code/app",
        operation: "script run",
        mode: "run",
        capture: scriptRun,
        lines: [
          [1, 6],
          [13, 20],
        ],
      }),
      card({
        id: "show-a-script",
        title: "See what a script takes",
        benefit: "Its description, its file and its arguments, before you run it.",
        command: "tack script show changelog",
        cwd: "~/code/app",
        operation: "script show",
        mode: "read",
        capture: scriptShow,
      }),
      card({
        id: "script-history",
        title: "Look back at past runs",
        benefit: "Every run is kept with its outcome and times, and opens in full by its id.",
        command: "tack script history",
        cwd: "~/code/app",
        operation: "script history",
        mode: "read",
        capture: scriptHistory,
      }),
    ],
  },
  {
    id: "profiles",
    label: "Profiles",
    heading: "The exact same set, anywhere.",
    intro:
      "A profile is a list of resources kept as a file in your source, so you review it like any other change. Apply it to a project, or pack it into one file for a machine without your sources.",
    capabilities: [
      card({
        id: "save-a-profile",
        title: "Turn your picks into a profile",
        benefit:
          "Save a project's current selection as a profile file in your source, previewed as a diff first.",
        command: "tack profile save ~/team-docs daily --project api",
        cwd: "~",
        operation: "profile save",
        mode: "plan",
        capture: profileSave,
        lines: [[1, 18]],
      }),
      card({
        id: "apply-a-profile",
        title: "Give a project exactly that set",
        benefit: "Applying a profile previews its members and the link each agent gets.",
        command: "tack profile apply team-docs:frontend --project web --target-root ~/code/web",
        cwd: "~",
        operation: "profile apply",
        mode: "plan",
        capture: profileApply,
        lines: [
          [1, 4],
          [7, 9],
          [12, 16],
        ],
      }),
      card({
        id: "bundle",
        title: "One file for CI and remote agents",
        benefit:
          "Export a profile as one bundle with checksums. On a fresh machine, `tack profile apply-bundle` links the same skills from it, without your sources and without fetching anything.",
        command: "tack profile export team-docs:frontend ~/frontend.tar.gz",
        cwd: "~",
        operation: "profile export",
        mode: "plan",
        capture: profileExport,
        lines: [
          [1, 6],
          [11, 12],
          [17, 19],
        ],
      }),
    ],
  },
  {
    id: "safety",
    label: "Safety and automation",
    heading: "Safe to try, easy to leave.",
    intro:
      "Syncs, removals and resets preview first and change nothing until you add `--apply`. Tack removes only the links it made, and your agent can run it all for you.",
    capabilities: [
      card({
        id: "doctor",
        title: "Check the whole machine",
        benefit:
          "`tack doctor` checks state, agents, sources, projects, docs and every link on the machine, and changes nothing.",
        command: "tack doctor",
        cwd: "~",
        operation: "doctor",
        mode: "read",
        capture: doctor,
        lines: [
          [1, 5],
          [15, 16],
          [24, 29],
        ],
      }),
      card({
        id: "leave-cleanly",
        title: "Undo everything Tack linked",
        benefit:
          "`tack state reset` previews removing every link Tack made, and its state. Your files stay where they are.",
        command: "tack state reset",
        cwd: "~",
        operation: "state reset",
        mode: "plan",
        capture: stateReset,
        lines: [
          [1, 4],
          [218, 224],
        ],
      }),
      card({
        id: "agents-run-tack",
        title: "Your agent can run it",
        benefit:
          "Built-in guides and skills teach agents Tack's commands, and most views end with the command to run next.",
        command: "tack guide",
        cwd: "~",
        operation: "guide",
        mode: "read",
        capture: guide,
      }),
      card({
        id: "json",
        title: "JSON for tools and CI",
        benefit:
          "`--json` prints one envelope for programs, with a stable payload for status, sync, doctor, upgrade and the version.",
        command: "tack status --project app --json | jq | head -20",
        cwd: "~/code/app",
        operation: "status",
        mode: "read",
        capture: statusJson,
      }),
    ],
  },
];

/**
 * Smaller capabilities whose output does not fit a card: an interactive screen, a file write, or a
 * line that depends on how Tack was installed. Each has its command, in the words of `tack --help`.
 */
export const alsoInTack = {
  heading: "Also in Tack",
  items: [
    {
      title: "Browse and pick in your terminal.",
      text: "`tack explore` lists one project's catalog, stages picks and docs, and saves after you review them.",
      command: "tack explore --project app",
      operation: "explore",
    },
    {
      title: "Editor types for scripts.",
      text: "`tack types` writes the types your editor needs for a source's scripts, after a preview.",
      command: "tack types ~/team-docs",
      operation: "types",
    },
    {
      title: "The right upgrade command.",
      text: "`tack upgrade` names the command that upgrades the Tack you run, for the way it was installed.",
      command: "tack upgrade",
      operation: "upgrade",
    },
  ],
} as const;
