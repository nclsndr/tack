import { Effect, FileSystem, Option, Path, Result, Schema } from "effect";
import { Installation } from "../../services/installation.ts";
import { importStagingFolderName } from "../sources/resource-declarations.ts";
import { ImportError } from "./import-error.ts";
import { writeSkillFiles, type SkillFile } from "./import-files.ts";
import { ImportRecordSchema, type ImportRecord } from "../../domain/imports/import-record.ts";
import { editImportsSection, readImportsSection } from "./imports-section.ts";
import { compareFolderToRecord } from "./local-change.ts";
import { declarationFileName, readDeclarationText } from "../sources/declaration-file.ts";

/** One skill an apply writes: its files, the folder it lands in and its record. */
export type StagedImport = {
  readonly name: string;
  /** The skill folder relative to the source root. */
  readonly path: string;
  readonly files: ReadonlyArray<SkillFile>;
  readonly record: ImportRecord;
  /** Group folders the apply creates for it, outermost first. */
  readonly newFolders: ReadonlyArray<string>;
};

/** One skill a removal deletes: its folder, when it exists, and its record. */
export type RemovedImport = {
  readonly path: string;
  readonly record: ImportRecord;
  readonly folderPresent: boolean;
};

const intentFileName = "intent.json";
const intentVersion = 1;

const IntentItemSchema = Schema.Struct({
  index: Schema.Number,
  path: Schema.String,
  record: ImportRecordSchema,
  newFolders: Schema.Array(Schema.String),
});

const IntentSchema = Schema.Struct({
  version: Schema.Literal(intentVersion),
  operation: Schema.Literals(["add", "remove"]),
  items: Schema.Array(IntentItemSchema),
});

type Intent = typeof IntentSchema.Type;

const decodeIntent = Schema.decodeUnknownResult(Schema.fromJsonString(IntentSchema));

/** The steps of a write at which the test hook can end the process. */
export const crashSteps = ["intent", "staged", "moved", "tack-yaml"] as const;

/** Ends the process at a named step, for crash-recovery tests; see `Installation.crashPoint`. */
const crashPoint = (step: (typeof crashSteps)[number]) =>
  Installation.use((installation) => installation.crashPoint(step));

const writeFailure = (message: string) => new ImportError({ code: "import-write-failed", message });

/** The staging folder of a source root. */
export const stagingPathOf = (root: string) => `${root}/${importStagingFolderName}`;

/** Reports whether a source root holds a staging folder left by an interrupted write. */
export const hasLeftoverStaging = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.exists(stagingPathOf(root)).pipe(Effect.orElseSucceed(() => false));
});

/** Removes each folder, deepest first, only while it is empty, as `rmdir` does; failures are ignored. */
const removeEmptyFolders = Effect.fnUntraced(function* (
  root: string,
  folders: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* Effect.forEach(
    [...folders].reverse(),
    (folder) =>
      fileSystem.readDirectory(`${root}/${folder}`).pipe(
        Effect.flatMap((entries) =>
          entries.length === 0
            ? fileSystem.remove(`${root}/${folder}`, { recursive: true })
            : Effect.void,
        ),
        Effect.ignore,
      ),
    { discard: true },
  );
});

const removeTree = Effect.fnUntraced(function* (target: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(target, { recursive: true, force: true }).pipe(Effect.ignore);
});

/**
 * Rewrites the imports section of the source's `tack.yaml` through a temporary file in the staging
 * folder and one rename, keeping the file's permissions. `change` receives the current records.
 */
const rewriteTackYaml = Effect.fnUntraced(function* (
  root: string,
  change: (records: ReadonlyArray<ImportRecord>) => ReadonlyArray<ImportRecord>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(root, declarationFileName);
  const text = yield* readDeclarationText(root).pipe(
    Effect.mapError(() => writeFailure(`Tack could not read ${target}.`)),
  );
  const section = readImportsSection(text);
  if (Result.isFailure(section))
    return yield* new ImportError({
      code: "import-records-invalid",
      message: `The imports section of ${target} (line ${section.failure.line}): ${section.failure.message}`,
    });
  const edited = editImportsSection(text, change(section.success.records));
  if (Result.isFailure(edited))
    return yield* new ImportError({
      code: "import-records-invalid",
      message: `The imports section of ${target} (line ${edited.failure.line}): ${edited.failure.message}`,
    });
  if (edited.success === text) return false;
  const info = yield* fileSystem
    .stat(target)
    .pipe(Effect.mapError(() => writeFailure(`Tack could not read ${target}.`)));
  const staging = stagingPathOf(root);
  const temporary = path.join(staging, "tack.yaml.new");
  yield* fileSystem.makeDirectory(staging, { recursive: true });
  yield* fileSystem.writeFileString(temporary, edited.success);
  yield* fileSystem.chmod(temporary, info.mode & 0o777);
  yield* fileSystem.rename(temporary, target);
  return true;
});

