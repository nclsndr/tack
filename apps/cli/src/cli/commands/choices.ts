import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { selectableKinds } from "../../domain/resources/kinds.ts";
import { listAlias } from "./list-alias.ts";
import { optionalFlag } from "./flag-utils.ts";
import { handle } from "./invocation-receiver.ts";
import { immediate, readOnly } from "./operation-contract.ts";
import { namespaceFrom, projectFlag, userFlag } from "./target-selector.ts";

/** A single resource reference and a kind only when kinds share a name. */
const resourceAddress = {
  reference: Argument.String("reference").pipe(
    Argument.withDescription("Resource name or source:name"),
  ),
  kind: optionalFlag(Flag.Literals("kind", selectableKinds), "Narrow a name shared by kinds"),
};

/** The `pick` parent owns the namespace selector its subcommands share. */
const pickRoot = Command.make("pick").pipe(
  Command.withSharedFlags({ projectName: projectFlag, user: userFlag }),
);

const choiceSetCommand = (decision: "include" | "exclude") =>
  Command.make(
    decision,
    {
      ...resourceAddress,
    },
    handle(
      decision === "include" ? "choice-set" : "choice-exclude",
      Effect.fnUntraced(function* ({ kind, reference }) {
        const { projectName, user } = yield* pickRoot;
        const namespace = yield* namespaceFrom({ projectName, user }, true);
        return {
          _tag: decision === "include" ? "choice-set" : "choice-exclude",
          reference,
          ...(kind === undefined ? {} : { kind }),
          namespace,
        };
      }),
    ),
  ).pipe(
    Command.withDescription(
      "Persist one include or exclude choice in exactly one namespace: --project or --user; built-in skills are locked",
    ),
    Command.withExamples([{ command: `tack pick ${decision} review --project demo` }]),
    immediate,
  );
const choiceRemoveCommand = Command.make(
  "remove",
  resourceAddress,
  handle(
    "choice-remove",
    Effect.fnUntraced(function* ({ kind, reference }) {
      const { projectName, user } = yield* pickRoot;
      const namespace = yield* namespaceFrom({ projectName, user }, true);
      return {
        _tag: "choice-remove",
        reference,
        ...(kind === undefined ? {} : { kind }),
        namespace,
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Remove one persisted choice from exactly one namespace: --project or --user; built-in skills are locked",
  ),
  Command.withExamples([{ command: "tack pick remove review --user" }]),
  immediate,
);
const listPicks = handle(
  "pick-list",
  Effect.fnUntraced(function* ({
    projectName,
    user,
  }: {
    readonly projectName: string | undefined;
    readonly user: boolean;
  }) {
    const namespace = yield* namespaceFrom({ projectName, user }, false);
    return { _tag: "pick-list", ...(namespace === undefined ? {} : { namespace }) };
  }),
);

/** Lists persisted choices in every namespace, or only in `--project` or `--user`. */
export const pickCommand = pickRoot.pipe(
  Command.withHandler(listPicks),
  Command.withSubcommands([
    choiceSetCommand("include"),
    choiceSetCommand("exclude"),
    choiceRemoveCommand,
    listAlias(pickRoot.pipe(Effect.flatMap(listPicks))),
  ]),
  Command.withDescription(
    "List persisted choices in every namespace, or only in --project or --user; include, exclude and remove change them",
  ),
  Command.withExamples([{ command: "tack pick" }, { command: "tack pick --project demo" }]),
  readOnly,
);
