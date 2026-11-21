import { Effect, FileSystem, Layer, Path, PlatformError, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { emptyState, type State } from "../../domain/state/state-schema.ts";
import { routeStateDocument, stateFileName, stateFormat } from "../../domain/state/state-format.ts";
import { decodeState, encodeState } from "../../domain/state/state-codec.ts";
import { historyDirectory } from "../../domain/execution/history-location.ts";
import {
  acquireExclusiveLock,
  type LockOwnership,
  type LockProtocol,
} from "../../services/exclusive-lock.ts";

import {
  StateBusyError,
  StateConfigurationError,
  StateCorruptError,
  StateFormatUnsupportedError,
  StateMutationError,
  StateNotInitializedError,
  StateStorageError,
  StateStore,
  type StateCheckpointWriter,
  type StateOptions,
} from "../../services/state-store.ts";

const dotenvFileName = ".env";
const lockFileName = "state.lock";
const restrictedDirectoryMode = 0o700;
const restrictedFileMode = 0o600;

type StatePaths = {
  readonly dotenvPath: string;
  readonly lockPath: string;
  readonly stateDirectory: string;
  readonly statePath: string;
};

const StateDocumentSchema = Schema.fromJsonString(Schema.Unknown);
const decodeStateJson = Schema.decodeUnknownEffect(StateDocumentSchema);
const textEncoder = new TextEncoder();

const isPlatformReason = (error: PlatformError.PlatformError, reason: string) => {
  return error.reason._tag === reason;
};

const toStateStorageError = (operation: string, path: string, error: PlatformError.PlatformError) =>
  new StateStorageError({
    message: error.message,
    operation,
    path,
  });

/**
 * Routes a state file on its first field. Format 1 is decoded; a larger `format` was written by a
 * newer release; anything else is damaged.
 */
const parseState = (
  statePath: string,
  encodedState: string,
): Effect.Effect<State, StateCorruptError | StateFormatUnsupportedError> =>
  Effect.gen(function* () {
    const document = yield* decodeStateJson(encodedState).pipe(
      Effect.mapError((cause) => new StateCorruptError({ message: cause.message, statePath })),
    );
    const route = routeStateDocument(document);
    if (route._tag === "unrecognized")
      return yield* new StateCorruptError({
        message: "The state document does not start with a `format` field.",
        statePath,
      });
    if (route.format > stateFormat)
      return yield* new StateFormatUnsupportedError({ foundFormat: route.format, statePath });
    return yield* decodeState(document).pipe(
      Effect.mapError((cause) => new StateCorruptError({ message: cause.message, statePath })),
    );
  });

const resolveStatePaths = Effect.fnUntraced(function* (options: StateOptions) {
  const path = yield* Path.Path;
  const stateDirectory = yield* resolveStateDirectoryLive(options);

  return {
    dotenvPath: path.join(stateDirectory, dotenvFileName),
    lockPath: path.join(stateDirectory, lockFileName),
    stateDirectory,
    statePath: path.join(stateDirectory, stateFileName),
  } satisfies StatePaths;
});

const readStateDocumentAtPath = Effect.fnUntraced(function* (statePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const encodedState = yield* fileSystem
    .readFileString(statePath)
    .pipe(
      Effect.mapError((error) =>
        isPlatformReason(error, "NotFound")
          ? new StateNotInitializedError({ statePath })
          : toStateStorageError("read state", statePath, error),
      ),
    );

  return yield* parseState(statePath, encodedState);
});

const readStateAtPath = readStateDocumentAtPath;

const ensureStateExists = Effect.fnUntraced(function* (statePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;

  yield* fileSystem
    .access(statePath)
    .pipe(
      Effect.mapError((error) =>
        isPlatformReason(error, "NotFound")
          ? new StateNotInitializedError({ statePath })
          : toStateStorageError("access state", statePath, error),
      ),
    );
});

const ensureStateDirectory = Effect.fnUntraced(function* (stateDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;

  yield* fileSystem
    .makeDirectory(stateDirectory, { mode: restrictedDirectoryMode, recursive: true })
    .pipe(
      Effect.mapError((error) =>
        toStateStorageError("create state directory", stateDirectory, error),
      ),
    );
});

const createDotenvIfMissing = Effect.fnUntraced(function* (dotenvPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    fileSystem.open(dotenvPath, { flag: "wx", mode: restrictedFileMode }).pipe(
      Effect.tap((dotenv) => dotenv.sync),
      Effect.as(true),
    ),
  ).pipe(
    Effect.catch((error): Effect.Effect<boolean, StateStorageError> => {
      if (isPlatformReason(error, "AlreadyExists")) {
        return fileSystem.stat(dotenvPath).pipe(
          Effect.mapError((statError) =>
            toStateStorageError("inspect dotenv file", dotenvPath, statError),
          ),
          Effect.flatMap((existingDotenv) =>
            existingDotenv.type === "File"
              ? Effect.succeed(false)
              : Effect.fail(
                  new StateStorageError({
                    message: "The operator dotenv path is not a regular file.",
                    operation: "create dotenv file",
                    path: dotenvPath,
                  }),
                ),
          ),
        );
      }

      return Effect.fail(
        new StateStorageError({
          message: error.message,
          operation: "create dotenv file",
          path: dotenvPath,
        }),
      );
    }),
  );
});

