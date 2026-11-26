import { expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path, Scope } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { holdReaderCache, readerCacheDirectory } from "./reader-cache.ts";

const project = { name: "demo", root: "/Users/ada/code/app" };

it.each([
  { other: project, same: true },
  { other: { ...project, root: "/Users/ada/code/app-review" }, same: false },
  { other: { ...project, name: "handbook" }, same: false },
])(
  "derives one cache directory per project root: $other.name at $other.root",
  ({ other, same }) => {
    const directory = readerCacheDirectory("/Users/ada/.tack", project);
    expect(directory).toMatch(/^\/Users\/ada\/\.tack\/cache\/reader\/demo-[0-9a-f]{12}$/);
    expect(readerCacheDirectory("/Users/ada/.tack", other) === directory).toBe(same);
  },
);

const withStateDirectory = <A, E, R>(use: (stateDirectory: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stateDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "tack-reader-cache-",
    });
    return yield* use(stateDirectory);
  }).pipe(Effect.scoped, Effect.provide(LiveTestLayer));

it.effect("holds the project's cache for one session and lets the next one take it", () =>
  withStateDirectory((stateDirectory) =>
    Effect.gen(function* () {
      const directory = readerCacheDirectory(stateDirectory, project);
      const first = yield* Scope.make();
      expect(yield* holdReaderCache(stateDirectory, project).pipe(Scope.provide(first))).toBe(
        directory,
      );
      // A concurrent session starts anyway, from a private temporary cache.
      expect(yield* Effect.scoped(holdReaderCache(stateDirectory, project))).toBeUndefined();
      yield* Scope.close(first, Exit.void);
      expect(yield* Effect.scoped(holdReaderCache(stateDirectory, project))).toBe(directory);
    }),
  ),
);

it.effect("falls back to a private cache when the state cannot hold one", () =>
  withStateDirectory((stateDirectory) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.writeFileString(path.join(stateDirectory, "cache"), "not a directory");
      expect(yield* Effect.scoped(holdReaderCache(stateDirectory, project))).toBeUndefined();
    }),
  ),
);
