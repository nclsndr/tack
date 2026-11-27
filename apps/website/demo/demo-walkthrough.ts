/** One step of the tack CLI walkthrough: what it shows, and the command line it runs. */
export type WalkthroughStep = {
  readonly caption: string;
  readonly command: string;
};

/** Declares the skills folder as its own skills entry `.`, with its `tack.yaml` as inline JSON. */
export const sourceSkills = `tack source add ~/skills --config '{"version":1,"name":"skills","skills":[{"path":"."}]}'`;

/** Declares the team docs folder's commands and docs, with its `tack.yaml` as inline JSON. */
export const sourceDocs = `tack source add ~/team-docs --config '{"version":1,"name":"team-docs","commands":[{"path":"commands"}],"docs":[{"name":"handbook","path":"handbook"}]}'`;

/**
 * The tack CLI walkthrough, which the terminal suggests one step at a time once the visitor opens
 * it. Every line runs through the real Tack CLI over the demo machine; a test runs the whole script
 * and checks the links it leaves.
 */
export const demoWalkthrough: ReadonlyArray<WalkthroughStep> = [
  {
    caption: "A folder of skills in your home, and one of team docs. Neither knows Tack yet.",
    command: "tree ~/skills",
  },
  {
    caption: "Set up the machine once: Tack finds your agents and gives them its own skills.",
    command: "tack init",
  },
  {
    caption: "The folder holds skills directly. Declare its tack.yaml as JSON and preview it.",
    command: sourceSkills,
  },
  {
    caption: "Apply: it writes tack.yaml and registers the source.",
    command: `${sourceSkills} --apply`,
  },
  {
    caption: "The team docs and their command, declared and registered in one go.",
    command: `${sourceDocs} --apply`,
  },
  {
    caption: "Register two Git projects.",
    command: "cd ~/code/app && tack project add app",
  },
  { caption: "", command: "cd ~/code/api && tack project add api" },
  { caption: "Preview every link before anything is written.", command: "tack sync --all" },
  { caption: "Apply the plan.", command: "tack sync --all --apply" },
  {
    caption: "Each agent folder holds links back to your files, never copies.",
    command: "tree ~/code/app",
  },
  {
    caption: "Attach the team handbook to app.",
    command: "cd ~/code/app && tack docs attach handbook",
  },
  { caption: "Sync app to mount its docs.", command: "tack sync --project app --apply" },
  {
    caption: "A teammate pushes a new skill to the shared source.",
    command: "cd ~/skills && git pull",
  },
  {
    caption: "The next sync picks it up for every project and agent.",
    command: "tack sync --all --apply",
  },
  { caption: "Both projects now link it.", command: "ls -l ~/code/api/.claude/skills" },
];