const writerLockProtocol: LockProtocol = {
  record: (pid) => `${pid}\n`,
  holder: (record) => {
    const value = record.trim();
    if (!/^[1-9]\d*$/.test(value)) return undefined;
    const pid = Number(value);
    return Number.isSafeInteger(pid) ? { pid, expired: false } : undefined;
  },
  fileMode: restrictedFileMode,
  directoryMode: restrictedDirectoryMode,
};

const acquireWriterLock = (lockPath: string) =>
  acquireExclusiveLock(lockPath, writerLockProtocol).pipe(
    Effect.catchTag("LockBusyError", (busy) =>
      Effect.fail(
        new StateBusyError({
          lockPath,
          ...(busy.ownerPid === undefined ? {} : { ownerPid: busy.ownerPid }),
        }),
      ),
    ),
    Effect.mapError((error) =>
      error instanceof StateBusyError
        ? error
        : new StateStorageError({
            message: error.message,
            operation: `${error.operation} state writer lock`,
            path: error.path,
          }),
    ),
  );

const removeOrphanedStateFiles = Effect.fnUntraced(function* (paths: StatePaths) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(paths.stateDirectory)
    .pipe(
      Effect.mapError((error) =>
        toStateStorageError("list temporary state files", paths.stateDirectory, error),
      ),
    );
  for (const entry of entries) {
    if (!entry.startsWith(`${stateFileName}.tmp-`)) continue;
    const temporaryPath = path.join(paths.stateDirectory, entry);
    const info = yield* fileSystem
      .stat(temporaryPath)
      .pipe(
        Effect.mapError((error) =>
          toStateStorageError("inspect temporary state file", temporaryPath, error),
        ),
      );
    if (info.type !== "File") continue;
    yield* fileSystem
      .remove(temporaryPath)
      .pipe(
        Effect.mapError((error) =>
          toStateStorageError("remove temporary state file", temporaryPath, error),
        ),
      );
  }
});

const releaseWriterLock = (ownership: LockOwnership) =>
  ownership.release.pipe(
    Effect.mapError(
      (error) =>
        new StateStorageError({
          message: error.message,
          operation: "release state writer lock",
          path: error.path,
        }),
    ),
  );

const withWriterLock = <A, E, R>(paths: StatePaths, use: () => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.acquireUseRelease(acquireWriterLock(paths.lockPath), () => use(), releaseWriterLock),
  );

