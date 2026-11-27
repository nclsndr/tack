import { seedSource } from "./source-tree.ts";
import { Effect, FileSystem, Layer, Path } from "effect";
import { vi } from "vitest";
import { fixtureRemotesVariable, ImportRemoteLive } from "../../src/platform/git/import-remote.ts";
import { initializeState, type StateOptions } from "../../src/services/state-store.ts";
import { registerSource } from "../../src/features/sources/source.ts";
import { makeRemoteFixture, type FixtureCommit } from "./git-remote-fixture.ts";
import { stateOptionsAt } from "./state-fixture.ts";

/** One isolated world: a state directory, a destination source and a local git remote. */
export type ImportWorld = {
  readonly base: string;
  readonly options: StateOptions;
  /** The destination source root. */
  readonly root: string;
  readonly statePath: string;
  readonly revisions: ReadonlyArray<string>;
};

/**
 * Builds an isolated world for an import test: a registered destination source from the given
 * declaration and files, and a fixture remote at `acme/skills`. The remote is served through the
 * live import remote with the fixture variable set for the test's scope.
 */
export const withImportWorld = <A, E, R>(
  input: {
    readonly declaration: string;
    readonly files?: Readonly<Record<string, string>>;
    readonly commits: ReadonlyArray<FixtureCommit>;
    readonly register?: boolean;
  },
  use: (world: ImportWorld) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-import-world-" }),
    );
    const options = stateOptionsAt(path.join(base, "state"), base);
    yield* initializeState(options);
    const root = yield* seedSource(path.join(base, "personal-brain"), {
      "tack.yaml": input.declaration,
      ...input.files,
    });
    if (input.register !== false) yield* registerSource(options, { sourcePath: root });
    const remotes = path.join(base, "remotes");
    const fixture = yield* makeRemoteFixture(remotes, "acme", "skills", input.commits);
    vi.stubEnv(fixtureRemotesVariable, remotes);
    return yield* use({
      base,
      options,
      root,
      statePath: path.join(base, "state", "state.json"),
      revisions: fixture.revisions,
    }).pipe(
      // Fresh, so the fixture variable set above is read, not a remote built earlier.
      Effect.provide(Layer.fresh(ImportRemoteLive)),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  }).pipe(Effect.scoped);

/**
 * Lists every path below a directory with a digest of its bytes and its mode, so two snapshots can
 * be compared for any change: content, a new or removed path, a mode flip. Symlinks list their
 * target; nothing is followed.
 */
export const snapshotTree = (directory: string) =>
  Effect.promise(async () => {
    const { lstat, readdir, readFile, readlink } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const entries = new Map<string, string>();
    const walk = async (relative: string): Promise<void> => {
      const absolute = relative === "" ? directory : `${directory}/${relative}`;
      for (const name of (await readdir(absolute)).sort()) {
        const child = relative === "" ? name : `${relative}/${name}`;
        const info = await lstat(`${directory}/${child}`);
        if (info.isSymbolicLink())
          entries.set(child, `link ${await readlink(`${directory}/${child}`)}`);
        else if (info.isDirectory()) {
          entries.set(child, "dir");
          await walk(child);
        } else
          entries.set(
            child,
            `file ${(info.mode & 0o777).toString(8)} ${createHash("sha256")
              .update(await readFile(`${directory}/${child}`))
              .digest("hex")}`,
          );
      }
    };
    await walk("");
    return entries;
  });

/** The paths whose entry differs between two snapshots, added, removed or changed. */
export const changedPaths = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): ReadonlyArray<string> =>
  [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();

/** Registers a second source built from a declaration and files, beside the world's own. */
export const addSource = (
  world: ImportWorld,
  name: string,
  declaration: string,
  files: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const root = yield* seedSource(`${world.base}/${name}`, { "tack.yaml": declaration, ...files });
    yield* registerSource(world.options, { sourcePath: root });
    return root;
  });

/** An `import add` request for the world's remote, with overrides. */
export const importRequest = (
  overrides: Partial<{
    location: string;
    into: string | undefined;
    skills: ReadonlyArray<string>;
    all: boolean;
    fullDepth: boolean;
  }> = {},
) => ({ location: "github:acme/skills", skills: [], all: false, fullDepth: false, ...overrides });
