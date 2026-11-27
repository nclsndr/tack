import { Effect, Exit, FileSystem, Path, Predicate, Schema, Stdio, Stream } from "effect";
import { agentsFoundIn } from "../../features/setup/machine-init.ts";
import { commandLine } from "../envelope/command-line.ts";
import {
  commandNameOf,
  isCommandName,
  type Invocation,
  parseInvocation,
  unknownCommandName,
} from "../commands/index.ts";
import { hostStateOptions } from "./host-state-options.ts";
import { InvocationSnapshot, makeSnapshotCell } from "../../features/snapshot/command-snapshot.ts";
import { loadReferenceIndex } from "../human/reference-index.ts";
import { nextCommandsOf, renderHuman } from "../human/render.ts";
import { withCheckoutHint } from "../../features/projects/checkout.ts";
import { readInvocationSnapshot } from "../../features/snapshot/command-snapshot.ts";
import { makeStyle, type Style } from "../human/style.ts";
import type { ReferenceIndex } from "../../features/sources/resource-reference.ts";
import {
  colorEnabled,
  jsonRequestInArguments,
  resolveOutputFormat,
  TerminalContext,
  type OutputFormat,
  type TerminalContextShape,
} from "../human/terminal-context.ts";
import {
  makeStateNoticeCollector,
  stateAutoInitializes,
  type StateNotices,
  type StateObserver,
  type StateOptions,
} from "../../services/state-store.ts";
import { reportInternalCause, withDebugRerun } from "./debug-cause.ts";
import { HostConfigurationError, outcomeForError } from "../envelope/errors.ts";
import {
  createPublicEnvelope,
  envelopeFromExit,
  exitCodeForEnvelope,
  PublicEnvelopeSchema,
  renderPublicEnvelope,
  type PublicEnvelope,
} from "../envelope/public-outcome.ts";
import { PublicExit, type Route, routes } from "../routes/index.ts";

const redactedCommandName = (candidate: unknown) =>
  Predicate.isObject(candidate) && isCommandName(candidate["command"])
    ? candidate["command"]
    : unknownCommandName;

/**
 * Validates the public boundary before output and redacts malformed host values. A redacted
 * envelope keeps the candidate's command name only when it names a known operation.
 */
export const validatePublicEnvelope = (candidate: unknown) =>
  Schema.decodeUnknownEffect(PublicEnvelopeSchema)(candidate).pipe(
    Effect.catch(() =>
      Effect.succeed(
        createPublicEnvelope(redactedCommandName(candidate), {
          classification: "internal",
          diagnostics: [
            {
              code: "internal-error",
              message: "An unexpected internal error occurred.",
              severity: "error",
            },
          ],
        }),
      ),
    ),
  );

/** Reads the route for one tag while keeping the route's invocation type tied to that tag. */
const routeFor = <K extends Invocation["_tag"]>(
  tag: K,
): Route<Extract<Invocation, { readonly _tag: K }>> => routes[tag];

const resolveStateOptions = Effect.fnUntraced(function* (
  route: Route<Invocation>,
  invocation: Invocation,
  stateDirectory: string | undefined,
  observer: StateObserver,
) {
  const options = yield* hostStateOptions(
    stateDirectory,
    typeof route.needsHome === "function" ? route.needsHome(invocation) : route.needsHome,
  );
  const home = options.homeDirectory;
  if (home === undefined || stateAutoInitializes(options) === false)
    return { ...options, observer } satisfies StateOptions;
  // A state the first mutation initializes enables the agents found in the home, as init does.
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const initialAdapters = agentsFoundIn(home).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
  return { ...options, observer, initialAdapters } satisfies StateOptions;
});

/** The notice of a state this invocation initialized, naming the agents it enabled. */
const stateInitializedNotice = ({
  stateDirectory,
  enabledAdapters,
}: NonNullable<StateNotices["initialized"]>) => ({
  code: "state-initialized",
  severity: "info" as const,
  message:
    enabledAdapters === undefined
      ? `Initialized Tack state at ${stateDirectory}.`
      : enabledAdapters.length === 0
        ? `Initialized Tack state at ${stateDirectory}. No agent folder was found in this home, so no agent is enabled: run \`${commandLine("init")} --adapter <adapter>\` to enable one.`
        : `Initialized Tack state at ${stateDirectory} and enabled the agents found in this home: ${enabledAdapters.join(", ")}. \`${commandLine("init")}\` also links the built-in skills.`,
  details: {
    stateDirectory,
    ...(enabledAdapters === undefined ? {} : { enabledAdapters: [...enabledAdapters] }),
  },
});

type Output = {
  readonly format: OutputFormat;
  readonly terminal: TerminalContextShape;
  /** True under `--details`: views show every row they would otherwise cap. */
  readonly details: boolean;
  /** Where the invocation read its state; absent when it ran without state. */
  readonly stateOptions?: StateOptions;
};