const writeStateAtomically = Effect.fnUntraced(function* (statePath: string, state: State) {
  const persistedState = yield* encodeState(state).pipe(
    Effect.mapError((cause) => new StateMutationError({ message: cause.message, statePath })),
  );
  const encodedState = JSON.stringify(persistedState, null, 2);
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const temporaryStateId = yield* random.uuidV4();
  const temporaryStatePath = `${statePath}.tmp-${temporaryStateId}`;
  const writeAndReplace = Effect.scoped(
    Effect.gen(function* () {
      const temporaryState = yield* fileSystem.open(temporaryStatePath, {
        flag: "wx",
        mode: restrictedFileMode,
      });
      yield* temporaryState.writeAll(textEncoder.encode(encodedState));
      yield* temporaryState.sync;
      yield* fileSystem.rename(temporaryStatePath, statePath);
    }),
  ).pipe(
    Effect.mapError((error) => toStateStorageError("atomically write state", statePath, error)),
  );
  const removeTemporaryState = fileSystem
    .remove(temporaryStatePath, { force: true })
    .pipe(
      Effect.mapError((error) =>
        toStateStorageError("remove temporary state", temporaryStatePath, error),
      ),
    );

  yield* Effect.onExit(writeAndReplace, () => removeTemporaryState);
});

/** Resolves `TACK_STATE_DIR`, falling back to the supplied operator home and `.tack`. */
const resolveStateDirectoryLive = Effect.fnUntraced(function* (options: StateOptions) {
  const path = yield* Path.Path;
  const configuredStateDirectory = options.environment["TACK_STATE_DIR"];

  if (configuredStateDirectory !== undefined) {
    if (configuredStateDirectory.length === 0) {
      return yield* new StateConfigurationError({ message: "TACK_STATE_DIR must not be empty." });
    }

    return path.resolve(configuredStateDirectory);
  }

  if (options.homeDirectory === undefined || options.homeDirectory.length === 0) {
    return yield* new StateConfigurationError({
      message: "The operator home directory is unavailable.",
    });
  }

  return path.join(options.homeDirectory, ".tack");
});

/** Creates the initial state and operator-owned dotenv file without overwriting either existing file. */
const initializeStateLive = Effect.fnUntraced(function* (options: StateOptions) {
  const paths = yield* resolveStatePaths(options);
  yield* ensureStateDirectory(paths.stateDirectory);

  return yield* withWriterLock(paths, () =>
    Effect.gen(function* () {
      const existing = yield* readStateDocumentAtPath(paths.statePath).pipe(
        Effect.catchIf(
          (error): error is StateNotInitializedError => error._tag === "StateNotInitializedError",
          () => Effect.succeed(undefined),
        ),
      );
      const alreadyInitialized = existing !== undefined;
      yield* removeOrphanedStateFiles(paths);

      if (existing === undefined) {
        yield* writeStateAtomically(paths.statePath, emptyState());
        options.observer?.wrote();
      }

      yield* createDotenvIfMissing(paths.dotenvPath);

      return { alreadyInitialized, stateDirectory: paths.stateDirectory };
    }),
  );
});

/** Reads and validates the complete supported state document. */
const readStateLive = Effect.fnUntraced(function* (options: StateOptions) {
  const paths = yield* resolveStatePaths(options);
  return yield* readStateAtPath(paths.statePath);
});

