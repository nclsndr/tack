import { Effect, FileSystem, Option } from "effect";
import { posixPath, sha256 } from "../../domain/identity/portable.ts";
import { acquireExclusiveLock, processLockProtocol } from "../../services/exclusive-lock.ts";

/** The project checkout one reader session serves. */
type ReaderCacheProject = { readonly name: string; readonly root: string };

/**
 * Locates the reader's build cache for one project checkout inside the state directory, so Tack
 * owns it and the checkout stays clean. Each root gets its own directory: Rspack keys the cache on
 * absolute paths, and two worktrees of a project can serve their docs at the same time.
 */
export const readerCacheDirectory = (stateDirectory: string, project: ReaderCacheProject) =>
  posixPath.join(
    stateDirectory,
    "cache",
    "reader",
    `${project.name}-${sha256(project.root).slice(0, 12)}`,
  );

/**
 * Holds the project's reader cache for the rest of the scope, returning its directory. It returns
 * `undefined` when another session holds it or the state cannot hold it: the reader then builds
 * from a private temporary cache, as a cold start, and the session still starts.
 */
export const holdReaderCache = Effect.fnUntraced(function* (
  stateDirectory: string,
  project: ReaderCacheProject,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = readerCacheDirectory(stateDirectory, project);
  const held = yield* Effect.acquireRelease(
    fileSystem
      .makeDirectory(directory, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.andThen(
          acquireExclusiveLock(posixPath.join(directory, "session.lock"), processLockProtocol),
        ),
        Effect.option,
      ),
    (ownership) =>
      Option.isSome(ownership) ? ownership.value.release.pipe(Effect.ignore) : Effect.void,
  );
  return Option.isSome(held) ? directory : undefined;
});
