import { Effect, FileSystem, Option, Path } from "effect";
import { docsWalkSkips, marksSourceEdge } from "@tackup/reader/source-edges";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { isStrictlyInside } from "../../domain/identity/path-containment.ts";

/** The folder name that says it holds commands, which a skills collection never reads. */
const commandsFolderName = "commands";

/** The entries of a folder, or undefined when it cannot be listed. */
const listed = (fs: FileSystem.FileSystem, folder: string) =>
  fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Whether a folder holds `SKILL.md` anywhere below it, within `root`. The walk passes over the
 * names a docs walk skips and over folders that are other sources, and visits each folder once.
 */
const holdsSkillBelow = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  folder: string,
  visited: Set<string>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const canonical = yield* fs.realPath(folder).pipe(Effect.orElseSucceed(() => undefined));
    if (canonical === undefined || isStrictlyInside(root, canonical) === false) return false;
    if (visited.has(canonical) === true) return false;
    visited.add(canonical);
    const names = yield* listed(fs, canonical);
    if (names === undefined || marksSourceEdge(names) === true) return false;
    if (names.includes("SKILL.md") === true) return true;
    return yield* Effect.findFirst(
      names.filter((name) => docsWalkSkips(name) === false),
      (name) => holdsSkillBelow(fs, path, root, path.join(canonical, name), visited),
    ).pipe(Effect.map(Option.isSome));
  });

/**
 * The folders at the top of a skills collection that hold what the collection skips, in code-unit
 * order: a `commands` folder, and a folder without `SKILL.md` that holds one further down. Dot,
 * underscore and `node_modules` folders and folders that are other sources are never named: the
 * collection passes over them on purpose.
 */
export const skippedCollectionFolders = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = ((yield* listed(fs, root)) ?? [])
    .filter((name) => docsWalkSkips(name) === false)
    .toSorted(compareCodeUnits);
  return yield* Effect.filter(names, (name) =>
    Effect.gen(function* () {
      const folder = path.join(root, name);
      const entries = yield* listed(fs, folder);
      // A file, a skill folder the collection reads, or another source is nothing it skips.
      if (
        entries === undefined ||
        entries.includes("SKILL.md") === true ||
        marksSourceEdge(entries) === true
      )
        return false;
      return (
        name === commandsFolderName || (yield* holdsSkillBelow(fs, path, root, folder, new Set()))
      );
    }),
  );
});

/**
 * Why a skills collection skips `folders`, and what to do instead: the list form, or a source of
 * their own for each.
 */
export const skippedFoldersMessage = (folders: ReadonlyArray<string>) => {
  const named = new Intl.ListFormat("en").format(folders.map((folder) => `${folder}/`));
  return folders.length === 1
    ? `This skills collection reads only the skill folders at its top, so Tack skips ${named}, which holds what a collection cannot. Declare it with the list form in tack.yaml, a skills or commands entry for each folder, or make it a source of its own with its own tack.yaml.`
    : `This skills collection reads only the skill folders at its top, so Tack skips ${named}, which hold what a collection cannot. Declare them with the list form in tack.yaml, a skills or commands entry for each folder, or make each a source of its own with its own tack.yaml.`;
};
