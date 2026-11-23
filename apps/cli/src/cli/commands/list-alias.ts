import { Context, type Effect, Option } from "effect";
import { Command } from "effect/cli";

/** Marks a subcommand as another spelling of its parent, which `schema` and help do not list. */
export class ListAliasAnnotation extends Context.Service<ListAliasAnnotation, true>()(
  "tack/cli/cli/commands/list-alias/ListAlias",
) {}

/**
 * Declares `list`, and its `ls` alias, as spellings of the executable parent that reads. The bare
 * parent stays the canonical form: the alias runs the parent's own handler, so the two cannot
 * differ, and discovery publishes only the parent.
 */
export const listAlias = <E, R>(run: Effect.Effect<void, E, R>) =>
  Command.make("list", {}, () => run).pipe(
    Command.withAlias("ls"),
    Command.withDescription("The same as the bare parent command"),
    Command.annotate(ListAliasAnnotation, true),
  );

/** Reports whether a subcommand is a {@link listAlias}. */
export const isListAlias = (command: Command.Command.Any): boolean =>
  Option.isSome(Context.getOption(command.annotations, ListAliasAnnotation));
