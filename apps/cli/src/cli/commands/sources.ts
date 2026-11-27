import { Argument, Command, Flag } from "effect/cli";
import { ResourceKindSchema } from "../../domain/resources/kinds.ts";
import { listAlias } from "./list-alias.ts";
import { booleanFlag, cleanupDetailsFlag, optionalFlag, optionalStringFlag } from "./flag-utils.ts";
import { receive } from "./invocation-receiver.ts";
import { applyFlag } from "./operation-contract.ts";

/** Adds each catalog resource's complete authored frontmatter to `catalog`. */
const detailsFlag = booleanFlag("details", "Include each resource's complete authored frontmatter");

const sourcePathArgument = Argument.String("source-path").pipe(
  Argument.withDescription("Directory that contains the source's tack.yaml declaration"),
);

const catalogCommand = Command.make(
  "catalog",
  {
    details: detailsFlag,
    kind: optionalFlag(
      Flag.Literals("kind", ResourceKindSchema.literals),
      "Report only this resource kind and the issues that can concern it",
    ),
  },
  ({ details, kind }) =>
    receive({ _tag: "catalog", details, ...(kind === undefined ? {} : { kind }) }),
).pipe(
  Command.withDescription(
    "Resolve declared resources and issues; --details adds authored frontmatter and declaration paths; --kind narrows by kind. To browse and edit selections in an interactive terminal, run tack explore.",
  ),
  Command.withExamples([
    { command: "tack catalog" },
    { command: "tack catalog --details", description: "Include authored frontmatter" },
    { command: "tack catalog --kind script", description: "List declared scripts only" },
  ]),
);
const sourceAddCommand = Command.make(
  "add",
  {
    sourcePath: sourcePathArgument,
    config: optionalStringFlag(
      "config",
      "Declare the source in a new tack.yaml from this JSON declaration, or - to read it from standard input; tack guide tack-yaml lists every key",
    ),
    apply: applyFlag,
  },
  ({ sourcePath, apply, config }) =>
    receive({
      _tag: "source-add",
      sourcePath,
      apply,
      ...(config === undefined ? {} : { config }),
    }),
).pipe(
  Command.withDescription(
    "Preview registering a source: for a folder that has a tack.yaml, what it holds and the name it takes; --apply registers it. For a folder without one, give its declaration as JSON with --config '<json>', or --config - to read it from standard input: source add validates it as tack check would, previews the tack.yaml it would write and what each entry finds, and --apply writes it and registers the source. --config never writes over an existing tack.yaml.",
  ),
  Command.withExamples([
    {
      command: "tack source add /path/to/source",
      description: "Preview registering a source that has a tack.yaml",
    },
    { command: "tack source add /path/to/source --apply", description: "Register it" },
    {
      command: `tack source add ~/brain --config '{"version":1,"name":"brain","skills":[{"path":"skills"}]}'`,
      description: "Preview the tack.yaml a JSON declaration writes for a folder without one",
    },
    {
      command: `tack source add ~/brain --config '{"version":1,"name":"brain","skills":[{"path":"skills"}]}' --apply`,
      description: "Write the previewed tack.yaml and register the source",
    },
    {
      command: "tack source add ~/skills --config -",
      description:
        'Preview the declaration piped to standard input, such as {"version":1,"name":"skills","skills":[{"path":"."}]} for a folder of skills',
    },
  ]),
);
const sourceRelocateCommand = Command.make(
  "relocate",
  {
    registrationId: Argument.String("registration-id").pipe(
      Argument.withDescription("Registration ID returned by source add or source"),
    ),
    sourcePath: sourcePathArgument,
  },
  ({ registrationId, sourcePath }) =>
    receive({ _tag: "source-relocate", registrationId, sourcePath }),
).pipe(
  Command.withDescription(
    "Point a registered source at a new directory, keeping its registration ID",
  ),
  Command.withExamples([
    {
      command: "tack source relocate 00000000-0000-4000-8000-000000000001 /path/to/moved-source",
    },
  ]),
);
const sourceRemoveCommand = Command.make(
  "remove",
  {
    source: Argument.String("source").pipe(
      Argument.withDescription(
        "Source label or registration ID; a source that is gone has only its ID",
      ),
    ),
    apply: applyFlag,
    details: cleanupDetailsFlag,
  },
  ({ source, apply, details }) => receive({ _tag: "source-remove", source, apply, details }),
).pipe(
  Command.withDescription(
    "Preview removing a registered source: every link and docs mount of its resources, its picks in every namespace, its docs attachments and the fixed profile applications it publishes; --apply removes them, then the registration. The source directory is never touched.",
  ),
  Command.withExamples([
    { command: "tack source remove brain" },
    { command: "tack source remove 00000000-0000-4000-8000-000000000001 --apply" },
  ]),
);
const sourceCommand = Command.make("source", {}, () => receive({ _tag: "source-list" })).pipe(
  Command.withSubcommands([
    sourceAddCommand,
    sourceRelocateCommand,
    sourceRemoveCommand,
    listAlias({}, () => receive({ _tag: "source-list" })),
  ]),
  Command.withDescription(
    "Register, relocate and remove sources; bare `source` inspects every registered source, its health and what each of its declarations contributes",
  ),
  Command.withExamples([{ command: "tack source" }]),
);

/** Commands owned by source registration and catalog discovery. */
export const sourceCommands = [sourceCommand, catalogCommand] as const;