/** Builds the state capability over explicit platform services. */
export const makeStateStoreService = (
  random: SecureRandom.SecureRandom["Service"],
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
): StateStore["Service"] => {
  const provideInternal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(SecureRandom.SecureRandom, random),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const withCheckpointWriter = <A, E, R>(
    options: StateOptions,
    use: (writer: StateCheckpointWriter) => Effect.Effect<A, E, R>,
    autoInitialize = false,
  ) =>
    Effect.gen(function* () {
      const paths = yield* provideInternal(resolveStatePaths(options));
      const mayInitialize = autoInitialize && options.environment["TACK_STATE_DIR"] === undefined;
      if (mayInitialize) yield* provideInternal(ensureStateDirectory(paths.stateDirectory));
      else yield* provideInternal(ensureStateExists(paths.statePath));

      return yield* Effect.scoped(
        Effect.acquireUseRelease(
          provideInternal(acquireWriterLock(paths.lockPath)),
          () =>
            Effect.gen(function* () {
              const document = yield* provideInternal(
                readStateDocumentAtPath(paths.statePath),
              ).pipe(
                Effect.catchIf(
                  (error): error is StateNotInitializedError =>
                    mayInitialize && error instanceof StateNotInitializedError,
                  () => Effect.succeed(undefined),
                ),
              );
              yield* provideInternal(removeOrphanedStateFiles(paths));
              let currentState = document ?? emptyState();
              let stateExists = document !== undefined;
              let deleted = false;

              const checkpoint: StateCheckpointWriter["checkpoint"] = (mutate) =>
                Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    if (deleted) {
                      return yield* new StateMutationError({
                        message: "The terminal state deletion already completed.",
                        statePath: paths.statePath,
                      });
                    }
                    const mutation = yield* Effect.try({
                      catch: (cause) =>
                        new StateMutationError({
                          message:
                            cause instanceof Error ? cause.message : "State mutation failed.",
                          statePath: paths.statePath,
                        }),
                      try: () => mutate(currentState),
                    });
                    const candidate = yield* restore(mutation);

                    if (candidate.state === currentState && stateExists) {
                      return candidate.value;
                    }

                    // Encoding validates the candidate once; a rejected candidate writes nothing.
                    yield* provideInternal(writeStateAtomically(paths.statePath, candidate.state));
                    options.observer?.wrote();
                    if (!stateExists) {
                      yield* provideInternal(createDotenvIfMissing(paths.dotenvPath));
                      options.observer?.initialized(paths.stateDirectory);
                    }
                    currentState = candidate.state;
                    stateExists = true;

                    return candidate.value;
                  }),
                );

              const deleteState: StateCheckpointWriter["deleteState"] = () =>
                Effect.gen(function* () {
                  if (stateExists === false) {
                    return;
                  }
                  const historyPath = historyDirectory(paths.stateDirectory);
                  yield* fileSystem
                    .remove(historyPath, { recursive: true, force: true })
                    .pipe(
                      Effect.mapError((error) =>
                        toStateStorageError("delete run history", historyPath, error),
                      ),
                    );
                  yield* fileSystem
                    .remove(paths.statePath)
                    .pipe(
                      Effect.mapError((error) =>
                        toStateStorageError("delete state", paths.statePath, error),
                      ),
                    );
                  stateExists = false;
                  deleted = true;
                  options.observer?.wrote();
                }).pipe(Effect.uninterruptible);

              return yield* use({
                checkpoint,
                current: () => currentState,
                deleteState,
                stateExists: () => stateExists,
              });
            }),
          (ownership) => provideInternal(releaseWriterLock(ownership)),
        ),
      );
    });

  return StateStore.of({
    initialize: (options) => provideInternal(initializeStateLive(options)),
    mutateEffect: (options, mutate) =>
      withCheckpointWriter(options, (writer) => writer.checkpoint(mutate), true),
    read: (options) => provideInternal(readStateLive(options)),
    resolveDirectory: (options) => provideInternal(resolveStateDirectoryLive(options)),
    withCheckpointWriter,
  });
};

/** Provides state persistence over Effect's filesystem, path, and secure random services. */
export const StateStoreLive = Layer.effect(
  StateStore,
  Effect.gen(function* () {
    return makeStateStoreService(
      yield* SecureRandom.SecureRandom,
      yield* FileSystem.FileSystem,
      yield* Path.Path,
    );
  }),
);

/** Resolves the configured Tack state directory through the state capability. */
