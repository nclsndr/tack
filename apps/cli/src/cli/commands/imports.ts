import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { booleanFlag, optionalStringFlag } from "./flag-utils.ts";
import { handle, invalid, receive } from "./invocation-receiver.ts";
import { applyFlag, previewApply, readOnly } from "./operation-contract.ts";
import { exampleLocation, locationHelpText } from "../../domain/imports/providers/registry.ts";

const example = exampleLocation();

const locationArgument = Argument.String("location").pipe(
  Argument.withDescription(locationHelpText()),
);

const importAddCommand = Command.make(
  "add",
  {
    location: locationArgument,
    into: optionalStringFlag(
      "into",
      "The registered source that receives the skills, SOURCE or SOURCE:FOLDER; required with --apply",
    ),
    // `Flag.optional` keeps the repeatable flag documented as optional.
    skills: Flag.optional(Flag.String("skill").pipe(Flag.atLeast(0))).pipe(
      // Coverage skip: Flag.atLeast(0) always yields a list, so the empty fallback never runs.
      /* v8 ignore next -- @preserve */
      Flag.map((values) => Option.getOrElse(values, () => [])),
      Flag.withDescription("Import this skill by name; repeat for several"),
    ),
    all: booleanFlag("all", "Import every importable skill in the location"),
    fullDepth: booleanFlag("full-depth", "Search every folder up to five levels deep"),
    apply: applyFlag,
  },
  handle(
    "import-add",
    Effect.fnUntraced(function* ({ location, into, skills, all, fullDepth, apply }) {
      if (all && skills.length > 0)
        return yield* invalid("invalid-flag", "--all cannot be used with --skill.");
      return {
        _tag: "import-add",
        location,
        ...(into === undefined ? {} : { into }),
        skills,
        all,
        fullDepth,
        apply,
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Preview a remote location and copy chosen skills into a declared skills folder of a source you own; --apply requires --into, writes the folder and an imports record in the source's tack.yaml, and delivers nothing until sync",
  ),
  Command.withExamples([
    { command: `tack import add ${example}`, description: "List what the location offers" },
    {
      command: `tack import add ${example} --skill pdf --into my-skills`,
      description: "Preview the copy and where it will be delivered",
    },
    { command: `tack import add ${example} --skill pdf --into my-skills --apply` },
    {
      command: `tack import add ${example} --all --into my-skills:vendor/skills --apply`,
      description: "Use a named declared skills folder",
    },
  ]),
  previewApply,
);

const importRemoveCommand = Command.make(
  "remove",
  {
    reference: Argument.String("reference").pipe(
      Argument.withDescription("An imported skill: name or source:name"),
    ),
    force: booleanFlag("force", "Delete the folder even when it has local changes"),
    apply: applyFlag,
  },
  ({ reference, force, apply }) => receive({ _tag: "import-remove", reference, force, apply }),
).pipe(
  Command.withDescription(
    "Preview deleting an imported skill's folder and its imports record; --apply deletes them, and a locally changed folder needs --force. Offline",
  ),
  Command.withExamples([
    { command: "tack import remove my-skills:pdf" },
    { command: "tack import remove my-skills:pdf --apply" },
  ]),
  previewApply,
);

const importCommand = Command.make("import", {}, () => receive({ _tag: "import-list" })).pipe(
  Command.withSubcommands([importAddCommand, importRemoveCommand]),
  Command.withDescription(
    "Copy skills from a remote location into a source you own; bare `import` lists the imported skills of every registered source, offline",
  ),
  Command.withExamples([{ command: "tack import" }]),
  readOnly,
);

/** Commands that copy remote skills into a source. */
export const importCommands = [importCommand] as const;
