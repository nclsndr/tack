import { Context, Effect, Schema } from "effect";
import type { State } from "../domain/state/state-schema.ts";
import type { AgentAdapterId } from "../domain/agents/agent-adapter-schema.ts";

/** Inputs that the application boundary resolves before operating on Tack state. */
export type StateOptions = {
  /**
   * The state directory that `--state-dir` or `TACK_STATE_DIR` named. Left out, state lives in
   * `.tack` under the operator home. An empty value is kept and refused when state is touched.
   */
  readonly stateDirectory?: string;
  /** The operator home, when known; it locates default state and the user target. */
  readonly homeDirectory?: string;
  /** Told what persisting during this invocation did; the host installs one per invocation. */
  readonly observer?: StateObserver;
  /**
   * The adapters a state that the first mutation initializes starts with: the agents found in the
   * operator home, as `tack init` finds them. Left out, the new state enables none.
   */
  readonly initialAdapters?: Effect.Effect<ReadonlyArray<AgentAdapterId>>;
};

/**
 * Whether the first mutation may initialize absent state: only the default state directory is
 * created on demand, so a mistyped explicit one is never.
 */
export const stateAutoInitializes = (options: StateOptions) => options.stateDirectory === undefined;

/** Reports an invalid effective-state configuration before filesystem access. */
export class StateConfigurationError extends Schema.TaggedError<StateConfigurationError>()(
  "StateConfigurationError",
  { message: Schema.String },
) {}

/** Reports that another process currently owns the state writer lock. */
export class StateBusyError extends Schema.TaggedError<StateBusyError>()("StateBusyError", {
  lockPath: Schema.String,
  ownerPid: Schema.optional(Schema.Number),
}) {}

/** Reports a state format written by a newer Tack release. */
export class StateFormatUnsupportedError extends Schema.TaggedError<StateFormatUnsupportedError>()(
  "StateFormatUnsupportedError",
  { foundFormat: Schema.Number, statePath: Schema.String },
) {}

/** Reports a state document that does not satisfy the supported schema. */
export class StateCorruptError extends Schema.TaggedError<StateCorruptError>()(
  "StateCorruptError",
  {
    message: Schema.String,
    statePath: Schema.String,
  },
) {}

/**
 * Reports a state-dependent operation before explicit initialization. `explicitDirectory` says
 * whether `--state-dir` or `TACK_STATE_DIR` named the directory, rather than the default one.
 */
export class StateNotInitializedError extends Schema.TaggedError<StateNotInitializedError>()(
  "StateNotInitializedError",
  { statePath: Schema.String, explicitDirectory: Schema.Boolean },
) {}

/** Reports a failed filesystem operation on Tack-owned state. */
export class StateStorageError extends Schema.TaggedError<StateStorageError>()(
  "StateStorageError",
  {
    message: Schema.String,
    operation: Schema.String,
    path: Schema.String,
  },
) {}

/** Reports a mutation that would produce invalid state without changing persisted data. */
export class StateMutationError extends Schema.TaggedError<StateMutationError>()(
  "StateMutationError",
  {
    message: Schema.String,
    statePath: Schema.String,
  },
) {}

/** How one invocation's state operations report what they persisted. */
export type StateObserver = {
  /** Called after every write that replaced, created or deleted the state document. */
  readonly wrote: () => void;
  /**
   * Records the state directory this invocation initialized by its first mutation, and the
   * adapters `StateOptions.initialAdapters` enabled in it, absent when the options named none.
   */
  readonly initialized: (
    stateDirectory: string,
    enabledAdapters?: ReadonlyArray<AgentAdapterId>,
  ) => void;
};

/** The notices one invocation collected, as values for its envelope. */
export type StateNotices = {
  readonly initialized?: {
    readonly stateDirectory: string;
    readonly enabledAdapters?: ReadonlyArray<AgentAdapterId>;
  };
};

/**
 * Collects the notices of one invocation and forwards its writes to `onWrite`. The host builds
 * one per invocation, passes its `sink` through `StateOptions` and reads `collected` once the
 * command ends.
 */
