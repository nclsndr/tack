/**
 * The operation map printed by `tack --help`: every executable operation once, grouped by task.
 * A test checks it against the command tree, so a new operation cannot be left off the map and a
 * row cannot name a mode the operation does not have.
 */
import { MutationModeSchema, type MutationMode } from "../commands/operation-contract.ts";

/** One map row: the operations it covers, as `tack` command paths, and how it is written. */
type MapRow = {
  /** The command paths, without `tack`, that the row covers; every one has the row's mode. */
  readonly operations: ReadonlyArray<string>;
  readonly usage: string;
  readonly mode: MutationMode;
  readonly summary: string;
};

/** A task heading and its rows. */
export type MapGroup = { readonly title: string; readonly rows: ReadonlyArray<MapRow> };

/** The word the map prints for each mode, and what the legend says it means. */
export const mapModeWords = {
  "read-only": { word: "read", meaning: "changes nothing" },
  immediate: { word: "now", meaning: "saves at once" },
  "preview-apply": { word: "plan", meaning: "previews; add --apply to write" },
  execute: { word: "run", meaning: "executes a declared script" },
  conditional: {
    word: "conditional",
    meaning: "may save at once; see the command help conditions",
  },
} as const satisfies Record<MutationMode, { readonly word: string; readonly meaning: string }>;

/** The legend, one entry per mode in the order the modes are declared. */
export const mapModes = MutationModeSchema.literals.map((mode) => mapModeWords[mode]);

