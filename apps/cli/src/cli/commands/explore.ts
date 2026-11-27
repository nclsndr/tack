import { Effect } from "effect";
import { Command } from "effect/cli";
import { handle } from "./invocation-receiver.ts";
import { namespaceFrom, projectFlag, userFlag } from "./target-selector.ts";

/** Opens the interactive explorer, which edits a selection or profile after a confirmed review. */
export const exploreCommand = Command.make(
  "explore",
  { projectName: projectFlag, user: userFlag },
  handle(
    "explore",
    Effect.fnUntraced(function* ({ projectName, user }) {
      const destination = yield* namespaceFrom({ projectName, user }, false);
      return { _tag: "explore", ...(destination === undefined ? {} : { destination }) };
    }),
  ),
).pipe(
  Command.withDescription(
    "Browse the catalog and edit one destination in an interactive terminal. Without a flag it opens the project that contains the current directory, or else the destination chooser; --project and --user open that selection. Rows show each resource's state in the destination. i, x and a stage an include, exclude or docs attachment, and the same key again unstages it; u unstages and r resets a saved pick to the source default. c reviews the staged changes: picks and docs apply with a sync only after y, and a profile save changes only its file and publication. d chooses another destination: user, project, profile, or browse only. Built-in daily selections are locked. Agents and non-interactive callers are refused; use tack catalog, tack pick and tack status.",
  ),
  Command.withExamples([
    { command: "tack explore", description: "Open the current project, or choose a destination" },
    {
      command: "tack explore --project demo",
      description: "Stage picks and docs for demo, review the sync plan, then apply",
    },
    { command: "tack explore --user", description: "Do the same for the user namespace" },
  ]),
);