const recordsAfter = (
  current: ReadonlyArray<ImportRecord>,
  added: ReadonlyArray<ImportRecord>,
  removed: ReadonlyArray<string>,
): ReadonlyArray<ImportRecord> => [
  ...current.filter(
    (record) =>
      removed.includes(record.path) === false && added.every((other) => other.path !== record.path),
  ),
  ...added,
];

const writeIntent = Effect.fnUntraced(function* (staging: string, intent: Intent) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(
    path.join(staging, intentFileName),
    `${JSON.stringify(Schema.encodeSync(IntentSchema)(intent), undefined, 2)}\n`,
  );
});

const stagedFolder = (staging: string, area: "new" | "old", index: number) =>
  `${staging}/${area}/${index}`;

/**
 * Finishes or rolls back an interrupted write for one source root, then removes its staging
 * folder. A skill folder that reached its place and still matches its record is kept and its record
 * written; anything not yet moved is rolled back. Returns a line per skill it settled.
 */
export const recoverStaging = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const staging = stagingPathOf(root);
  if ((yield* hasLeftoverStaging(root)) === false) return [] as ReadonlyArray<string>;
  const intentText = yield* fileSystem
    .readFileString(path.join(staging, intentFileName))
    .pipe(Effect.option);
  const intent = Option.isSome(intentText) ? decodeIntent(intentText.value) : undefined;
  if (intent === undefined || Result.isFailure(intent)) {
    // No usable intent means nothing was moved yet: the staging folder holds only scratch.
    yield* removeTree(staging);
    return ["Removed the staging folder of an interrupted write that had not changed anything."];
  }
  const { operation, items } = intent.success;
  const settled = yield* Effect.forEach(items, (item) =>
    Effect.gen(function* () {
      const target = path.join(root, item.path);
      const present = yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
      if (operation === "add") {
        const kept =
          present && (yield* compareFolderToRecord(target, item.record)).state === "unchanged";
        return { item, completed: kept };
      }
      const moved = yield* fileSystem
        .exists(stagedFolder(staging, "old", item.index))
        .pipe(Effect.orElseSucceed(() => false));
      return { item, completed: moved || present === false };
    }),
  );
  const completed = settled.filter((entry) => entry.completed).map((entry) => entry.item);
  const rolledBack = settled
    .filter((entry) => entry.completed === false)
    .map((entry) => entry.item);
  yield* rewriteTackYaml(root, (records) =>
    operation === "add"
      ? recordsAfter(
          records,
          completed.map((item) => item.record),
          [],
        )
      : recordsAfter(
          records,
          [],
          completed.map((item) => item.path),
        ),
  );
  yield* removeEmptyFolders(
    root,
    rolledBack.flatMap((item) => (operation === "add" ? item.newFolders : [])),
  );
  yield* removeTree(staging);
  return [
    ...completed.map((item) =>
      operation === "add"
        ? `Finished the interrupted import of ${item.path}.`
        : `Finished the interrupted removal of ${item.path}.`,
    ),
    ...rolledBack.map((item) =>
      operation === "add"
        ? `Rolled back the interrupted import of ${item.path}.`
        : `Rolled back the interrupted removal of ${item.path}.`,
    ),
  ];
});

/**
 * Writes imported skills with the safe order: intent, staged and verified folders, moves into
 * place, one rewrite of `tack.yaml`, then the staging folder is deleted. Returns the paths written.
 */
