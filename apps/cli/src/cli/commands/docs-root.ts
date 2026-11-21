import { Command } from "effect/cli";
import { cwdFlag, projectFlag } from "./target-selector.ts";

/**
 * The `docs` parent, which owns the project selector its subcommands share: `--project`, or the
 * registered project containing `--cwd` or the current directory.
 */
export const docsRoot = Command.make("docs").pipe(
  Command.withSharedFlags({ projectName: projectFlag, cwd: cwdFlag }),
);

/** Keeps only the selectors the operator passed; omitted, the project comes from the cwd. */
export const docsSelection = (projectName: string | undefined, cwd: string | undefined) => ({
  ...(projectName === undefined ? {} : { projectName }),
  ...(cwd === undefined ? {} : { cwd }),
});
