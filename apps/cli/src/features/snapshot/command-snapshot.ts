import { Context, Effect, type FileSystem, Option, type Path } from "effect";
import { readState, type StateOptions } from "../../services/state-store.ts";
import { type State } from "../../domain/state/state-schema.ts";
import { resolveCatalogFromInspections, type Catalog } from "../sources/catalog.ts";
import { inspectSourcesFromState } from "../sources/source.ts";
import { inspectProjectsFromState } from "../projects/project.ts";

type SourceInspections = ReturnType<typeof inspectSourcesFromState>;

/**
 * One state document as a command decoded it, with what is derived from it. Each derived value is
 * computed on first use and shared afterwards, so a command resolves the catalog at most once for
 * the document it observes. A snapshot lives for one invocation and is never written.
 */
export type CommandSnapshot = {
  readonly state: State;
  /** Every registered and built-in source, inspected once. */
  readonly sourceInspections: Effect.Effect<
    Effect.Success<SourceInspections>,
    Effect.Error<SourceInspections>,
    Effect.Services<SourceInspections>
  >;
  /** The resolved catalog, built once from `sourceInspections`. */
  readonly catalog: Effect.Effect<
    Catalog,
    Effect.Error<SourceInspections>,
    Effect.Services<SourceInspections> | FileSystem.FileSystem | Path.Path
  >;
  /** The registered projects and their roots, inspected once. */
  readonly projectInspections: ReturnType<typeof inspectProjectsFromState>;
};

/**
 * Snapshots `state`. The registered sources are the only part of the document the catalog depends
 * on, so a snapshot of a document with the same sources as `previous` shares its source
 * inspection and catalog instead of resolving them again.
 */
export const makeCommandSnapshot = Effect.fnUntraced(function* (
  state: State,
  previous?: CommandSnapshot,
) {
  const projectInspections = yield* Effect.cached(inspectProjectsFromState(state));
  if (previous !== undefined && previous.state.data.sources === state.data.sources)
    return {
      state,
      sourceInspections: previous.sourceInspections,
      catalog: previous.catalog,
      projectInspections,
    } satisfies CommandSnapshot;
  const sourceInspections = yield* Effect.cached(inspectSourcesFromState(state));
  const catalog = yield* Effect.cached(
    sourceInspections.pipe(Effect.flatMap(resolveCatalogFromInspections)),
  );
  return { state, sourceInspections, catalog, projectInspections } satisfies CommandSnapshot;
});

/**
 * Holds the running invocation's snapshot so a command and the host's rendering share one decoded
 * document and one catalog. A write to the state document makes the held snapshot stale; a stale
 * snapshot is never returned as current, only offered for its catalog when the sources still match.
 */
export type SnapshotCell = {
  /** The held snapshot, unless a write has outdated it. */
  readonly fresh: () => CommandSnapshot | undefined;
  /** The last held snapshot, current or not. */
  readonly last: () => CommandSnapshot | undefined;
  readonly hold: (snapshot: CommandSnapshot) => void;
  /** Marks the held snapshot as outdated by a write. */
  readonly invalidate: () => void;
};

/** Builds the empty snapshot cell of one invocation. */
export const makeSnapshotCell = (): SnapshotCell => {
  let held: CommandSnapshot | undefined;
  let stale = false;
  return {
    fresh: () => (stale ? undefined : held),
    last: () => held,
    hold: (snapshot) => {
      held = snapshot;
      stale = false;
    },
    invalidate: () => {
      stale = true;
    },
  };
};

/**
 * The cell of the running invocation, provided by the host. Code that runs without a host, such as
 * a unit test, finds none and works from a fresh snapshot each time.
 */
export class InvocationSnapshot extends Context.Service<InvocationSnapshot, SnapshotCell>()(
  "tack/cli/features/InvocationSnapshot",
) {}

/**
 * The invocation's snapshot of the state document, read without the writer lock on first use.
 * Later calls in the same invocation share it until a write outdates it.
 */
export const readInvocationSnapshot = Effect.fnUntraced(function* (stateOptions: StateOptions) {
  const cell = yield* Effect.serviceOption(InvocationSnapshot);
  const existing = Option.isNone(cell) ? undefined : cell.value.fresh();
  if (existing !== undefined) return existing;
  const snapshot = yield* makeCommandSnapshot(
    yield* readState(stateOptions),
    Option.isNone(cell) ? undefined : cell.value.last(),
  );
  if (Option.isSome(cell)) cell.value.hold(snapshot);
  return snapshot;
});

/**
 * Snapshots the document a writer session holds, sharing the catalog with the invocation's last
 * snapshot when the registered sources did not change.
 */
export const writerInvocationSnapshot = Effect.fnUntraced(function* (state: State) {
  const cell = yield* Effect.serviceOption(InvocationSnapshot);
  const snapshot = yield* makeCommandSnapshot(
    state,
    Option.isNone(cell) ? undefined : cell.value.last(),
  );
  if (Option.isSome(cell)) cell.value.hold(snapshot);
  return snapshot;
});

/** The catalog of the invocation's snapshot, resolved at most once per document. */
export const resolveInvocationCatalog = Effect.fnUntraced(function* (stateOptions: StateOptions) {
  return yield* (yield* readInvocationSnapshot(stateOptions)).catalog;
});
