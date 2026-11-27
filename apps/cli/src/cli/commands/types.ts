import { Argument, Command } from "effect/cli";
import { receive } from "./invocation-receiver.ts";
import { applyFlag } from "./operation-contract.ts";

/** Editor types for a source's scripts, generated from the running Tack. */
export const typesCommand = Command.make(
  "types",
  {
    path: Argument.String("path").pipe(
      Argument.withDescription(
        "Source folder that holds tack.yaml; defaults to the current folder",
      ),
      Argument.optional,
    ),
    apply: applyFlag,
  },
  ({ path, apply }) =>
    receive({
      _tag: "types",
      ...(path._tag === "Some" ? { path: path.value } : {}),
      apply,
    }),
).pipe(
  Command.withDescription(
    "Preview writing tack-env.d.ts, the types of the script API this Tack provides, and a tsconfig.json when the source has none; --apply writes them. Commit both, and rerun after upgrading Tack",
  ),
  Command.withExamples([
    { command: "tack types /sources/tools" },
    { command: "tack types --apply" },
  ]),
);
