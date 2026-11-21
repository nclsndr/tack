import { Command } from "effect/cli";
import { optionalStringFlag } from "./flag-utils.ts";
import { jsonFlag } from "./output-flag.ts";

const stateDirectoryFlag = optionalStringFlag("state-dir", "Override the Tack state directory");

/** Root command that owns shared transport flags. */
export const rootCommand = Command.make("tack").pipe(
  Command.withSharedFlags({ json: jsonFlag, stateDirectory: stateDirectoryFlag }),
  Command.withDescription(
    "Manage source-owned resources, including skills, commands, context, docs, and scripts. Register sources, select resources for coding agents, attach docs to projects, and run declared scripts. Human output is the default; pass --json for the version 1 machine envelope. Append --help to any command path for its flags and examples.",
  ),
);