export const writeImports = Effect.fnUntraced(function* (
  root: string,
  items: ReadonlyArray<StagedImport>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const staging = stagingPathOf(root);
  const targets = items.map((item) => path.join(root, item.path));
  const cleanup = Effect.gen(function* () {
    yield* removeEmptyFolders(
      root,
      items.flatMap((item) => item.newFolders),
    );
    yield* removeTree(staging);
  });
  const moved: Array<string> = [];
  let ownsStaging = false;
  const body = Effect.gen(function* () {
    if (yield* hasLeftoverStaging(root))
      return yield* new ImportError({
        code: "import-staging-conflict",
        message: `${staging} is left over from an interrupted write. Run the command again with --apply to finish or roll it back first.`,
      });
    yield* fileSystem.makeDirectory(staging, { recursive: true });
    ownsStaging = true;
    yield* writeIntent(staging, {
      version: intentVersion,
      operation: "add",
      items: items.map((item, index) => ({
        index,
        path: item.path,
        record: item.record,
        newFolders: item.newFolders,
      })),
    });
    yield* crashPoint("intent");
    for (const [index, item] of items.entries()) {
      const folder = stagedFolder(staging, "new", index);
      yield* writeSkillFiles(folder, item.files);
      const verified = yield* compareFolderToRecord(folder, item.record);
      if (verified.state !== "unchanged")
        return yield* writeFailure(
          `The staged copy of ${item.name} does not match what was fetched. Nothing was changed; repeat the command.`,
        );
    }
    yield* crashPoint("staged");
    for (const [index, item] of items.entries()) {
      const target = targets[index] ?? "";
      if (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false)))
        return yield* writeFailure(
          `${item.path} appeared while the import ran. Nothing was overwritten.`,
        );
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* fileSystem
        .rename(stagedFolder(staging, "new", index), target)
        .pipe(
          Effect.mapError(() =>
            writeFailure(
              `Tack could not move the staged copy of ${item.name} into ${item.path}. The staging folder and the destination must be on one volume. Nothing was changed.`,
            ),
          ),
        );
      moved.push(target);
    }
    yield* crashPoint("moved");
    yield* rewriteTackYaml(root, (records) =>
      recordsAfter(
        records,
        items.map((item) => item.record),
        [],
      ),
    );
    yield* crashPoint("tack-yaml");
    yield* removeTree(staging);
    return items.map((item) => item.path);
  });
  return yield* body.pipe(
    Effect.onError(() =>
      // A failure before any move changed nothing: undo this write's staging, never a leftover
      // one. After a move, leave the intent so the next command settles it.
      ownsStaging === true && moved.length === 0 ? cleanup : Effect.void,
    ),
  );
});

/**
 * Deletes imported skill folders and their records with the safe order: intent, folder moved into
 * staging, one rewrite of `tack.yaml`, then the staging folder is deleted.
 */
export const removeImports = Effect.fnUntraced(function* (
  root: string,
  items: ReadonlyArray<RemovedImport>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const staging = stagingPathOf(root);
  const moving = items.filter((item) => item.folderPresent);
  if (moving.length > 0) {
    if (yield* hasLeftoverStaging(root))
      return yield* new ImportError({
        code: "import-staging-conflict",
        message: `${staging} is left over from an interrupted write. Run the command again with --apply to finish or roll it back first.`,
      });
    yield* fileSystem.makeDirectory(staging, { recursive: true });
    yield* writeIntent(staging, {
      version: intentVersion,
      operation: "remove",
      items: moving.map((item, index) => ({
        index,
        path: item.path,
        record: item.record,
        newFolders: [],
      })),
    });
    yield* crashPoint("intent");
    for (const [index, item] of moving.entries()) {
      const destination = stagedFolder(staging, "old", index);
      yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fileSystem
        .rename(path.join(root, item.path), destination)
        .pipe(
          Effect.mapError(() =>
            writeFailure(
              `Tack could not move ${item.path} into the staging folder. Nothing was deleted.`,
            ),
          ),
        );
    }
    yield* crashPoint("moved");
  }
  yield* rewriteTackYaml(root, (records) =>
    recordsAfter(
      records,
      [],
      items.map((item) => item.path),
    ),
  );
  yield* crashPoint("tack-yaml");
  yield* removeTree(staging);
  return items.map((item) => item.path);
});
