import { Deferred, Effect, FileSystem, PlatformError } from "effect";

/** A platform failure a fake file system returns; `path` names the path it refused. */
export const platformTestError = (method: string, path?: string) =>
  PlatformError.badArgument({ description: path, method, module: "test" });

type Fault = PlatformError.PlatformError | undefined;

/** Per-method answers: an error fails that call, `undefined` lets the real file system run it. */
export type FileSystemFaults = {
  readonly makeDirectory?: (path: string) => Fault;
  readonly open?: (path: string) => Fault;
  readonly readDirectory?: (path: string) => Fault;
  readonly readFileString?: (path: string) => Fault;
  readonly readLink?: (path: string) => Fault;
  readonly realPath?: (path: string) => Fault;
  readonly remove?: (path: string) => Fault;
  readonly rename?: (fromPath: string, toPath: string) => Fault;
  readonly stat?: (path: string) => Fault;
  readonly symlink?: (target: string, path: string) => Fault;
};

const failOr = <A, R>(
  fault: Fault,
  run: () => Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<A, PlatformError.PlatformError, R> =>
  fault === undefined ? run() : Effect.fail(fault);

/**
 * The current file system with the given calls failing.
 *
 * Pass the result to `provideTestFileSystem` so every service reads through it.
 */
export const faultyFileSystem = Effect.fnUntraced(function* (faults: FileSystemFaults) {
  const live = yield* FileSystem.FileSystem;
  // Every method a fault can name is wired here, so a new fault cannot be silently ignored.
  const wired: { readonly [Method in keyof FileSystemFaults]-?: FileSystem.FileSystem[Method] } = {
    makeDirectory: (path, options) =>
      failOr(faults.makeDirectory?.(path), () => live.makeDirectory(path, options)),
    open: (path, options) => failOr(faults.open?.(path), () => live.open(path, options)),
    readDirectory: (path, options) =>
      failOr(faults.readDirectory?.(path), () => live.readDirectory(path, options)),
    readFileString: (path, encoding) =>
      failOr(faults.readFileString?.(path), () => live.readFileString(path, encoding)),
    readLink: (path) => failOr(faults.readLink?.(path), () => live.readLink(path)),
    realPath: (path) => failOr(faults.realPath?.(path), () => live.realPath(path)),
    remove: (path, options) => failOr(faults.remove?.(path), () => live.remove(path, options)),
    rename: (fromPath, toPath) =>
      failOr(faults.rename?.(fromPath, toPath), () => live.rename(fromPath, toPath)),
    stat: (path) => failOr(faults.stat?.(path), () => live.stat(path)),
    symlink: (target, path) =>
      failOr(faults.symlink?.(target, path), () => live.symlink(target, path)),
  };
  return { ...live, ...wired } satisfies FileSystem.FileSystem;
});

/** The file system calls a test can stall on; each one changes a single path. */
type StallMethod = "makeDirectory" | "remove" | "symlink";

/** Stalls on the call that changes this path, or on the n-th call of the method. */
type StallTarget = string | { readonly call: number };

type StallOptions = {
  /** `"before"` (the default) stalls before the real call, `"after"` once it has changed disk. */
  readonly when?: "after" | "before";
  /** The file system to wrap; defaults to the current one. */
  readonly fileSystem?: FileSystem.FileSystem;
};

/**
 * A file system that stops on one call until the test releases it.
 *
 * `entered` completes when the stalled call is reached; completing `release` lets it go on.
 * A test that interrupts instead leaves `release` alone.
 */
export const stallAt = Effect.fnUntraced(function* (
  method: StallMethod,
  target: StallTarget,
  options: StallOptions = {},
) {
  const live = options.fileSystem ?? (yield* FileSystem.FileSystem);
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let calls = 0;

  const matches = (called: StallMethod, path: string) => {
    if (called !== method) {
      return false;
    }
    calls += 1;
    return typeof target === "string" ? path === target : calls === target.call;
  };
  const pause = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
  const stall = <R>(
    stalled: boolean,
    run: Effect.Effect<void, PlatformError.PlatformError, R>,
  ): Effect.Effect<void, PlatformError.PlatformError, R> => {
    if (stalled === false) {
      return run;
    }
    return options.when === "after" ? Effect.andThen(run, pause) : Effect.andThen(pause, run);
  };

  const fileSystem: FileSystem.FileSystem = {
    ...live,
    makeDirectory: (path, makeOptions) =>
      Effect.suspend(() =>
        stall(matches("makeDirectory", path), live.makeDirectory(path, makeOptions)),
      ),
    remove: (path, removeOptions) =>
      Effect.suspend(() => stall(matches("remove", path), live.remove(path, removeOptions))),
    symlink: (linkTarget, path) =>
      Effect.suspend(() => stall(matches("symlink", path), live.symlink(linkTarget, path))),
  };
  return { entered, fileSystem, release };
});
