import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { listAlias } from "./list-alias.ts";
import { booleanFlag, cleanupDetailsFlag, optionalStringFlag } from "./flag-utils.ts";
import { handle, invalid, receive } from "./invocation-receiver.ts";
import { applyFlag, immediate, previewApply, readOnly } from "./operation-contract.ts";
import { cwdFlag, projectFlag } from "./target-selector.ts";

const repositoryCwdFlag = optionalStringFlag(
  "repository-cwd",
  "Register the repository at this directory instead of the current directory",
);
const projectAddCommand = Command.make(
  "add",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription("Project name used by --project selectors"),
    ),
    repositoryCwd: repositoryCwdFlag,
  },
  ({ name, repositoryCwd }) =>
    receive({
      _tag: "project-add",
      name,
      ...(repositoryCwd === undefined ? {} : { repositoryCwd }),
    }),
).pipe(
  Command.withDescription(
    "Register the Git repository at the current directory, with its anchor and every non-bare worktree root",
  ),
  Command.withExamples([
    { command: "tack project add demo" },
    { command: "tack project add demo --repository-cwd /path/to/repository" },
  ]),
  immediate,
);
const projectRefreshCommand = Command.make(
  "refresh",
  {
    apply: applyFlag,
    projectName: projectFlag,
    all: booleanFlag("all", "Select every registered project"),
    cwd: cwdFlag,
    details: cleanupDetailsFlag,
  },
  handle(
    "project-refresh",
    Effect.fnUntraced(function* ({ apply, projectName, all, cwd, details }) {
      if (projectName !== undefined && all)
        return yield* invalid("invalid-selector", "--project and --all cannot be used together.");
      if (cwd !== undefined && (projectName !== undefined || all))
        return yield* invalid("invalid-selector", "--cwd can only be used with a bare selector.");
      return {
        _tag: "project-refresh",
        apply,
        details,
        ...(cwd === undefined ? {} : { cwd }),
        selector:
          projectName === undefined
            ? all
              ? { _tag: "all" as const }
              : { _tag: "bare" as const }
            : { _tag: "project" as const, projectName },
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Preview worktree root and docs mount changes for the containing project; --all selects every project; --apply writes them",
  ),
  Command.withExamples([
    { command: "tack project refresh" },
    { command: "tack project refresh --project demo --apply" },
  ]),
  previewApply,
);

const projectRemoveCommand = Command.make(
  "remove",
  {
    name: Argument.String("name").pipe(Argument.withDescription("Registered project name")),
    apply: applyFlag,
    details: cleanupDetailsFlag,
  },
  ({ name, apply, details }) => receive({ _tag: "project-remove", name, apply, details }),
).pipe(
  Command.withDescription(
    "Preview removing a whole project: every link and docs mount in its roots, its picks, docs settings and fixed profile application; --apply removes them, then the registration. The worktrees are never touched.",
  ),
  Command.withExamples([
    { command: "tack project remove demo" },
    { command: "tack project remove demo --apply" },
  ]),
  previewApply,
);

/** Commands owned by registered project lifecycles. */
export const projectCommand = Command.make("project", {}, () =>
  receive({ _tag: "project-list" }),
).pipe(
  Command.withSubcommands([
    projectAddCommand,
    projectRefreshCommand,
    projectRemoveCommand,
    listAlias(receive({ _tag: "project-list" })),
  ]),
  Command.withDescription(
    "Register, refresh and remove Git projects; bare `project` inspects every registered project, its roots and its health",
  ),
  Command.withExamples([{ command: "tack project" }]),
  readOnly,
);
