import { Effect } from "effect";
import { Command } from "effect/cli";
import { booleanFlag, cleanupDetailsFlag } from "./flag-utils.ts";
import { handle, receive } from "./invocation-receiver.ts";
import { applyFlag } from "./operation-contract.ts";
import { allFlag, cwdFlag, projectFlag, selectorFrom, userFlag } from "./target-selector.ts";

const cleanCommand = Command.make(
  "clean",
  {
    apply: applyFlag,
    pending: booleanFlag("pending", "Retry pending removals and removing roots only"),
    cwd: cwdFlag,
    all: allFlag,
    projectName: projectFlag,
    user: userFlag,
    details: cleanupDetailsFlag,
  },
  handle(
    "state-clean",
    Effect.fnUntraced(function* ({ apply, pending, cwd, all, projectName, user, details }) {
      return {
        _tag: pending ? "state-clean-pending" : "state-clean",
        apply,
        details,
        ...(cwd === undefined ? {} : { cwd }),
        selector: yield* selectorFrom({ projectName, user, all, cwd }),
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Preview selected managed-link cleanup; --pending retries obligations only",
  ),
  Command.withExamples([
    { command: "tack state clean --project demo" },
    { command: "tack state clean --pending --user --apply" },
  ]),
);
const targetRule =
  "Bare selects the containing project; --all selects every project and the user target.";
const resetCommand = Command.make(
  "reset",
  { apply: applyFlag, details: cleanupDetailsFlag },
  ({ apply, details }) => receive({ _tag: "state-reset", apply, details }),
).pipe(
  Command.withDescription(
    "Preview removing every managed link and all Tack state; --apply deletes state only after cleanup settles",
  ),
  Command.withExamples([{ command: "tack state reset" }, { command: "tack state reset --apply" }]),
);

const initCommand = Command.make("init", {}, () => receive({ _tag: "state-init" })).pipe(
  Command.withDescription("Initialize Tack state explicitly; safe to repeat"),
  Command.withExamples([{ command: "tack state init" }]),
);

/** Explicit state setup, scoped cleanup, and full reset. */
export const stateCommand = Command.make("state").pipe(
  Command.withDescription(`Initialize and clean Tack state. ${targetRule}`),
  Command.withSubcommands([initCommand, cleanCommand, resetCommand]),
);
