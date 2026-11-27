import { Effect, Schema } from "effect";
import { InvocationError } from "../../commands/index.ts";
import type { Namespace } from "../../../domain/choices/choice-schema.ts";
import { makeExplorerEditor, loadExplorer } from "../human/explorer/editor.ts";
import { initialExplorerState } from "../human/explorer/model.ts";
import { makeExplorerDestinations } from "../human/explorer/profile-editor.ts";
import { runExplorer } from "../human/explorer/session.ts";
import { referencesOf } from "../human/catalog.ts";
import { makeStyle, withReferences } from "../human/style.ts";
import { colorEnabled, interactiveAllowed, TerminalContext } from "../human/terminal-context.ts";
import type { StateOptions } from "../../../services/state-store.ts";
import { resultAs } from "../outcomes.ts";
import { resolveContainingRoot } from "../../../features/projects/project.ts";
import { readInvocationSnapshot } from "../../../features/snapshot/command-snapshot.ts";
import { cwdOrCurrent, type RouteServices, type RoutesFor } from "./route.ts";
/** Marks Ctrl+C after the session has restored the terminal. */
export class ExplorerInterruptedError extends Schema.TaggedError<ExplorerInterruptedError>()(
  "ExplorerInterruptedError",
  {
    code: Schema.Literal("interrupted"),
    message: Schema.String,
  },
) {}

/** The project whose registered root contains the working directory, if one does. */
const containingProject = Effect.fnUntraced(function* (stateOptions: StateOptions, cwd: string) {
  const { state } = yield* readInvocationSnapshot(stateOptions);
  const { containing } = yield* resolveContainingRoot(state, cwd);
  return containing === undefined
    ? undefined
    : ({ _tag: "project", projectName: containing.projectName } satisfies Namespace);
});

/**
 * The explorer, available only to an operator at an interactive terminal. It opens `destination`,
 * or else the project that contains `cwd`, and stages choices and docs attachments for it. With
 * neither, it opens on the destination chooser and only reads until one is chosen.
 */
export const exploreSelection = Effect.fn("explore.exploreSelection")(function* (
  stateOptions: StateOptions,
  options: { readonly destination?: Namespace; readonly cwd: string },
) {
  const terminal = yield* TerminalContext;
  if (!interactiveAllowed(terminal))
    return yield* new InvocationError({
      code: "terminal-required",
      command: "explore",
      message:
        "tack explore requires an interactive terminal. Agents should use tack catalog, tack pick or tack status.",
    });
  const plain = makeStyle({
    color: colorEnabled(terminal),
    homeDirectory: terminal.environment["HOME"],
    width: terminal.columns,
  });
  const edit = options.destination ?? (yield* containingProject(stateOptions, options.cwd));
  const { report, entries, fixedBy } = yield* loadExplorer(stateOptions, plain, edit);
  // Every screen names a resource by its shortest reference in the catalog it browses.
  const style = withReferences(plain, referencesOf(report));
  const heading = `Tack explorer  ${report.resources.length} resources · ${report.issues.length} issues`;
  const context = yield* Effect.context<RouteServices>();
  const destinations = yield* makeExplorerDestinations({
    stateOptions,
    style,
    cwd: options.cwd,
    context,
  });
  const editor =
    edit === undefined
      ? undefined
      : makeExplorerEditor({ stateOptions, namespace: edit, style, cwd: options.cwd, context });
  const session = yield* runExplorer(
    {
      ...initialExplorerState(heading, entries, edit, fixedBy),
      destinations: destinations.options,
      // Without a destination the window opens on the chooser; Esc keeps it read-only.
      ...(edit === undefined ? { destinationMenu: { phase: "choose", cursor: 0 } } : {}),
    },
    style,
    undefined,
    editor,
    destinations,
  );
  if (session.interrupted)
    return yield* new ExplorerInterruptedError({
      code: "interrupted",
      message: "The command was interrupted.",
    });
  return resultAs("explore")({});
});

/** The interactive explorer; every session can choose the user destination inside the window. */
export const exploreRoutes: RoutesFor<"explore"> = {
  explore: {
    needsHome: true,
    run: (invocation, stateOptions) =>
      cwdOrCurrent(undefined).pipe(
        Effect.flatMap((cwd) =>
          exploreSelection(stateOptions, {
            cwd,
            ...(invocation.destination === undefined
              ? {}
              : { destination: invocation.destination }),
          }),
        ),
      ),
  },
};
