import { Effect, FileSystem, Path } from "effect";
import type { Catalog } from "../../domain/sources/catalog-schema.ts";
import { patternSelector } from "../sources/resource-declarations.ts";
import { skillFolderPath, type ImportDestination } from "./import-destination.ts";
import type { ImportCandidate } from "../../domain/imports/import-schema.ts";
import type { ImportRecord } from "../../domain/imports/import-record.ts";
import { sameLocation, type ImportProvider } from "../../domain/imports/providers/provider.ts";
import type { NextCommands } from "../../domain/hints/next-commands.ts";

/**
 * What the destination says about importing one skill name into it, when it refuses, and the
 * commands its message names as the way past the refusal.
 */
export type DestinationVerdict = {
  readonly code: string;
  readonly message: string;
  readonly next?: NextCommands;
};

/** The facts of the location an import comes from, to recognise an earlier import of it. */
export type ImportOrigin = {
  /** `<provider>:<text>`, without a ref or folder. */
  readonly location: string;
  /** The provider that decides whether a record names the same repository. */
  readonly provider: ImportProvider;
  readonly revision: string;
};

const shortRevision = (revision: string) => revision.slice(0, 12);

/** Removing the earlier import of a skill, which an import of it from another revision needs first. */
const removeImport = (source: string, name: string) => [
  "tack",
  "import",
  "remove",
  `${source}:${name}`,
  "--apply",
];

/** Whether the declaration covering the destination selects the new skill folder by pattern. */
export const declarationSelects = (
  destination: ImportDestination,
  name: string,
): string | undefined => {
  const { covering, folder } = destination;
  const relative =
    folder === covering.declaredPath
      ? name
      : `${folder.slice(covering.declaredPath.length + 1)}/${name}`;
  const { prunedFolder, selected } = patternSelector(covering.include, covering.exclude);
  const excludedDirectory = prunedFolder(relative.split("/").slice(0, -1).join("/"));
  if (excludedDirectory === undefined && selected(relative) === true) return undefined;
  const include =
    covering.include === undefined ? "" : ` include ${JSON.stringify(covering.include)},`;
  const exclude =
    covering.exclude === undefined ? "" : ` exclude ${JSON.stringify(covering.exclude)}`;
  return `The skills entry ${JSON.stringify(covering.declaredPath)} does not select ${skillFolderPath(destination.folder, name)}:${include}${exclude}. Choose another folder, or change the patterns by hand.`;
};

/**
 * The destination's verdict for one candidate name: the destination's catalog, its imports section
 * and its patterns decide, so the verdict equals what the catalog does after a manual copy.
 */
export const destinationVerdict = Effect.fnUntraced(function* (input: {
  readonly destination: ImportDestination;
  readonly catalog: Pick<Catalog, "entries" | "quarantined">;
  readonly records: ReadonlyArray<ImportRecord>;
  readonly origin: ImportOrigin;
  readonly candidate: Pick<ImportCandidate, "name" | "folder">;
}): Effect.fn.Return<DestinationVerdict | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { destination, catalog, records, origin, candidate } = input;
  const { name } = candidate;
  const target = skillFolderPath(destination.folder, name);
  const own = destination.inspection.registration.id;
  const relativeOf = (directory: string) =>
    path.relative(destination.root, directory).split(path.sep).join("/");
  const existing = [
    ...catalog.entries
      .filter(
        (entry) =>
          entry.sourceRegistrationId === own &&
          entry.address.kind === "skill" &&
          entry.address.name === name,
      )
      .map((entry) => entry.directoryPath),
    ...catalog.quarantined
      .filter(
        (entry) =>
          entry.sourceRegistrationId === own &&
          entry.candidateKind === "skill" &&
          path.basename(entry.directoryPath) === name,
      )
      .map((entry) => entry.directoryPath),
  ].map(relativeOf);
  const record = records.find((other) => other.path === target);
  if (record !== undefined && sameLocation(origin.provider, record.location, origin.location)) {
    return record.revision === origin.revision
      ? {
          code: "import-already-imported",
          message: `${target} is already imported from ${record.location} at ${shortRevision(record.revision)}. Nothing to do.`,
        }
      : {
          code: "import-already-imported",
          message: `${target} is already imported from ${record.location} at ${shortRevision(record.revision)}. Import never moves an existing import; run \`${removeImport(destination.name, name).join(" ")}\` first to import it again.`,
          next: [removeImport(destination.name, name)],
        };
  }
  if (record !== undefined)
    return {
      code: "import-imported-elsewhere",
      message: `${target} is already imported from ${record.location}. Choose another destination, or remove that import first.`,
    };
  const [first] = existing;
  if (first !== undefined)
    return {
      code: "import-name-in-destination",
      message: `${destination.name} already has a skill named ${name} at ${first}. Two skills with one name quarantine each other, so choose another destination, or remove that skill first.`,
    };
  const occupied = yield* fileSystem
    .exists(path.join(destination.root, target))
    .pipe(Effect.orElseSucceed(() => false));
  if (occupied)
    return {
      code: "import-path-exists",
      message: `${target} already exists and is not a skill. Import never writes into an existing path; choose another destination or move it away.`,
    };
  const unselected = declarationSelects(destination, name);
  return unselected === undefined
    ? undefined
    : { code: "import-folder-not-selected", message: unselected };
});
