import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Fiber, Path, PlatformError, Result } from "effect";
import { spawnSync } from "node:child_process";
import { LiveTestLayer } from "../../test/support/live-test-layer.ts";
import {
  acquireExclusiveLock,
  LockBusyError,
  LockStorageError,
  type LockProtocol,
} from "./exclusive-lock.ts";

const injected = (method: string) => PlatformError.badArgument({ module: "test", method });

/** A protocol whose records name `pid`, so a test can stand in for any owner. */
const protocolFor = (pid: number = process.pid, expired = false): LockProtocol => ({
  record: () => `${pid}\n`,
  holder: (record) => {
    const value = Number(record.trim());
    return Number.isSafeInteger(value) && value > 0 ? { pid: value, expired } : undefined;
  },
});

const deadPid = () =>
  Number(spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim());

const withLockDirectory = <A, E, R>(
  use: (directory: string, lock: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-lock-test-" });
    return yield* use(directory, path.join(directory, "test.lock"));
  });

/** Wraps an open file so one of its members is replaced, keeping the rest of the handle intact. */
const overriding = <F extends object>(file: F, member: string, replacement: unknown): F =>
  new Proxy(file, {
    get: (target, key) => (key === member ? replacement : Reflect.get(target, key)),
  });

const asFileSystem = (
  fileSystem: FileSystem.FileSystem,
  overrides: Partial<FileSystem.FileSystem>,
) => ({ ...fileSystem, ...overrides }) as FileSystem.FileSystem;

