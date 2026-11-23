/**
 * The operation map printed by `tack --help`: every executable operation once, grouped by task.
 * A test checks it against the command tree, so a new operation cannot be left off the map and a
 * row cannot name a mode the operation does not have.
 */

/** What running an operation does, in the words the map's legend uses. */
export type MapMode = "now" | "plan" | "read" | "run" | "conditional";

/** One map row: the operations it covers, as `tack` command paths, and how it is written. */
type MapRow = {
  /** The command paths, without `tack`, that the row covers; every one has the row's mode. */
  readonly operations: ReadonlyArray<string>;
  readonly usage: string;
  readonly mode: MapMode;
  readonly summary: string;
};

/** A task heading and its rows. */
export type MapGroup = { readonly title: string; readonly rows: ReadonlyArray<MapRow> };

/** The legend for {@link MapMode}, in the order the map prints it. */
export const mapModes: ReadonlyArray<readonly [MapMode, string]> = [
  ["read", "changes nothing"],
  ["now", "saves at once"],
  ["plan", "previews; add --apply to write"],
  ["run", "executes a declared script"],
  ["conditional", "may save at once; see the command help conditions"],
];

/** The operation map, in reading order. */
export const operationMap: ReadonlyArray<MapGroup> = [
  {
    title: "Set up",
    rows: [
      {
        operations: ["init"],
        usage: "init [--adapter <adapter>]...",
        mode: "now",
        summary:
          "set up this machine: state, agents and the built-in skills; rerun after an upgrade",
      },
      {
        operations: ["guide"],
        usage: "guide [<topic>]",
        mode: "read",
        summary: "print a guide for agents, such as onboarding; bare, list them",
      },
      {
        operations: ["state init"],
        usage: "state init",
        mode: "now",
        summary: "create Tack state",
      },
      {
        operations: ["check"],
        usage: "check <path>...",
        mode: "read",
        summary: "check sources, profile files, bundles and docs without state",
      },
      {
        operations: ["source add"],
        usage: "source add <path>",
        mode: "plan",
        summary: "preview registering a source, and any tack.yaml it needs; --apply writes",
      },
      {
        operations: ["project add"],
        usage: "project add <name>",
        mode: "now",
        summary: "register the Git project in the current directory",
      },
      {
        operations: ["adapter enable"],
        usage: "adapter enable [<adapter>...]",
        mode: "now",
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
        mode: "read",
        summary: "read the content bundle inventory; use tack check to validate",
      },
      {
        operations: ["doctor"],
        usage: "doctor",
        mode: "read",
        summary: "machine-wide health; each problem names its next command",
      },
      {
        operations: ["status"],
        usage: "status",
        mode: "read",
        summary: "health and links of one target; --details lists every link",
      },
      {
        operations: ["catalog"],
        usage: "catalog",
        mode: "read",
        summary: "every resource the sources declare; --kind, --details",
      },
      {
        operations: ["source", "project", "adapter"],
        usage: "source | project | adapter",
        mode: "read",
        summary: "bare, list what is registered or enabled",
      },
      {
        operations: ["pick", "import", "docs"],
        usage: "pick | import | docs",
        mode: "read",
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
        mode: "plan",
        summary:
          "copy daily membership to a profile or profile members to ordinary intent; --apply confirms",
      },
      {
        operations: ["profile apply", "profile apply-bundle"],
        usage: "profile apply|apply-bundle",
        mode: "plan",
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
        mode: "now",
        summary: "choose a resource for one target; built-in skills are locked",
      },
      {
        operations: ["sync"],
        usage: "sync",
        mode: "plan",
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
        mode: "now",
        summary: "attach a source's docs to a project, then sync",
      },
      {
        operations: ["docs configure"],
        usage: "docs configure",
        mode: "now",
        summary: "set the mount directory and default writing resource",
      },
      {
        operations: ["docs search"],
        usage: "docs search <query>",
        mode: "read",
        summary: "search the attached docs",
      },
      {
        operations: ["docs icons"],
        usage: "docs icons [word]",
        mode: "read",
        summary: "find the icons docs may use",
      },
      {
        operations: ["docs target"],
        usage: "docs target",
        mode: "read",
        summary: "the verified path to write docs to",
      },
      {
        operations: ["docs serve"],
        usage: "docs serve",
        mode: "read",
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
        mode: "run",
        summary: "run a declared script",
      },
      {
        operations: ["script show"],
        usage: "script show <reference>",
        mode: "read",
        summary: "a script's arguments and secrets",
      },
      {
        operations: ["types"],
        usage: "types [path]",
        mode: "plan",
        summary: "editor types for a source's scripts",
      },
      {
        operations: ["script history", "script history show"],
        usage: "script history [show <run-id>]",
        mode: "read",
        summary: "past runs",
      },
      {
        operations: ["script history clear"],
        usage: "script history clear",
        mode: "plan",
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
        mode: "plan",
        summary: "copy skills from a remote location into a source",
      },
      {
        operations: ["import remove"],
        usage: "import remove <reference>",
        mode: "plan",
        summary: "delete an imported skill",
      },
      {
        operations: ["source relocate"],
        usage: "source relocate <id> <path>",
        mode: "now",
        summary: "point a registered source at a new folder",
      },
      {
        operations: ["project refresh"],
        usage: "project refresh",
        mode: "plan",
        summary: "update a project's worktree roots and docs mounts",
      },
      {
        operations: ["source remove", "project remove"],
        usage: "source remove <source> | project remove <name>",
        mode: "plan",
        summary: "unregister a source or project, its links, docs mounts and picks",
      },
      {
        operations: ["adapter disable"],
        usage: "adapter disable <adapter>",
        mode: "plan",
        summary: "remove an adapter and its links",
      },
      {
        operations: ["state clean", "state reset"],
        usage: "state clean | state reset",
        mode: "plan",
        summary: "remove managed links, or links and all state",
      },
      {
        operations: ["upgrade", "upgrade status"],
        usage: "upgrade [status]",
        mode: "read",
        summary: "the command that upgrades this Tack",
      },
    ],
  },
];
