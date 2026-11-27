import { Context, type Effect, Option } from "effect";
import { Command } from "effect/cli";

/** Marks a subcommand as another spelling of its parent, which `schema` and help do not list. */
export class ListAliasAnnotation extends Context.Service<ListAliasAnnotation, true>()(
  "tack/cli/cli/commands/list-alias/ListAlias",
) {}

/**
 * Declares `list`, and its `ls` alias, as spellings of the executable parent that reads. The bare
 * parent stays the canonical form: the alias takes the parent's own flags and runs its own handler,
 * so the two cannot differ, and discovery publishes only the parent.
 *
 * @param config - The parent's own flags; `{}` when the parent has none or shares them.
 */
export const listAlias = <const Config extends Command.Command.Config, E, R>(
  config: Config,
  handler: (input: Command.Command.Config.Infer<Config>) => Effect.Effect<void, E, R>,
) =>
  Command.make("list", config, handler).pipe(
    Command.withAlias("ls"),
    Command.withDescription("The same as the bare parent command"),
    Command.annotate(ListAliasAnnotation, true),
  );

/** Reports whether a subcommand is a {@link listAlias}. */
export const isListAlias = (command: Command.Command.Any): boolean =>
  Option.isSome(Context.getOption(command.annotations, ListAliasAnnotation));