const render = Effect.fnUntraced(function* (envelope: PublicEnvelope, output: Output) {
  const stdio = yield* Stdio.Stdio;
  const styleWith = (references: ReferenceIndex | undefined) =>
    makeStyle({
      color: output.format !== "json" && colorEnabled(output.terminal),
      homeDirectory: output.terminal.environment["HOME"],
      width: output.terminal.columns,
      ...(references === undefined ? {} : { references }),
    });
  const loadReferences = () =>
    output.stateOptions === undefined
      ? Effect.succeed(undefined)
      : loadReferenceIndex(envelope, output.stateOptions);
  if (output.format !== "json") {
    const text = renderHuman(envelope, styleWith(yield* loadReferences()), undefined, {
      details: output.details,
    });
    yield* Stream.succeed(text).pipe(Stream.run(stdio.stdout()));
    return;
  }
  // `next` lists the commands the text view would show. Reading the catalog for their labels
  // costs a state read, so it happens only when a command names a resource.
  const unlabeled = styleWith(undefined);
  let namesResource = false;
  const probe: Style = {
    ...unlabeled,
    reference: (address) => {
      namesResource = true;
      return unlabeled.reference(address);
    },
    source: (registrationId) => {
      namesResource = true;
      return unlabeled.source(registrationId);
    },
  };
  const firstTry = nextCommandsOf(envelope, probe);
  const next = namesResource
    ? nextCommandsOf(envelope, styleWith(yield* loadReferences()))
    : firstTry;
  const text = `${renderPublicEnvelope({ ...envelope, next })}\n`;
  yield* Stream.succeed(text).pipe(Stream.run(stdio.stdout()));
});

/** Runs one invocation through the shared host boundary. */
export const runCli = Effect.fnUntraced(function* () {
  // One snapshot cell and one notice collector serve the whole invocation: the command and the
  // rendering share one decoded document, and a write outdates it.
  const snapshotCell = makeSnapshotCell();
  const noticeCollector = makeStateNoticeCollector(snapshotCell.invalidate);
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      const args = yield* stdio.args;
      const terminal = yield* TerminalContext;
      let output: Output = {
        format: resolveOutputFormat(jsonRequestInArguments(args)).format,
        terminal,
        details: false,
      };
      const envelope = yield* parseInvocation(args).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.succeed(createPublicEnvelope(error.command, outcomeForError(error))),
          onSuccess: ({ invocation, stateDirectory }) =>
            Effect.scoped(
              Effect.gen(function* () {
                output = {
                  ...output,
                  details: "details" in invocation && invocation.details === true,
                };
                const tag = invocation._tag;
                const command = commandNameOf(tag);
                const route: Route<Invocation> = routeFor(tag);
                const stateOptions: Effect.Effect<
                  StateOptions,
                  HostConfigurationError,
                  FileSystem.FileSystem | Path.Path
                > =
                  route.stateless === true
                    ? Effect.succeed({})
                    : resolveStateOptions(route, invocation, stateDirectory, noticeCollector.sink);
                const operation = stateOptions.pipe(
                  Effect.tap((options) => {
                    if (route.stateless !== true) output = { ...output, stateOptions: options };
                    return Effect.void;
                  }),
                  Effect.flatMap((options) =>
                    route.run(invocation, options).pipe(
                      // A bare selection that found no root names what makes it selectable.
                      Effect.catchTag("TargetSelectionError", (error) =>
                        readInvocationSnapshot(options).pipe(
                          Effect.flatMap(({ state }) => withCheckoutHint(state, error)),
                          Effect.flatMap(Effect.fail),
                        ),
                      ),
                    ),
                  ),
                );
                const exit = yield* Effect.exit(
                  route.ownsInterruption === true ? operation : restore(operation),
                );
                if (Exit.isSuccess(exit) && "serve" in exit.value) {
                  yield* render(
                    yield* validatePublicEnvelope(
                      createPublicEnvelope(command, exit.value.outcome),
                    ),
                    output,
                  );
                  return yield* restore(exit.value.serve);
                }
                const routeEnvelope = envelopeFromExit(command, exit, {
                  onFailure: outcomeForError,
                  onSuccess: (value) => ("serve" in value ? value.outcome : value),
                });
                if (Exit.isFailure(exit) && routeEnvelope.classification === "internal")
                  yield* reportInternalCause(exit.cause);
                return routeEnvelope;
              }),
            ),
        }),
      );

      const { initialized } = noticeCollector.collected();
      const withNotices = {
        ...envelope,
        diagnostics: [
          ...envelope.diagnostics,
          ...(initialized === undefined ? [] : [stateInitializedNotice(initialized)]),
        ],
      };
      const validatedEnvelope = withDebugRerun(yield* validatePublicEnvelope(withNotices), args);
      yield* render(validatedEnvelope, output);
      const exitCode = exitCodeForEnvelope(validatedEnvelope);
      if (exitCode !== 0) {
        return yield* new PublicExit({ exitCode });
      }
      return undefined;
    }),
  ).pipe(Effect.provideService(InvocationSnapshot, snapshotCell));
});