export const makeStateNoticeCollector = (onWrite: () => void = () => undefined) => {
  let initialized: StateNotices["initialized"];
  return {
    sink: {
      wrote: onWrite,
      initialized: (stateDirectory, enabledAdapters) => {
        initialized = {
          stateDirectory,
          ...(enabledAdapters === undefined ? {} : { enabledAdapters }),
        };
      },
    } satisfies StateObserver,
    collected: (): StateNotices => (initialized === undefined ? {} : { initialized }),
  };
};

export type StateMutation<A> = {
  readonly state: State;
  readonly value: A;
};

export type StatePersistenceError =
  | StateBusyError
  | StateConfigurationError
  | StateCorruptError
  | StateFormatUnsupportedError
  | StateMutationError
  | StateNotInitializedError
  | StateStorageError;

export type StateMutator<A, E, R> = (state: State) => Effect.Effect<StateMutation<A>, E, R>;

/**
 * A writer-scoped state view whose persistence services are owned by the state adapter.
 * The user callback retains only its own Effect requirements.
 */
export type StateCheckpointWriter = {
  readonly current: () => State;
  readonly checkpoint: <A, E, R>(
    mutate: StateMutator<A, E, R>,
  ) => Effect.Effect<A, E | StatePersistenceError, R>;
  readonly deleteState: () => Effect.Effect<void, StatePersistenceError>;
  readonly stateExists: () => boolean;
};

/** The `state init` payload: the state directory and whether it already held a state. */
export const StateInitializationPayloadSchema = Schema.Struct({
  kind: Schema.Literal("initialization"),
  alreadyInitialized: Schema.Boolean,
  stateDirectory: Schema.String,
});

/** What initializing the state reports. */
type StateInitialization = Omit<typeof StateInitializationPayloadSchema.Type, "kind">;

export type StateStoreService = {
  readonly initialize: (
    options: StateOptions,
  ) => Effect.Effect<
    StateInitialization,
    | StateBusyError
    | StateConfigurationError
    | StateCorruptError
    | StateFormatUnsupportedError
    | StateMutationError
    | StateStorageError
  >;
  readonly mutateEffect: <A, E, R>(
    options: StateOptions,
    mutate: StateMutator<A, E, R>,
  ) => Effect.Effect<A, E | StatePersistenceError, R>;
  readonly read: (
    options: StateOptions,
  ) => Effect.Effect<
    State,
    | StateConfigurationError
    | StateCorruptError
    | StateFormatUnsupportedError
    | StateNotInitializedError
    | StateStorageError
  >;
  readonly resolveDirectory: (
    options: StateOptions,
  ) => Effect.Effect<string, StateConfigurationError>;
  /**
   * Holds the writer lock for `use`. With `autoInitialize`, the default state directory is
   * created when absent and the first checkpoint initializes the state.
   */
  readonly withCheckpointWriter: <A, E, R>(
    options: StateOptions,
    use: (writer: StateCheckpointWriter) => Effect.Effect<A, E, R>,
    autoInitialize?: boolean,
  ) => Effect.Effect<A, E | StatePersistenceError, R>;
};

/** Exclusive, validated access to the versioned Tack state document. */
export class StateStore extends Context.Service<StateStore, StateStoreService>()(
  "tack/cli/services/state-store/StateStore",
) {}

export const resolveStateDirectory = Effect.fnUntraced(function* (options: StateOptions) {
  return yield* (yield* StateStore).resolveDirectory(options);
});

/** Creates the initial state and dotenv file through the state capability. */
export const initializeState = Effect.fn("state.initializeState")(function* (
  options: StateOptions,
) {
  return yield* (yield* StateStore).initialize(options);
});

/** Reads the complete validated state through the state capability. */
export const readState = Effect.fnUntraced(function* (options: StateOptions) {
  return yield* (yield* StateStore).read(options);
});

/** Runs a sequence of validated checkpoints under one exclusive state lock. */
export const withStateCheckpointWriter = Effect.fnUntraced(function* <A, E, R>(
  options: StateOptions,
  use: (writer: StateCheckpointWriter) => Effect.Effect<A, E, R>,
  autoInitialize = false,
) {
  return yield* (yield* StateStore).withCheckpointWriter(options, use, autoInitialize);
});

/** Runs an effectful validated state transition under the exclusive state lock. */
export const mutateState = Effect.fnUntraced(function* <A, E, R>(
  options: StateOptions,
  mutate: StateMutator<A, E, R>,
) {
  return yield* (yield* StateStore).mutateEffect(options, mutate);
});
