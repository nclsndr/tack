import { Context, Effect, FileSystem, Option, PlatformError, Schema } from "effect";

/** A process that owns a lock, as one lock record names it. */
export type LockHolder = {
  readonly pid: number;
  /** Whether the record outlived the lifetime its lock allows; an expired owner counts as gone. */
  readonly expired: boolean;
};

/** How one lock names its owner: the record this process publishes and how a record reads back. */
export type LockProtocol = {
  /** The record this process, with id `pid`, publishes the moment it owns the lock. */
  readonly record: (pid: number) => string;
  /** Reads the owner out of a published record, or `undefined` when the record is unreadable. */
  readonly holder: (record: string) => LockHolder | undefined;
  /** Permissions for the lock file and the takeover claim directory. */
  readonly fileMode?: number;
  readonly directoryMode?: number;
};

/** A private lock whose record is the owning process id, held for as long as that process lives. */
export const processLockProtocol: LockProtocol = {
  record: (pid) => `${pid}\n`,
  holder: (record) => {
    const value = record.trim();
    if (!/^[1-9]\d*$/.test(value)) return undefined;
    const pid = Number(value);
    return Number.isSafeInteger(pid) ? { pid, expired: false } : undefined;
  },
  fileMode: 0o600,
  directoryMode: 0o700,
};

/** Reports that a live process, or an owner that cannot be identified, holds the lock. */
export class LockBusyError extends Schema.TaggedError<LockBusyError>()("LockBusyError", {
  lockPath: Schema.String,
  ownerPid: Schema.optional(Schema.Number),
}) {}

/** Reports a filesystem failure while taking, taking over, or releasing a lock. */
export class LockStorageError extends Schema.TaggedError<LockStorageError>()("LockStorageError", {
  message: Schema.String,
  operation: Schema.Literals(["acquire", "claim stale", "remove stale", "release"]),
  path: Schema.String,
}) {}

/** Proof of ownership; `release` removes the lock only while it still names this acquisition. */
export type LockOwnership = {
  readonly release: Effect.Effect<void, LockStorageError>;
};

const textEncoder = new TextEncoder();

const reasonOf = (error: PlatformError.PlatformError) => error.reason._tag;

const storageError = (
  operation: LockStorageError["operation"],
  path: string,
  error: PlatformError.PlatformError,
) => new LockStorageError({ message: error.message, operation, path });

/** The running process as a lock owner: its id, and whether the process of another id is gone. */
export type LockProcessShape = {
  readonly pid: number;
  readonly isGone: (pid: number) => boolean;
};

/**
 * The process that takes locks. It defaults to the operating-system process; a host without one,
 * such as the in-memory browser build, provides its own.
 */
export const LockProcess = Context.Reference<LockProcessShape>(
  "tack/cli/services/exclusive-lock/LockProcess",
  {
    defaultValue: () => ({
      pid: process.pid,
      isGone: (pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return error instanceof Error && "code" in error && error.code === "ESRCH";
        }
      },
    }),
  },
);

const processIsGone = (pid: number) =>
  LockProcess.use((owner) => Effect.sync(() => owner.isGone(pid)));

const readRecord = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(path);
  }).pipe(Effect.option);

/**
 * Publishes this process's record at `path` in one step: the record is written and synced under a
 * private name first, then hard-linked into place. The link fails when `path` exists and otherwise
 * makes the complete record visible at once, so no process ever observes a lock without its owner
 * and a failed write can never leave a lock behind. Ownership starts at the link; the private name
 * is gone before this returns, and a failure to remove it does not undo ownership.
 */
const publish = Effect.fnUntraced(function* (path: string, protocol: LockProtocol, record: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const staging = `${path}.tmp-${crypto.randomUUID()}`;
  const written = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(staging, {
        flag: "wx",
        ...(protocol.fileMode === undefined ? {} : { mode: protocol.fileMode }),
      });
      yield* file.writeAll(textEncoder.encode(record));
      yield* file.sync;
    }),
  ).pipe(Effect.result);
  const linked = yield* Effect.result(
    written._tag === "Success" ? fileSystem.link(staging, path) : Effect.fail(written.failure),
  );
  yield* fileSystem.remove(staging, { force: true }).pipe(Effect.ignore);
  return linked;
});

const ownershipOf = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  record: string,
): LockOwnership => ({
  release: Effect.gen(function* () {
    const current = yield* fileSystem.readFileString(path).pipe(Effect.option);
    if (Option.isSome(current)) {
      // A lock that names another acquisition is not ours to remove.
      if (current.value !== record) return;
    } else if (!(yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => true)))) {
      return;
    }
    yield* fileSystem
      .remove(path, { force: true })
      .pipe(Effect.mapError((error) => storageError("release", path, error)));
  }),
});

/**
 * Takes the exclusive lock at `path`, failing with {@link LockBusyError} while a live process, or an
 * owner that cannot be identified, holds it. A lock whose owner is gone is taken over. Ownership
 * is atomic with its record, and the returned {@link LockOwnership} is the only thing to register
 * for cleanup: nothing after the owner's record is published can fail the acquisition.
 */
export const acquireExclusiveLock = Effect.fnUntraced(function* (
  path: string,
  protocol: LockProtocol,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const record = protocol.record((yield* LockProcess).pid);
  const first = yield* publish(path, protocol, record);
  if (first._tag === "Success") return ownershipOf(fileSystem, path, record);
  if (reasonOf(first.failure) !== "AlreadyExists") {
    return yield* Effect.fail(storageError("acquire", path, first.failure));
  }

  const observed = yield* readRecord(path);
  const holder = Option.flatMap(observed, (text) =>
    Option.fromNullishOr(protocol.holder(text)),
  ).pipe(Option.getOrUndefined);
  const busy = () =>
    new LockBusyError({
      lockPath: path,
      ...(holder === undefined ? {} : { ownerPid: holder.pid }),
    });
  const gone = (candidate: LockHolder) =>
    candidate.expired ? Effect.succeed(true) : processIsGone(candidate.pid);
  // An owner that cannot be read is never reclaimed: it may be mid-publication under another scheme.
  if (holder === undefined || (yield* gone(holder)) === false) return yield* Effect.fail(busy());

  // A separate atomic directory serializes contenders while the dead lock is removed.
  const claim = `${path}.takeover`;
  yield* fileSystem
    .makeDirectory(claim, {
      ...(protocol.directoryMode === undefined ? {} : { mode: protocol.directoryMode }),
    })
    .pipe(
      Effect.mapError((error) =>
        reasonOf(error) === "AlreadyExists" ? busy() : storageError("claim stale", claim, error),
      ),
    );
  return yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      Effect.gen(function* () {
        const current = yield* readRecord(path);
        if (
          !Option.isSome(current) ||
          !Option.isSome(observed) ||
          current.value !== observed.value
        ) {
          return yield* Effect.fail(busy());
        }
        yield* fileSystem
          .remove(path)
          .pipe(Effect.mapError((error) => storageError("remove stale", path, error)));
        const taken = yield* publish(path, protocol, record);
        if (taken._tag === "Success") return ownershipOf(fileSystem, path, record);
        return yield* Effect.fail(
          reasonOf(taken.failure) === "AlreadyExists"
            ? busy()
            : storageError("acquire", path, taken.failure),
        );
      }),
    () => fileSystem.remove(claim, { recursive: true, force: true }).pipe(Effect.orDie),
  );
});
