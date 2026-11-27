import { Effect, FileSystem, Path } from "effect";
import type { HandMadeEntry } from "../../domain/agents/hand-made-entry.ts";
import { resourceDirectory, type AgentLayoutTarget } from "../../domain/agents/agent-layout.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import type { AgentAdapterId } from "../../domain/agents/agent-adapter-schema.ts";
import type { LinkRecord } from "../../domain/links/link-record-schema.ts";
import type { DestinationObservation } from "../../domain/reconciliation/destination-observation-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";
import { observeDestination } from "../../services/destination.ts";

/** The folders an adapter links into at one target, each with the kind it receives. */
const agentFolders = (adapter: AgentAdapterId, target: AgentLayoutTarget) =>
  (["skill", "command"] as const).flatMap((kind) => {
    const folder = resourceDirectory(adapter, target, kind);
    return folder === undefined ? [] : [{ adapter, kind, folder }];
  });

/** What an observed entry is, or `undefined` when nothing is there. */
const entryTypeOf = (observation: DestinationObservation): HandMadeEntry["entry"] | undefined => {
  switch (observation._tag) {
    case "entry":
      return observation.entryType;
    case "absolute-link":
    case "relative-link":
      return "symlink";
    // Coverage skip: an entry removed between the listing and its observation, a link whose folder
    // cannot be resolved, or one the system refuses to read; none can be staged reliably.
    /* v8 ignore start -- @preserve */
    case "unresolved-relative-link":
      return "symlink";
    case "absent":
      return undefined;
    case "access-failed":
      return "unreadable";
    default: {
      const exhaustive: never = observation;
      return exhaustive;
    }
    /* v8 ignore stop -- @preserve */
  }
};

/**
 * The entries in the skill and command folders of `adapters` at `target` that no link record of
 * `links` names: the operator or another tool made them. Hidden entries, such as `.DS_Store`, are
 * left out, and a folder that is missing or cannot be listed holds none. It only reads.
 */
export const observeHandMadeEntries = Effect.fnUntraced(function* (
  links: ReadonlyArray<LinkRecord>,
  target: AgentLayoutTarget,
  adapters: ReadonlyArray<AgentAdapterId>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recorded = new Set(links.map((link) => link.destinationPath));
  const folders = adapters.flatMap((adapter) => agentFolders(adapter, target));
  const entries = yield* Effect.forEach(folders, ({ adapter, kind, folder }) =>
    fileSystem.readDirectory(folder).pipe(
      Effect.catch(() => Effect.succeed([] satisfies ReadonlyArray<string>)),
      Effect.map((names) =>
        names
          .filter((name) => name.startsWith(".") === false)
          .map((name) => path.join(folder, name))
          .filter((entryPath) => recorded.has(entryPath) === false),
      ),
      Effect.flatMap((paths) =>
        Effect.forEach(paths, (entryPath) =>
          observeDestination(entryPath).pipe(
            Effect.map((observation) => {
              const entry = entryTypeOf(observation);
              // Coverage skip: only an entry removed since the listing reads as absent.
              /* v8 ignore next -- @preserve */
              return entry === undefined
                ? []
                : [{ adapter, kind, path: entryPath, entry } satisfies HandMadeEntry];
            }),
          ),
        ),
      ),
      Effect.map((found) => found.flat()),
    ),
  );
  // Each adapter has folders of its own, so a path names one entry.
  return entries.flat().toSorted((left, right) => compareCodeUnits(left.path, right.path));
});

/**
 * The hand-made entries in the project skill and command folders of every root in `roots`, for the
 * adapters `state` enables, against the link records `state` holds. It only reads.
 */
export const observeRootHandMadeEntries = Effect.fnUntraced(function* (
  state: State,
  roots: ReadonlyArray<string>,
) {
  const found = yield* Effect.forEach(roots, (root) =>
    observeHandMadeEntries(
      state.data.links,
      { _tag: "project-root", canonicalPath: root },
      state.data.enabledAdapters,
    ),
  );
  return found.flat().toSorted((left, right) => compareCodeUnits(left.path, right.path));
});
