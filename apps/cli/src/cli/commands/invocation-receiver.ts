import { Context, Effect } from "effect";
import type { Command } from "effect/unstable/cli";
import {
  commandNameOf,
  InvocationError,
  invocationErrorCodes,
  InvocationIssue,
  type Invocation,
  type ParsedInvocation,
} from "./model.ts";
import { rootCommand } from "./root-command.ts";

type InvocationOf<Tag extends Invocation["_tag"]> = Extract<Invocation, { readonly _tag: Tag }>;
type InvocationReceiverService = {
  readonly receive: (parsed: ParsedInvocation) => Effect.Effect<void>;
};

/** Receives one parsed invocation without coupling command declarations to the host. */
export class InvocationReceiver extends Context.Service<
  InvocationReceiver,
  InvocationReceiverService
>()("tack/cli/commands/InvocationReceiver") {}

/** Constructs a typed command-transport failure for the enclosing {@link handle} to attribute. */
export const invalid = (code: (typeof invocationErrorCodes)[number], message: string) =>
  Effect.fail(new InvocationIssue({ code, message }));

/**
 * Sends one command-family request, beside the root transport settings, to the parser receiver.
 * Handlers that validate their input use {@link handle} instead, so failures keep the command name.
 */
export const receive = Effect.fnUntraced(function* (
  invocation: Invocation,
): Effect.fn.Return<void, never, InvocationReceiver | Command.CommandContext<"tack">> {
  const { stateDirectory } = yield* rootCommand;
  const receiver = yield* InvocationReceiver;
  yield* receiver.receive({
    invocation,
    ...(stateDirectory === undefined ? {} : { stateDirectory }),
  });
});

/**
 * Declares the handler of the leaf command that produces `tag`: it receives the invocation `build`
 * returns, and attributes every transport issue raised while building it to that command's name.
 */
export const handle =
  <const Tag extends Invocation["_tag"], Input, R>(
    tag: Tag,
    build: (input: Input) => Effect.Effect<InvocationOf<Tag>, InvocationIssue, R>,
  ) =>
  (input: Input) =>
    build(input).pipe(
      Effect.mapError(
        (issue) =>
          new InvocationError({
            code: issue.code,
            command: commandNameOf(tag),
            message: issue.message,
          }),
      ),
      Effect.flatMap(receive),
    );
