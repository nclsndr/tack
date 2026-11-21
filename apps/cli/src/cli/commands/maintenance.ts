import { Effect } from "effect";
import { Command } from "effect/cli";
import { booleanFlag } from "./flag-utils.ts";
import { helpNotes } from "./help-notes.ts";
import { handle, receive } from "./invocation-receiver.ts";
import { applyFlag, immediate, previewApply, readOnly } from "./operation-contract.ts";
import { allFlag, cwdFlag, projectFlag, selectorFrom, userFlag } from "./target-selector.ts";

const statusCommand = Command.make(
  "status",
  {
    cwd: cwdFlag,
    all: allFlag,
    includeOptional: booleanFlag(
      "include-optional",
      "Include optional dependencies, as sync --include-optional does",
    ),
    details: booleanFlag("details", "Expand all human status rows"),
    projectName: projectFlag,
    user: userFlag,
  },
  handle(
    "status",
    Effect.fnUntraced(function* ({ cwd, all, includeOptional, details, projectName, user }) {
      return {
        _tag: "status",
        ...(cwd === undefined ? {} : { cwd }),
        includeOptional,
        details,
        selector: yield* selectorFrom({ projectName, user, all, cwd }),
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Inspect source, project, selection, destination and pending-removal health. Bare selects the containing project; --all selects every project and the user target.",
  ),
  Command.withExamples([
    { command: "tack status" },
    { command: "tack status --project demo" },
    { command: "tack status --user" },
  ]),
  helpNotes([
    {
      title: "Link states",
      rows: [
        { term: "linked", text: "healthy: the link is where Tack recorded it" },
        {
          term: "missing, gone, drifted",
          text: "run `tack sync` to preview the repair, then `tack sync --apply`",
        },
        {
          term: "changed",
          text: "changed outside Tack and no longer selected; `tack sync --apply` forgets the record and leaves the link as it is",
        },
        {
          term: "hand-made",
          text: "a file or folder that was there before Tack linked; Tack keeps it and does not link its resource there. Run `tack pick exclude <source>:<name>` to keep yours on purpose, or move it, then sync",
        },
        {
          term: "foreign",
          text: "a file or folder Tack does not own replaced a link Tack recorded; Tack never overwrites it, so move it, then sync",
        },
        {
          term: "conflict",
          text: "two selected resources need the same path; run `tack pick exclude <source>:<name>` for the one you do not want, then sync",
        },
        {
          term: "no target, unreadable",
          text: "the target directory is missing or unreadable; run `tack doctor` for the cause",
        },
      ],
    },
    {
      title: "Exit status",
      rows: [
        { term: "0", text: "every link is linked and no problem was found" },
        { term: "1", text: "something needs attention: the classification is `partial`" },
      ],
    },
  ]),
  readOnly,
);
const cleanCommand = Command.make(
  "clean",
  {
    apply: applyFlag,
    pending: booleanFlag("pending", "Retry pending removals and removing roots only"),
    cwd: cwdFlag,
    all: allFlag,
    projectName: projectFlag,
    user: userFlag,
  },
  handle(
    "clean",
    Effect.fnUntraced(function* ({ apply, pending, cwd, all, projectName, user }) {
      return {
        _tag: pending ? "retry" : "clean",
        apply,
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
  previewApply,
);
const targetRule =
  "Bare selects the containing project; --all selects every project and the user target.";
const resetCommand = Command.make("reset", { apply: applyFlag }, ({ apply }) =>
  receive({ _tag: "reset", apply }),
).pipe(
  Command.withDescription(
    "Preview removing every managed link and all Tack state; --apply deletes state only after cleanup settles",
  ),
  Command.withExamples([{ command: "tack state reset" }, { command: "tack state reset --apply" }]),
  previewApply,
);

const initCommand = Command.make("init", {}, () => receive({ _tag: "init" })).pipe(
  Command.withDescription("Initialize Tack state explicitly; safe to repeat"),
  Command.withExamples([{ command: "tack state init" }]),
  immediate,
);

/** Explicit state setup, scoped cleanup, and full reset. */
const stateCommand = Command.make("state").pipe(
  Command.withDescription(`Initialize and clean Tack state. ${targetRule}`),
  Command.withSubcommands([initCommand, cleanCommand, resetCommand]),
);

/** Read-only status and maintenance command declarations. */
export const maintenanceCommands = [statusCommand, stateCommand] as const;