it.layer(LiveTestLayer)("exclusive lock", (lockIt) => {
  lockIt.effect("takes a free lock with its record and removes it on release", () =>
    withLockDirectory((directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const ownership = yield* acquireExclusiveLock(lock, protocolFor());
        expect(yield* fileSystem.readFileString(lock)).toBe(`${process.pid}\n`);
        // Only the lock remains: the private name the record was staged under is gone.
        expect(yield* fileSystem.readDirectory(directory)).toEqual(["test.lock"]);
        yield* ownership.release;
        expect(yield* fileSystem.exists(lock)).toBe(false);
      }),
    ),
  );

  lockIt.effect("never lets a second process in while the first publishes its record", () =>
    withLockDirectory((directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const reached = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let first = true;
        const pausing = asFileSystem(fileSystem, {
          open: (target, options) =>
            fileSystem.open(target, options).pipe(
              Effect.map((file) => {
                if (!first) return file;
                first = false;
                // The first acquirer stops after creating its file and before its record is written.
                return overriding(file, "writeAll", (bytes: Uint8Array) =>
                  Deferred.succeed(reached, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.andThen(file.writeAll(bytes)),
                  ),
                );
              }),
            ),
        });
        const slow = yield* acquireExclusiveLock(lock, protocolFor()).pipe(
          Effect.provideService(FileSystem.FileSystem, pausing),
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(reached);
        const second = yield* acquireExclusiveLock(lock, protocolFor());
        yield* Deferred.succeed(resume, undefined);
        const outcome = yield* Fiber.join(slow);

        // The second process owns the lock; the paused one finds it taken instead of also entering.
        expect(Result.isFailure(outcome) && outcome.failure).toBeInstanceOf(LockBusyError);
        expect(yield* fileSystem.readFileString(lock)).toBe(`${process.pid}\n`);
        yield* second.release;
        expect(yield* fileSystem.readDirectory(directory)).toEqual([]);
      }),
    ),
  );

  lockIt.effect("leaves no lock behind when publishing the record fails", () =>
    withLockDirectory((directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        for (const failing of ["writeAll", "sync"] as const) {
          const broken = asFileSystem(fileSystem, {
            open: (target, options) =>
              fileSystem
                .open(target, options)
                .pipe(
                  Effect.map((file) =>
                    overriding(
                      file,
                      failing,
                      failing === "sync"
                        ? Effect.fail(injected(failing))
                        : () => Effect.fail(injected(failing)),
                    ),
                  ),
                ),
          });
          const error = yield* acquireExclusiveLock(lock, protocolFor()).pipe(
            Effect.provideService(FileSystem.FileSystem, broken),
            Effect.flip,
          );
          expect(error).toBeInstanceOf(LockStorageError);
          expect(yield* fileSystem.readDirectory(directory)).toEqual([]);
          // The next healthy acquirer is not refused by a leftover.
          yield* (yield* acquireExclusiveLock(lock, protocolFor())).release;
        }
      }),
    ),
  );

  lockIt.effect(
    "reports a failure to link the record as a storage failure and leaves nothing",
    () =>
      withLockDirectory((directory, lock) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const broken = asFileSystem(fileSystem, { link: () => Effect.fail(injected("link")) });
          const error = yield* acquireExclusiveLock(lock, protocolFor()).pipe(
            Effect.provideService(FileSystem.FileSystem, broken),
            Effect.flip,
          );
          expect(error).toBeInstanceOf(LockStorageError);
          expect(yield* fileSystem.readDirectory(directory)).toEqual([]);
        }),
      ),
  );

  lockIt.effect("stays busy for a live owner and for an owner it cannot read", () =>
    withLockDirectory((directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(lock, `${process.pid}\n`);
        const live = yield* acquireExclusiveLock(lock, protocolFor()).pipe(Effect.flip);
        expect(live).toBeInstanceOf(LockBusyError);
        expect(live instanceof LockBusyError && live.ownerPid).toBe(process.pid);

        yield* fileSystem.writeFileString(lock, "");
        const unreadable = yield* acquireExclusiveLock(lock, protocolFor()).pipe(Effect.flip);
        expect(unreadable).toBeInstanceOf(LockBusyError);
        expect(unreadable instanceof LockBusyError && unreadable.ownerPid).toBeUndefined();
        expect(yield* fileSystem.readFileString(lock)).toBe("");
        expect(yield* fileSystem.readDirectory(directory)).toEqual(["test.lock"]);
      }),
    ),
  );

  lockIt.effect("takes over a lock whose owner is gone or whose record expired", () =>
    withLockDirectory((directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(lock, `${deadPid()}\n`);
        const afterDeath = yield* acquireExclusiveLock(lock, protocolFor());
        expect(yield* fileSystem.readFileString(lock)).toBe(`${process.pid}\n`);
        yield* afterDeath.release;

        yield* fileSystem.writeFileString(lock, `${process.pid}\n`);
        const afterExpiry = yield* acquireExclusiveLock(lock, {
          ...protocolFor(),
          holder: protocolFor(process.pid, true).holder,
        });
        yield* afterExpiry.release;
        expect(yield* fileSystem.readDirectory(directory)).toEqual([]);
      }),
    ),
  );

  lockIt.effect("admits exactly one of two contenders racing to take over a dead lock", () =>
    withLockDirectory((_directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          yield* fileSystem.writeFileString(lock, `${deadPid()}\n`);
          const outcomes = yield* Effect.all(
            [
              acquireExclusiveLock(lock, protocolFor()),
              acquireExclusiveLock(lock, protocolFor()),
            ].map(Effect.result),
            { concurrency: "unbounded" },
          );
          const owners = outcomes.filter(Result.isSuccess);
          expect(owners).toHaveLength(1);
          for (const owner of owners) yield* owner.success.release;
          expect(yield* fileSystem.exists(lock)).toBe(false);
        }
      }),
    ),
  );

  lockIt.effect("stays busy while another contender is already taking over a dead lock", () =>
    withLockDirectory((_directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const dead = `${deadPid()}\n`;
        yield* fileSystem.writeFileString(lock, dead);
        yield* fileSystem.makeDirectory(`${lock}.takeover`);
        const error = yield* acquireExclusiveLock(lock, protocolFor()).pipe(Effect.flip);
        expect(error).toBeInstanceOf(LockBusyError);
        expect(yield* fileSystem.readFileString(lock)).toBe(dead);
      }),
    ),
  );

  lockIt.effect("does not take over a lock that changed owner during the takeover", () =>
    withLockDirectory((_directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(lock, `${deadPid()}\n`);
        const changing = asFileSystem(fileSystem, {
          makeDirectory: (target, options) =>
            fileSystem
              .makeDirectory(target, options)
              .pipe(Effect.tap(() => fileSystem.writeFileString(lock, `${process.pid}\n`))),
        });
        const error = yield* acquireExclusiveLock(lock, protocolFor()).pipe(
          Effect.provideService(FileSystem.FileSystem, changing),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(LockBusyError);
        expect(yield* fileSystem.readFileString(lock)).toBe(`${process.pid}\n`);
        expect(yield* fileSystem.exists(`${lock}.takeover`)).toBe(false);
      }),
    ),
  );

  lockIt.effect("releases only the acquisition it made", () =>
    withLockDirectory((_directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const ownership = yield* acquireExclusiveLock(lock, protocolFor());
        // Another acquisition replaced the lock while this one was running.
        yield* fileSystem.writeFileString(lock, "4194303\n");
        yield* ownership.release;
        expect(yield* fileSystem.readFileString(lock)).toBe("4194303\n");
        yield* fileSystem.remove(lock);
        yield* ownership.release;
        expect(yield* fileSystem.exists(lock)).toBe(false);
      }),
    ),
  );

  lockIt.effect("reports a lock it cannot remove on release", () =>
    withLockDirectory((_directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const ownership = yield* acquireExclusiveLock(lock, protocolFor());
        // Something replaced the lock with a directory it cannot read back as a record.
        yield* fileSystem.remove(lock);
        yield* fileSystem.makeDirectory(lock);
        yield* fileSystem.writeFileString(`${lock}/entry`, "kept");
        const error = yield* Effect.flip(ownership.release);
        expect(error).toMatchObject({ _tag: "LockStorageError", operation: "release", path: lock });
        expect(yield* fileSystem.readFileString(`${lock}/entry`)).toBe("kept");
      }),
    ),
  );

  lockIt.effect("removes its lock on release when it can neither read nor probe it", () =>
    withLockDirectory((directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const blind = asFileSystem(fileSystem, {
          readFileString: (target, encoding) =>
            target === lock
              ? Effect.fail(injected("readFileString"))
              : fileSystem.readFileString(target, encoding),
          exists: (target) =>
            target === lock ? Effect.fail(injected("exists")) : fileSystem.exists(target),
        });
        const ownership = yield* acquireExclusiveLock(lock, protocolFor()).pipe(
          Effect.provideService(FileSystem.FileSystem, blind),
        );
        yield* ownership.release;
        expect(yield* fileSystem.readDirectory(directory)).toEqual([]);
      }),
    ),
  );

  lockIt.effect("reports a dead lock it cannot remove and leaves no takeover claim", () =>
    withLockDirectory((directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const dead = `${deadPid()}\n`;
        yield* fileSystem.writeFileString(lock, dead);
        const stuck = asFileSystem(fileSystem, {
          remove: (target, options) =>
            target === lock && options === undefined
              ? Effect.fail(injected("remove"))
              : fileSystem.remove(target, options),
        });
        const error = yield* acquireExclusiveLock(lock, protocolFor()).pipe(
          Effect.provideService(FileSystem.FileSystem, stuck),
          Effect.flip,
        );
        expect(error).toMatchObject({
          _tag: "LockStorageError",
          operation: "remove stale",
          path: lock,
        });
        expect(yield* fileSystem.readFileString(lock)).toBe(dead);
        expect(yield* fileSystem.readDirectory(directory)).toEqual(["test.lock"]);
      }),
    ),
  );

  lockIt.effect("stays busy or reports storage when publishing after a takeover fails", () =>
    withLockDirectory((directory, lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const raced = PlatformError.systemError({
          _tag: "AlreadyExists",
          module: "test",
          method: "link",
          pathOrDescriptor: lock,
        });
        for (const [failure, expected] of [
          [raced, LockBusyError],
          [injected("link"), LockStorageError],
        ] as const) {
          yield* fileSystem.writeFileString(lock, `${deadPid()}\n`);
          let links = 0;
          const contested = asFileSystem(fileSystem, {
            link: (from, to) => {
              links += 1;
              // The first link meets the dead lock; the second loses to another contender.
              return links === 1 ? fileSystem.link(from, to) : Effect.fail(failure);
            },
          });
          const error = yield* acquireExclusiveLock(lock, protocolFor()).pipe(
            Effect.provideService(FileSystem.FileSystem, contested),
            Effect.flip,
          );
          expect(error).toBeInstanceOf(expected);
          expect(links).toBe(2);
          expect(yield* fileSystem.readDirectory(directory)).toEqual([]);
        }
      }),
    ),
  );
});
