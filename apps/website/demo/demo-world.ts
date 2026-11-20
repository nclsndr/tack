import { makeMemoryVolume } from "./machine/memory-volume.ts";
import type { BrowserMachine } from "./browser-tack.ts";

/** The demo operator's home. */
export const demoHome = "/home/you";

const encoder = new TextEncoder();

/** A `SKILL.md` with the frontmatter Tack reads, and a short body. */
const skill = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;

/** One file of the demo world, under the home unless its path is absolute. */
type DemoFile = readonly [path: string, content: string];

/** The files of a change waiting upstream, which `git pull` brings into a source. */
type UpstreamChange = {
  readonly summary: string;
  readonly files: ReadonlyArray<DemoFile>;
};

/** Tack's own skills, which every state links at user level. */
const builtInFiles: ReadonlyArray<DemoFile> = [
  ["/opt/tack/builtins/tack.yaml", "version: 1\nname: tack\nskills:\n  - path: skills\n"],
  [
    "/opt/tack/builtins/skills/use-tack/SKILL.md",
    "---\nname: use-tack\ndescription: Operate Tack, which manages cross-agent skills, commands, context, docs and scripts.\nmetadata:\n  tack: |\n    version: 1\n    activation: opt-in\n    user-activation: default\n---\n\n# Use Tack\n",
  ],
];

const skillsSource: ReadonlyArray<DemoFile> = [
  [
    "skills/review/SKILL.md",
    skill(
      "review",
      "Review a change for correctness, naming and tests before it is pushed.",
      "# Review\n\nRead the diff top to bottom, then check each test names a behaviour.",
    ),
  ],
  [
    "skills/commit/SKILL.md",
    skill(
      "commit",
      "Write a conventional commit message from the staged diff.",
      "# Commit\n\nSummarise the why in the subject; keep the body to what changed.",
    ),
  ],
];

const docsSource: ReadonlyArray<DemoFile> = [
  [
    "team-docs/handbook/index.md",
    "# Team handbook\n\nHow we build, review and ship. Start with [releases](releases.md).\n",
  ],
  [
    "team-docs/handbook/releases.md",
    "# Releases\n\nTag from main, write the changelog, then announce in #releases.\n",
  ],
  [
    "team-docs/commands/release.md",
    "---\ndescription: Prepare a release from main\n---\n\nRead the handbook's releases page, then list what changed since the last tag.\n",
  ],
];

const projects: ReadonlyArray<DemoFile> = [
  ["code/app/README.md", "# app\n\nThe web app.\n"],
  ["code/app/.gitignore", "node_modules/\n.env\n"],
  ["code/app/.git/HEAD", "ref: refs/heads/main\n"],
  ["code/api/README.md", "# api\n\nThe HTTP API.\n"],
  ["code/api/.gitignore", "node_modules/\n.env\n"],
  ["code/api/.git/HEAD", "ref: refs/heads/main\n"],
];

/** A skill the person made by hand in Claude Code's folder, which Tack reports and leaves alone. */
const handMade: ReadonlyArray<DemoFile> = [
  [
    ".claude/skills/my-notes/SKILL.md",
    skill("my-notes", "Keep my running notes.", "# My notes\n\nAppend notes to ~/notes.md."),
  ],
];

/** The folders the agents keep in the home, which `tack init` finds to enable their adapters. */
const agentHomes = [".claude", ".codex", ".cursor"];

/** What a teammate pushed to the skills source; `git pull` in `~/skills` brings it in. */
export const upstreamChanges: Readonly<Record<string, UpstreamChange>> = {
  [`${demoHome}/skills`]: {
    summary: " ship/SKILL.md | 6 ++++++\n 1 file changed, 6 insertions(+)",
    files: [
      [
        "skills/ship/SKILL.md",
        skill(
          "ship",
          "Cut a release: bump the version, tag main and write the changelog.",
          "# Ship\n\nFollow the handbook's releases page step by step.",
        ),
      ],
    ],
  },
};

/** Writes `files` into `volume`, creating parent folders, with home-relative paths under the home. */
export const writeDemoFiles = (volume: BrowserMachine["volume"], files: ReadonlyArray<DemoFile>) =>
  files.forEach(([relative, content]) => {
    const absolute = relative.startsWith("/") ? relative : `${demoHome}/${relative}`;
    volume.mkdir(absolute.slice(0, absolute.lastIndexOf("/")), { recursive: true });
    volume.writeFile(absolute, encoder.encode(content));
  });

/**
 * The demo machine before anything ran, which the coding agent and the terminal share: a folder
 * that holds skills directly and a folder of team docs with one command, neither with a
 * `tack.yaml` yet; two Git projects under `~/code`; the home folders of three agents, with a skill
 * made by hand in Claude Code's; and Tack's built-in skills. No Tack state exists yet.
 */
export const makeDemoMachine = (): BrowserMachine => {
  const volume = makeMemoryVolume();
  writeDemoFiles(volume, [
    ...builtInFiles,
    ...skillsSource,
    ...docsSource,
    ...projects,
    ...handMade,
  ]);
  agentHomes.forEach((folder) => volume.mkdir(`${demoHome}/${folder}`, { recursive: true }));
  return {
    volume,
    home: demoHome,
    builtInSource: {
      id: "98a032d9-b6da-4f82-89ed-782fcd821af6",
      canonicalPath: "/opt/tack/builtins",
    },
  };
};