/** The operation map, in reading order. */
export const operationMap: ReadonlyArray<MapGroup> = [
  {
    title: "Set up",
    rows: [
      {
        operations: ["init"],
        usage: "init [--adapter <adapter>]...",
        mode: "immediate",
        summary:
          "set up this machine: state, agents and the built-in skills; rerun after an upgrade",
      },
      {
        operations: ["guide"],
        usage: "guide [<topic>]",
        mode: "read-only",
        summary: "print a guide for agents, such as onboarding; bare, list them",
      },
      {
        operations: ["state init"],
        usage: "state init",
        mode: "immediate",
        summary: "create Tack state",
      },
      {
        operations: ["check"],
        usage: "check [path...]",
        mode: "read-only",
        summary: "check sources, profile files, bundles and docs without state",
      },
      {
        operations: ["source add"],
        usage: "source add <path>",
        mode: "preview-apply",
        summary: "preview registering a source, and any tack.yaml it needs; --apply writes",
      },
      {
        operations: ["project add"],
        usage: "project add <name>",
        mode: "immediate",
        summary: "register the Git project in the current directory",
      },
      {
        operations: ["adapter enable"],
        usage: "adapter enable [<adapter>...]",
        mode: "immediate",
        summary: "choose the agents that receive links",
      },
    ],
  },
  {
    title: "Inspect",
    rows: [
      {
        operations: ["profile inspect-bundle"],
        usage: "profile inspect-bundle <file>",
        mode: "read-only",
        summary: "read the content bundle inventory; use tack check to validate",
      },
      {
        operations: ["doctor"],
        usage: "doctor",
        mode: "read-only",
        summary: "machine-wide health; each problem names its next command",
      },
      {
        operations: ["status"],
        usage: "status",
        mode: "read-only",
        summary: "health and links of one target; --details lists every link",
      },
      {
        operations: ["catalog"],
        usage: "catalog",
        mode: "read-only",
        summary: "every resource the sources declare; --kind, --details",
      },
      {
        operations: ["source", "project", "adapter"],
        usage: "source | project | adapter",
        mode: "read-only",
        summary: "bare, list what is registered or enabled",
      },
      {
        operations: ["pick", "import", "docs"],
        usage: "pick | import | docs",
        mode: "read-only",
        summary: "bare, list choices, imported skills or attached docs",
      },
    ],
  },
  {
    title: "Select and deliver",
    rows: [
      {
        operations: ["profile save", "profile adopt", "profile export"],
        usage: "profile save|adopt|export",
        mode: "preview-apply",
        summary:
          "copy daily membership to a profile or profile members to ordinary intent; --apply confirms",
      },
      {
        operations: ["profile apply", "profile apply-bundle"],
        usage: "profile apply|apply-bundle",
        mode: "preview-apply",
        summary:
          "preview fixed inventory at a complete target; --apply writes, --force replaces intent",
      },
      {
        operations: ["explore"],
        usage: "explore",
        mode: "conditional",
        summary: "browse and edit picks, docs and profiles in a terminal; saves after review",
      },
      {
        operations: ["pick include", "pick exclude", "pick remove"],
        usage: "pick include|exclude|remove <reference>",
        mode: "immediate",
        summary: "choose a resource for one target; built-in skills are locked",
      },
      {
        operations: ["sync"],
        usage: "sync",
        mode: "preview-apply",
        summary: "create and remove links and docs mounts",
      },
    ],
  },
  {
    title: "Docs",
    rows: [
      {
        operations: ["docs attach", "docs detach"],
        usage: "docs attach|detach <reference>",
        mode: "immediate",
        summary: "attach a source's docs to a project, then sync",
      },
      {
        operations: ["docs configure"],
        usage: "docs configure",
        mode: "immediate",
        summary: "set the mount directory and default writing resource",
      },
      {
        operations: ["docs search"],
        usage: "docs search <query>",
        mode: "read-only",
        summary: "search the attached docs",
      },
      {
        operations: ["docs icons"],
        usage: "docs icons [word]",
        mode: "read-only",
        summary: "find the icons docs may use",
      },
      {
        operations: ["docs target"],
        usage: "docs target",
        mode: "read-only",
        summary: "the verified path to write docs to",
      },
      {
        operations: ["docs serve"],
        usage: "docs serve",
        mode: "read-only",
        summary: "open the browser reader",
      },
    ],
  },
  {
    title: "Scripts",
    rows: [
      {
        operations: ["script run"],
        usage: "script run <reference>",
        mode: "execute",
        summary: "run a declared script",
      },
      {
        operations: ["script show"],
        usage: "script show <reference>",
        mode: "read-only",
        summary: "a script's arguments and secrets",
      },
      {
        operations: ["types"],
        usage: "types [path]",
        mode: "preview-apply",
        summary: "editor types for a source's scripts",
      },
      {
        operations: ["script history", "script history show"],
        usage: "script history [show <run-id>]",
        mode: "read-only",
        summary: "past runs",
      },
      {
        operations: ["script history clear"],
        usage: "script history clear",
        mode: "preview-apply",
        summary: "delete past runs",
      },
    ],
  },
  {
    title: "Maintain",
    rows: [
      {
        operations: ["import add"],
        usage: "import add <location>",
        mode: "preview-apply",
        summary: "copy skills from a remote location into a source",
      },
      {
        operations: ["import remove"],
        usage: "import remove <reference>",
        mode: "preview-apply",
        summary: "delete an imported skill",
      },
      {
        operations: ["source relocate"],
        usage: "source relocate <id> <path>",
        mode: "immediate",
        summary: "point a registered source at a new folder",
      },
      {
        operations: ["project refresh"],
        usage: "project refresh",
        mode: "preview-apply",
        summary: "update a project's worktree roots and docs mounts",
      },
      {
        operations: ["source remove", "project remove"],
        usage: "source remove <source> | project remove <name>",
        mode: "preview-apply",
        summary: "unregister a source or project, its links, docs mounts and picks",
      },
      {
        operations: ["adapter disable"],
        usage: "adapter disable <adapter>",
        mode: "preview-apply",
        summary: "remove an adapter and its links",
      },
      {
        operations: ["state clean", "state reset"],
        usage: "state clean | state reset",
        mode: "preview-apply",
        summary: "remove managed links, or links and all state",
      },
      {
        operations: ["upgrade", "upgrade status"],
        usage: "upgrade [status]",
        mode: "read-only",
        summary: "the command that upgrades this Tack",
      },
    ],
  },
];
