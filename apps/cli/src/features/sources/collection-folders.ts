import { Effect, FileSystem, Path } from "effect";
import { docsWalkSkips, marksSourceEdge } from "@tackup/reader/source-edges";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";

/** The entries of a folder, or undefined when it is no folder or cannot be listed. */
const listed = (fs: FileSystem.FileSystem, folder: string) =>
  fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => undefined));

/**
 * The folders at the top of a skills collection that are not skills, in code-unit order: each
 * folder there without `SKILL.md`. Dot, underscore and `node_modules` folders and folders that are
 * other sources are never named: the collection passes over them on purpose.
 */
export const nonSkillCollectionFolders = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = ((yield* listed(fs, root)) ?? [])
    .filter((name) => docsWalkSkips(name) === false)
    .toSorted(compareCodeUnits);
  return yield* Effect.filter(names, (name) =>
    listed(fs, path.join(root, name)).pipe(
      Effect.map(
        (entries) =>
          entries !== undefined &&
          entries.includes("SKILL.md") === false &&
          marksSourceEdge(entries) === false,
      ),
    ),
  );
});

/** Why a skills collection ignores `folder`, and how to make it a skill. */
export const nonSkillFolderMessage = (folder: string) =>
  `${folder}/ holds no SKILL.md, so it is not a skill, and a skills collection holds skills only: Tack ignores it. Add a SKILL.md to make it a skill.`;
