import { Effect, FileSystem, PlatformError } from "effect";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { sha256Hex, type ImportRecord } from "../../domain/imports/import-record.ts";

/** Operating-system files that never count as a local change, at any depth. */
const ignoredNames: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db"]);

/**
 * How an imported skill folder compares with its record. Only the record is consulted: the paths,
 * SHA-256 digests and executable bits Tack wrote. Every list is sorted by code units.
 */
export type LocalChange =
  | { readonly state: "missing" }
  | { readonly state: "unchanged" }
  | {
      readonly state: "changed";
      readonly added: ReadonlyArray<string>;
      readonly removed: ReadonlyArray<string>;
      readonly changed: ReadonlyArray<string>;
      /** Files whose executable bit differs from the record. */
      readonly executable: ReadonlyArray<string>;
      /** Symbolic links and other entries that are not regular files; import never writes one. */
      readonly special: ReadonlyArray<string>;
    };

type Observed = {
  readonly files: ReadonlyMap<string, { readonly sha256: string; readonly executable: boolean }>;
  readonly special: ReadonlyArray<string>;
};

type Entry = "directory" | "file" | "special";

/**
 * What kind of entry `path` is, without following a symbolic link: a link is `special`, as is
 * anything Tack cannot inspect. A missing entry fails with `NotFound`.
 */
const entryKind = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.readLink(path).pipe(
    Effect.as<Entry>("special"),
    Effect.catch(() =>
      fileSystem.stat(path).pipe(
        Effect.map((info): Entry => {
          if (info.type === "Directory") return "directory";
          return info.type === "File" ? "file" : "special";
        }),
      ),
    ),
  );

const observe = Effect.fnUntraced(function* (folder: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const files = new Map<string, { sha256: string; executable: boolean }>();
  const special: Array<string> = [];
  const walk = (relative: string): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const directory = relative.length === 0 ? folder : `${folder}/${relative}`;
      const entries = (yield* fileSystem.readDirectory(directory)).sort(compareCodeUnits);
      for (const name of entries) {
        if (ignoredNames.has(name)) continue;
        const entryPath = relative.length === 0 ? name : `${relative}/${name}`;
        const kind = yield* entryKind(fileSystem, `${folder}/${entryPath}`);
        if (kind === "directory") yield* walk(entryPath);
        else if (kind === "file") {
          const read = yield* Effect.all([
            fileSystem.readFile(`${folder}/${entryPath}`),
            fileSystem.stat(`${folder}/${entryPath}`),
          ]).pipe(Effect.option);
          if (read._tag === "None") special.push(entryPath);
          else
            files.set(entryPath, {
              sha256: sha256Hex(read.value[0]),
              executable: (read.value[1].mode & 0o111) !== 0,
            });
        } else special.push(entryPath);
      }
    });
  const root = yield* entryKind(fileSystem, folder).pipe(Effect.result);
  if (root._tag === "Failure")
    return root.failure.reason._tag === "NotFound" ? undefined : { files, special: ["."] };
  if (root.success !== "directory") return { files, special: ["."] };
  // A folder Tack cannot read is not the folder it wrote.
  yield* walk("").pipe(Effect.catch(() => Effect.sync(() => special.push("."))));
  return { files, special } satisfies Observed;
});

/** Compares an imported skill folder with its record, offline and without version control. */
export const compareFolderToRecord = (
  folder: string,
  record: ImportRecord,
): Effect.Effect<LocalChange, never, FileSystem.FileSystem> =>
  observe(folder).pipe(
    Effect.map((observed): LocalChange => {
      if (observed === undefined) return { state: "missing" };
      const recorded = new Map(record.files.map((file) => [file.path, file]));
      const special = new Set(observed.special);
      const sorted = (values: ReadonlyArray<string>) => [...values].sort(compareCodeUnits);
      const added = sorted(
        [...observed.files.keys()].filter((path) => recorded.has(path) === false),
      );
      const removed = sorted(
        [...recorded.keys()].filter(
          (path) => observed.files.has(path) === false && special.has(path) === false,
        ),
      );
      const present = [...observed.files].flatMap(([path, found]) => {
        const expected = recorded.get(path);
        return expected === undefined ? [] : [{ path, found, expected }];
      });
      const changed = sorted(
        present
          .filter((entry) => entry.found.sha256 !== entry.expected.sha256)
          .map((entry) => entry.path),
      );
      const executable = sorted(
        present
          .filter(
            (entry) =>
              entry.found.sha256 === entry.expected.sha256 &&
              entry.found.executable !== entry.expected.executable,
          )
          .map((entry) => entry.path),
      );
      const result = {
        state: "changed" as const,
        added,
        removed,
        changed,
        executable,
        special: sorted(observed.special),
      };
      return localChangeCount(result) === 0 ? { state: "unchanged" } : result;
    }),
  );

/** The number of paths that differ from the record; zero for unchanged and missing folders. */
export const localChangeCount = (change: LocalChange): number =>
  change.state === "changed"
    ? change.added.length +
      change.removed.length +
      change.changed.length +
      change.executable.length +
      change.special.length
    : 0;

/** A one-line summary such as `SKILL.md changed · notes.md added`, for human output. */
export const localChangeSummary = (change: LocalChange): string => {
  if (change.state === "unchanged") return "unchanged";
  if (change.state === "missing") return "folder missing";
  const parts: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
    [change.changed, "changed"],
    [change.added, "added"],
    [change.removed, "removed"],
    [change.executable, "executable bit changed"],
    [change.special, "not a regular file"],
  ];
  return parts
    .flatMap(([paths, verb]) => (paths.length === 0 ? [] : [`${paths.join(", ")} ${verb}`]))
    .join(" · ");
};
