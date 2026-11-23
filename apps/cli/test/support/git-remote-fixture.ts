import { Effect, FileSystem, Path } from "effect";
import { runGit } from "./tack-process.ts";

/** One path in a fixture commit. A `null` entry deletes the path. */
type FixtureEntry =
  | string
  | Uint8Array
  | { readonly content: string | Uint8Array; readonly executable?: boolean }
  | { readonly symlink: string }
  | { readonly submodule: string };

export type FixtureCommit = {
  readonly files: Readonly<Record<string, FixtureEntry | null>>;
  readonly branch?: string;
  readonly tag?: string;
  /** An annotated tag instead of a lightweight one. */
  readonly annotated?: boolean;
  readonly message?: string;
};

type RemoteFixture = {
  /** The directory holding `<owner>/<repo>.git` bare repositories. */
  readonly root: string;
  readonly path: string;
  /** The commit ID of each fixture commit, in order. */
  readonly revisions: ReadonlyArray<string>;
};

const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com"];

/**
 * Creates one bare repository at `<root>/<owner>/<repo>.git` from a list of commits, with real
 * branches and tags. The server side allows partial and by-ID fetches, as GitHub does.
 */
export const makeRemoteFixture = Effect.fnUntraced(function* (
  root: string,
  owner: string,
  repo: string,
  commits: ReadonlyArray<FixtureCommit>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bare = path.join(root, owner, `${repo}.git`);
  const work = path.join(root, "work", owner, repo);
  yield* fileSystem.makeDirectory(work, { recursive: true });
  yield* fileSystem.makeDirectory(bare, { recursive: true });
  yield* runGit(work, ["init", "--quiet", "--initial-branch=main"]);
  yield* runGit(bare, ["init", "--quiet", "--bare", "--initial-branch=main"]);
  yield* runGit(bare, ["config", "uploadpack.allowFilter", "true"]);
  yield* runGit(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const revisions: string[] = [];
  for (const [index, commit] of commits.entries()) {
    if (commit.branch !== undefined)
      yield* runGit(work, ["checkout", "--quiet", "-B", commit.branch]);
    const submodules: Array<readonly [string, string]> = [];
    for (const [file, entry] of Object.entries(commit.files)) {
      const target = path.join(work, file);
      if (entry === null) {
        yield* runGit(work, ["rm", "-rf", "--quiet", "--ignore-unmatch", "--", file]);
        continue;
      }
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      if (typeof entry === "string") yield* fileSystem.writeFileString(target, entry);
      else if (entry instanceof Uint8Array) yield* fileSystem.writeFile(target, entry);
      else if ("symlink" in entry) {
        yield* fileSystem.remove(target, { force: true });
        yield* fileSystem.symlink(entry.symlink, target);
      } else if ("submodule" in entry) submodules.push([file, entry.submodule]);
      else {
        if (typeof entry.content === "string")
          yield* fileSystem.writeFileString(target, entry.content);
        else yield* fileSystem.writeFile(target, entry.content);
        if (entry.executable === true) yield* fileSystem.chmod(target, 0o755);
      }
    }
    yield* runGit(work, ["add", "-A"]);
    for (const [file, revision] of submodules)
      yield* runGit(work, ["update-index", "--add", "--cacheinfo", `160000,${revision},${file}`]);
    yield* runGit(work, [
      ...identity,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      commit.message ?? `commit ${index + 1}`,
    ]);
    const revision = (yield* runGit(work, ["rev-parse", "HEAD"])).stdout.trim();
    revisions.push(revision);
    if (commit.tag !== undefined)
      yield* runGit(
        work,
        commit.annotated === true
          ? [...identity, "tag", "-a", "-m", commit.tag, commit.tag]
          : ["tag", commit.tag],
      );
  }
  yield* runGit(work, ["push", "--quiet", bare, "--all"]);
  yield* runGit(work, ["push", "--quiet", bare, "--tags"]);
  const head = commits.find((commit) => commit.branch === undefined || commit.branch === "main");
  if (head !== undefined) yield* runGit(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, path: bare, revisions } satisfies RemoteFixture;
});
