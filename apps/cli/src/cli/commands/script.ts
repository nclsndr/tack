import { Effect, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { historyListBounds, isHistoryRunId } from "../../domain/execution/execution-schema.ts";
import { listAlias } from "./list-alias.ts";
import { booleanFlag, optionalIntegerFlag, optionalStringFlag } from "./flag-utils.ts";
import { handle, receive } from "./invocation-receiver.ts";
import { applyFlag } from "./operation-contract.ts";
import { cwdFlag, projectFlag, selectorOf, userFlag } from "./target-selector.ts";

const scriptRun = Command.make(
  "run",
  {
    reference: Argument.String("reference").pipe(
      Argument.withDescription("Declared script name, optionally qualified by source"),
    ),
    cwd: cwdFlag,
    root: optionalStringFlag("root", "Run in this registered project root"),
    projectName: projectFlag,
    user: userFlag,
    inputJson: optionalStringFlag("input-json", "Read the run input from this JSON text"),
    inputFile: optionalStringFlag("input-file", "Read the run input from this JSON file"),
    inputStdin: booleanFlag("input-stdin", "Read the run input from standard input"),
    quiet: booleanFlag("quiet", "Capture logs without mirroring them to standard error"),
    timeoutMs: optionalStringFlag(
      "timeout",
      "Interrupt the run after this many milliseconds; a positive integer",
    ),
    words: Argument.String("arguments").pipe(
      Argument.withDescription("The script's own arguments, after --, such as -- --name Ada"),
      Argument.variadic(),
    ),
  },
  handle(
    "script-run",
    Effect.fnUntraced(function* ({
      reference,
      cwd,
      root,
      projectName,
      user,
      inputJson,
      inputFile,
      inputStdin,
      quiet,
      timeoutMs,
      words,
    }) {
      yield* Effect.void;
      const targetCount =
        Number(user) + Number(projectName !== undefined) + Number(root !== undefined);
      return {
        _tag: "script-run",
        reference,
        request: {
          selector: selectorOf({ projectName, user }),
          ...(targetCount > 1 ? { targetConflict: true } : {}),
          ...(cwd === undefined ? {} : { cwd }),
          ...(root === undefined ? {} : { root }),
          ...(inputJson === undefined ? {} : { inputJson }),
          ...(inputFile === undefined ? {} : { inputFile }),
          ...(timeoutMs === undefined ? {} : { timeoutMs: Number(timeoutMs) }),
          ...(words.length === 0 ? {} : { words }),
          inputStdin,
          quiet,
        },
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Run one declared script against exactly one target: --user, --project, --root, or the deepest registered root containing --cwd",
  ),
  Command.withExamples([
    { command: "tack script run report --project demo" },
    { command: "tack script run report --project demo -- --repo nclsndr/tack --limit 5" },
    { command: "tack script run brain:nested-report --root /path/to/worktree --quiet" },
    { command: "tack script run report --user --input-stdin --timeout 30000" },
  ]),
);

const scriptShow = Command.make(
  "show",
  {
    reference: Argument.String("reference").pipe(
      Argument.withDescription("Declared script name, optionally qualified by source"),
    ),
  },
  ({ reference }) => receive({ _tag: "script-show", reference }),
).pipe(
  Command.withDescription(
    "Show one declared script: its description, file, arguments and secrets. Tack loads the script to read them but never runs it",
  ),
  Command.withExamples([{ command: "tack script show report" }]),
);

const historyIntegerFlag = (
  name: string,
  bounds: { readonly minimum: number; readonly maximum: number },
  fallback: number,
  description: string,
) => optionalIntegerFlag(name, bounds, description).pipe(Flag.map((value) => value ?? fallback));

const historyFlags = {
  limit: historyIntegerFlag(
    "limit",
    { minimum: 1, maximum: historyListBounds.maximumLimit },
    historyListBounds.defaultLimit,
    `Return at most this many newest runs; defaults to ${historyListBounds.defaultLimit}, at most ${historyListBounds.maximumLimit}`,
  ),
  offset: historyIntegerFlag(
    "offset",
    { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    0,
    "Skip this many newest runs; defaults to 0",
  ),
};

const listHistory = ({ limit, offset }: Command.Command.Config.Infer<typeof historyFlags>) =>
  receive({ _tag: "script-history-list", limit, offset });

const historyRoot = Command.make("history", historyFlags, listHistory);

/** Retained run inspection and explicitly applied clearing commands. */
const historyCommand = historyRoot.pipe(
  Command.withSubcommands([
    listAlias(historyFlags, listHistory),
    Command.make(
      "show",
      {
        runId: Argument.String("run-id").pipe(
          Argument.withSchema(Schema.String.check(Schema.makeFilter(isHistoryRunId))),
          Argument.withDescription("Run ID from script run or script history"),
        ),
      },
      ({ runId }) => receive({ _tag: "script-history-show", runId }),
    ).pipe(
      Command.withDescription("Show one retained run record, including pending records"),
      Command.withExamples([
        { command: "tack script history show 00000000-0000-4000-8000-000000000001" },
      ]),
    ),
    Command.make("clear", { apply: applyFlag }, ({ apply }) =>
      receive({ _tag: "script-history-clear", apply }),
    ).pipe(
      Command.withDescription(
        "Preview how many retained run records would be deleted; --apply deletes them",
      ),
      Command.withExamples([
        { command: "tack script history clear" },
        { command: "tack script history clear --apply" },
      ]),
    ),
  ]),
  Command.withDescription("Inspect and clear retained script run history"),
  Command.withExamples([{ command: "tack script history --limit 50 --offset 20" }]),
);

/** Script execution and retained history. */
export const scriptCommand = Command.make("script").pipe(
  Command.withSubcommands([scriptRun, scriptShow, historyCommand]),
  Command.withDescription(
    "Run trusted scripts and inspect their retained history; `catalog --kind script` lists scripts",
  ),
);
