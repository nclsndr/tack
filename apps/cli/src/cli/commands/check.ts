import { Argument, Command } from "effect/cli";
import { receive } from "./invocation-receiver.ts";

/** One stateless authoring loop for sources, profile files, content bundles and docs. */
export const checkCommand = Command.make(
  "check",
  {
    paths: Argument.String("path").pipe(
      Argument.variadic(),
      Argument.withDescription(
        "Source folder/tack.yaml, profile YAML, .tar.gz bundle, or Markdown docs; include companion source folders for cross-source profile linkage. Defaults to the current folder",
      ),
    ),
  },
  ({ paths }) => receive({ _tag: "check", paths: paths.length === 0 ? ["."] : paths }),
).pipe(
  Command.withDescription(
    "Detect and check each path, or the current folder when none is given, without state, registration, network or executing authored code. Sources include resources, dependency edges, profile definitions and docs figures. Pass companion source folders together. One file:line report; errors exit 1, warnings exit 0.",
  ),
  Command.withExamples([
    { command: "tack check" },
    { command: "tack check /sources/tools /sources/helpers" },
    {
      command:
        "tack check /sources/tools/profiles/ci.yaml /sources/helpers docs/architecture.mdx /artifacts/ci.tar.gz",
    },
  ]),
);
