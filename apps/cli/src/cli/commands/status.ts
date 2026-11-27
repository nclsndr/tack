import { Effect } from "effect";
import { Command } from "effect/cli";
import { booleanFlag } from "./flag-utils.ts";
import { helpNotes } from "./help-notes.ts";
import { handle } from "./invocation-receiver.ts";
import { allFlag, cwdFlag, projectFlag, selectorFrom, userFlag } from "./target-selector.ts";

/** `status`: read-only health of the links, sources and pending removals of a scope. */
export const statusCommand = Command.make(
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
);
