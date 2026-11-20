import { Effect, FileSystem, Path } from "effect";

/** The folder names a source root uses for each resource kind by convention. */
const kindFolders = ["skills", "commands", "context", "scripts"] as const;
type KindFolder = (typeof kindFolders)[number];

/**
 * Lists the kind folders at a source root, so a declaration with no resource key can tell a source
 * that forgot to declare its folders from one that holds nothing.
 */
export const kindFoldersAt = Effect.fnUntraced(function* (sourceRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const present = yield* Effect.forEach(kindFolders, (folder) =>
    fs.stat(path.join(sourceRoot, folder)).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.catch(() => Effect.succeed(false)),
    ),
  );
  return kindFolders.filter((_folder, index) => present[index] === true);
});

/** The entry that declares one kind folder. */
const entryFor = (folder: KindFolder) =>
  folder === "scripts"
    ? "scripts: [{ name: <name>, path: scripts/<file>.ts, description: <text> }]"
    : `${folder}: [{ path: ${folder} }]`;

/**
 * Builds the advice for a source that has no resource key but holds kind folders. It names each
 * folder and the entry that declares it. Tack writes nothing.
 */
export const undeclaredFoldersMessage = (folders: ReadonlyArray<KindFolder>): string => {
  const optOut = `${folders[0] ?? "skills"}: []`;
  return `Tack reads resources only from declarations, and this tack.yaml declares none. Found ${folders.map((folder) => `\`${folder}/\``).join(", ")}. Add ${folders.map((folder) => `\`${entryFor(folder)}\``).join(", ")}. If a folder is ordinary content, declare it empty instead, such as \`${optOut}\`.`;
};
