import { Yaml } from "../../domain/runtime-neutral.ts";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ResourceKindSchema, resourceKinds } from "../../domain/resources/kinds.ts";
import { DocsAddressSchema } from "../../domain/sources/catalog-schema.ts";
import { SourceFindingSchema } from "../../domain/sources/source-check.ts";
import { SourceLabelSchema, type SourceDeclaration } from "../../domain/sources/source-schema.ts";
import { NextCommandsSchema } from "../../domain/hints/next-commands.ts";
import {
  sourceFolderKeys,
  type SourceFolderKey,
  type SourceFolders,
} from "../../domain/sources/source-folders.ts";
import { oneSkillMessage, Source, SourceStorageError } from "./source.ts";
import { declarationFileName } from "./declaration-file.ts";
import { declaredPathSyntaxIssue, resolveDeclaredPath } from "./declared-path.ts";
import { inspectDeclaration } from "./source-check.ts";
import { declarationReaching } from "./resource-declarations.ts";
import { isInside, isStrictlyInside } from "../../domain/identity/path-containment.ts";
import type { DeclaredSourceInspection } from "../../domain/sources/source-inspection.ts";
import { loadsNothing } from "../../domain/sources/declaration-facts.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";

/** One entry of the declaration `source add` would write, with what catalog discovery finds under it. */
const PlannedEntrySchema = Schema.Struct({
  kind: ResourceKindSchema,
  /** The declared folder; absent for a collection, whose folder is the source. */
  path: Schema.optionalKey(Schema.String),
  collection: Schema.optionalKey(Schema.Literal(true)),
  /** The docs name, which is the folder's own name. */
  name: Schema.optionalKey(Schema.String),
  /** The names of the resources the entry puts in the catalog, in code-unit order. */
  resources: Schema.Array(Schema.String),
  /** The entry's problems, as `tack check` reports them. */
  findings: Schema.Array(SourceFindingSchema),
});

/** The `source add` plan for a source without a declaration: the file its kind flags would create. */
export const SourceScaffoldPlanSchema = Schema.Struct({
  kind: Schema.Literal("source-scaffold"),
  sourcePath: Schema.String,
  /** The label the source would take, absent when a `SOURCE:NAME` reference would need its ID. */
  name: Schema.optionalKey(Schema.String),
  declarationPath: Schema.String,
  content: Schema.String,
  entries: Schema.Array(PlannedEntrySchema),
});

/** The plan as `source add` publishes it: the schema's fields only, without the declaration. */
export const scaffoldPlanJson = Schema.encodeSync(SourceScaffoldPlanSchema);

/** Why `source add` refuses the folders it was asked to declare, before it writes anything. */
export class SourceAddRequestError extends Schema.TaggedError<SourceAddRequestError>()(
  "SourceAddRequestError",
  {
    code: Schema.Literals([
      "declaration-flags-required",
      "declaration-exists",
      "declaration-flag-path-invalid",
      "declaration-docs-name-clash",
      "declaration-docs-name-invalid",
      "declaration-inside-source",
      "declaration-flags-conflict",
      "source-is-one-skill",
      "declaration-loads-nothing",
    ]),
    message: Schema.String,
    /** The commands the message names as the fix. */
    next: Schema.optionalKey(NextCommandsSchema),
  },
) {}

/** The flag that declares `key`: `--skills` for `skills`. */
const flagOf = (key: SourceFolderKey) => `--${key}`;

/** The folders as `/`-separated source-relative paths: a leading `./` and trailing `/` dropped. */
const normalize = (value: string) => value.replace(/^(\.\/)+/, "").replace(/\/+$/, "");

/**
 * The command that writes a previewed declaration: `source add` again with one kind flag per
 * planned entry, in the order the declaration lists them, `.` for a collection, and `--apply`.
 */
export const applyCommand = (plan: typeof SourceScaffoldPlanSchema.Type) => [
  "tack",
  "source",
  "add",
  plan.sourcePath,
  ...plan.entries.flatMap((entry) => [
    `--${resourceKinds[entry.kind].declarationKey}`,
    entry.path ?? ".",
  ]),
  "--apply",
];

/**
 * The plan that writes `declaration` at `root`, with what each of its entries finds. It keeps the
 * declaration, from which `source add` resolves the label the source would take.
 */
const planned = Effect.fnUntraced(function* (root: string, declaration: SourceDeclaration) {
  const path = yield* Path.Path;
  return {
    kind: SourceScaffoldPlanSchema.fields.kind.literal,
    sourcePath: root,
    declarationPath: path.join(root, declarationFileName),
    content: Yaml.stringify(declaration),
    entries: yield* inspectDeclaration(root, declaration),
    declaration,
  } satisfies typeof SourceScaffoldPlanSchema.Type & { readonly declaration: SourceDeclaration };
});

/** One folder flag once its path resolved inside the source. */
type ResolvedFlag = {
  readonly key: SourceFolderKey;
  readonly value: string;
  readonly path: string;
  readonly resolved: string;
};

/**
 * Refuses two `--skills`, `--commands` or `--context` folders that are equal or nested, the
 * overlap the declaration would quarantine. Flags carry no exclude, so every such pair overlaps.
 * Docs are never linked by name, so a docs folder may hold or equal any other.
 */
const refuseOverlappingFlags = Effect.fnUntraced(function* (flags: ReadonlyArray<ResolvedFlag>) {
  const path = yield* Path.Path;
  const owning = flags.filter((flag) => flag.key !== "docs");
  const pair = owning
    .flatMap((flag, index) => owning.slice(index + 1).map((other) => [flag, other] as const))
    .find(
      ([flag, other]) =>
        isInside(flag.resolved, other.resolved) === true ||
        isInside(other.resolved, flag.resolved) === true,
    );
  if (pair === undefined) return;
  const [first, second] = pair;
  const [outer, inner] = isStrictlyInside(second.resolved, first.resolved)
    ? [second, first]
    : [first, second];
  const exclude = path.relative(outer.resolved, inner.resolved).split(path.sep).join("/");
  yield* new SourceAddRequestError({
    code: "declaration-flags-conflict",
    message: `${flagOf(first.key)} ${first.value} and ${flagOf(second.key)} ${second.value} overlap, and each file may belong to one declaration. Keep one of them${exclude === "" ? "" : `, or write tack.yaml by hand with exclude: ["${exclude}/**"] on the ${outer.key} entry "${outer.path}"`}.`,
  });
});

/** Whether a flag value names the source folder itself: `.` or `./`. */
const namesSource = (value: string) => value.replace(/\/+$/, "") === ".";

/** Whether `.` can make a folder a collection of `key`: context needs a folder of a source. */
const formsCollection = (key: SourceFolderKey) => key !== "context";

/** The `source add` preview of `source` with `flags`. */
const sourceAdd = (source: string, ...flags: ReadonlyArray<string>) => [
  "tack",
  "source",
  "add",
  source,
  ...flags,
];

/** The key a folder's name says it holds: its declaration key or its kind, `skills` or `skill`. */
const keyNamedBy = (name: string) =>
  sourceFolderKeys.find(
    (key) =>
      key === name ||
      Object.entries(resourceKinds).some(
        ([kind, traits]) => kind === name && traits.declarationKey === key,
      ),
  );

/**
 * The previews that declare what a folder without tack.yaml holds, read from the folders at its top.
 * Skill folders there make it a skills collection, with a source of its own for each commands or
 * docs folder beside them; otherwise each folder named after a kind gets its flag. A placeholder
 * folder remains when neither is found. `source add` and `tack check` both suggest these.
 */
export const layoutCommands = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = (yield* fs.readDirectory(root))
    .filter((name) => name.startsWith(".") === false)
    .toSorted(compareCodeUnits);
  const folders = yield* Effect.filter(names, (name) =>
    fs.stat(path.join(root, name)).pipe(Effect.map((info) => info.type === "Directory")),
  );
  const skillFolders = yield* Effect.filter(folders, (name) =>
    fs.exists(path.join(root, name, "SKILL.md")),
  );
  const named = folders.flatMap((name) => {
    const key = keyNamedBy(name);
    return key === undefined ? [] : [{ key, name }];
  });
  if (skillFolders.length > 0)
    return [
      sourceAdd(root, "--skills", "."),
      ...named
        .filter((folder) => folder.key !== "skills" && formsCollection(folder.key) === true)
        .map((folder) => sourceAdd(path.join(root, folder.name), flagOf(folder.key), ".")),
    ];
  if (named.length > 0)
    return [
      sourceAdd(
        root,
        ...sourceFolderKeys.flatMap((key) =>
          named
            .filter((folder) => folder.key === key)
            .flatMap((folder) => [flagOf(key), folder.name]),
        ),
      ),
    ];
  return [sourceAdd(root, "--skills", "FOLDER")];
});

/**
 * The collection a `.` flag value asks for, or undefined when no flag names the source folder.
 * `.` makes the folder a skills, commands or docs collection, which declares nothing else, so it
 * cannot be combined with another flag. Context needs a folder of the source.
 */
const collectionDeclaration = Effect.fnUntraced(function* (root: string, folders: SourceFolders) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const values = sourceFolderKeys.flatMap((key) => folders[key].map((value) => ({ key, value })));
  const dotted = values.find((flag) => namesSource(flag.value));
  if (dotted === undefined) return undefined;
  const key = dotted.key;
  if (formsCollection(key) === false)
    return yield* new SourceAddRequestError({
      code: "declaration-flag-path-invalid",
      message: `--context ${dotted.value}: context needs a folder of the source, such as --context notes. Only skills, commands and docs can be a collection.`,
    });
  const others = values.filter((flag) => flag !== dotted);
  const otherCollection = others.find((flag) => namesSource(flag.value) === true);
  if (otherCollection !== undefined)
    return yield* new SourceAddRequestError({
      code: "declaration-flags-conflict",
      message: `${flagOf(key)} . and ${flagOf(otherCollection.key)} . would both make ${root} a collection, and a folder holds one. Keep one of them.`,
    });
  if (others.length > 0) {
    // Each other folder can be a collection of its own, except context, which needs a source's folder.
    const split = others.filter((flag) => formsCollection(flag.key) === true);
    const context = others.filter((flag) => formsCollection(flag.key) === false);
    const named = (flags: typeof others) =>
      new Intl.ListFormat("en").format(flags.map((flag) => normalize(flag.value)));
    return yield* new SourceAddRequestError({
      code: "declaration-flags-conflict",
      message: [
        `${flagOf(key)} . makes ${root} a ${key} collection, which declares nothing else.`,
        split.length === 0
          ? "Register the collection alone."
          : `Register the collection alone, and ${named(split)} as ${split.length === 1 ? "a source of its" : "sources of their"} own.`,
        ...(context.length === 0
          ? []
          : [
              `Context needs a folder of a source, so ${named(context)} cannot be a source of its own.`,
            ]),
      ].join(" "),
      next: [
        sourceAdd(root, flagOf(key), "."),
        ...split.map((flag) =>
          sourceAdd(path.join(root, normalize(flag.value)), flagOf(flag.key), "."),
        ),
      ],
    });
  }
  if (key === "skills" && (yield* fs.exists(path.join(root, "SKILL.md"))) === true)
    return yield* new SourceAddRequestError({
      code: "source-is-one-skill",
      message: oneSkillMessage(root),
    });
  if (key !== "docs") return { version: 1, kind: key } satisfies SourceDeclaration;
  const name = path.basename(root);
  if (Schema.is(SourceLabelSchema)(name) === false)
    return yield* new SourceAddRequestError({
      code: "declaration-docs-name-invalid",
      message: `The folder name "${path.basename(root)}" is no docs name: a docs collection is named after its folder, in lowercase letters, digits and hyphens. Rename the folder, or write tack.yaml by hand with its own name.`,
    });
  return { version: 1, kind: "docs", name } satisfies SourceDeclaration;
});

/**
 * Why `source add` does not write a previewed declaration: every entry has a problem and finds no
 * resource, so the source would load nothing. Undefined when the declaration loads anything.
 */
export const scaffoldLoadsNothing = (plan: typeof SourceScaffoldPlanSchema.Type) =>
  loadsNothing(
    plan.entries.map((entry) => ({
      resources: entry.resources.length,
      // A warning, such as folders a collection skips, never stops the declaration loading.
      problems: entry.findings.filter((finding) => finding.severity === "error"),
    })),
  )
    ? new SourceAddRequestError({
        code: "declaration-loads-nothing",
        message: `Every entry of the tack.yaml these flags declare has a problem and finds no resource, so ${plan.sourcePath} would load nothing. Fix the problems under each entry or name other folders, then preview again.`,
        // The preview: the apply command without its final --apply.
        next: [applyCommand(plan).slice(0, -1)],
      })
    : undefined;

/**
 * Plans the declaration `source add` writes from its kind flags. It returns undefined when the
 * source has its tack.yaml and no flag was given, so the source registers as it is. It refuses
 * flags on a source that has tack.yaml, and a source without one that no flag describes.
 */
export const planSourceScaffold = Effect.fn("sources.planSourceScaffold")(
  function* (sourcePath: string, folders: SourceFolders) {
    const sourceService = yield* Source;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // A tack.yaml, healthy or not, is the user's: flags never write over it.
    if (
      sourceFolderKeys.some((key) => folders[key].length > 0) &&
      (yield* fs.exists(path.join(path.resolve(sourcePath), declarationFileName))) === true
    )
      return yield* new SourceAddRequestError({
        code: "declaration-exists",
        message: `${path.resolve(sourcePath)} already has tack.yaml, and source add never writes over it. Edit tack.yaml by hand, or register the source as it is.`,
        next: [["tack", "source", "add", path.resolve(sourcePath)]],
      });
    const root = yield* sourceService.validate(sourcePath).pipe(
      Effect.map(() => undefined),
      Effect.catchTag("SourceValidationError", (error) =>
        error.code === "declaration-missing"
          ? Effect.succeed(error.sourcePath)
          : Effect.fail(error),
      ),
    );
    if (root === undefined) return undefined;
    if (sourceFolderKeys.every((key) => folders[key].length === 0))
      return yield* new SourceAddRequestError({
        code: "declaration-flags-required",
        message: `${root} has no tack.yaml. Name the folders it holds with --skills, --commands, --context or --docs, each a path inside it, or use --skills ., --commands . or --docs . alone when what it holds sits at its top, and source add previews the tack.yaml it writes.`,
        next: yield* layoutCommands(root),
      });
    const collection = yield* collectionDeclaration(root, folders);
    if (collection !== undefined) return yield* planned(root, collection);
    /** The entries one kind flag declares, each path checked to exist inside the source. */
    const declare = (key: SourceFolderKey) =>
      Effect.forEach(folders[key], (value) =>
        Effect.gen(function* () {
          const folder = normalize(value);
          const refuse = (reason: string) =>
            new SourceAddRequestError({
              code: "declaration-flag-path-invalid",
              message: `${flagOf(key)} ${value}: ${reason}`,
            });
          if (declaredPathSyntaxIssue(folder) !== undefined)
            return yield* refuse(
              "name a folder relative to the source, written with / and without . or .. segments.",
            );
          const resolved = yield* resolveDeclaredPath(root, folder);
          if (resolved.ok === false)
            return yield* refuse(
              resolved.code === "declaration-path-missing"
                ? `${path.join(root, folder)} does not exist.`
                : resolved.code === "declaration-path-outside-source"
                  ? `${path.join(root, folder)} resolves outside the source.`
                  : resolved.message,
            );
          return { key, value, path: folder, resolved: resolved.resolved } satisfies ResolvedFlag;
        }),
      );
    const flags = (yield* Effect.forEach(sourceFolderKeys, declare)).flat();
    yield* refuseOverlappingFlags(flags);
    const entriesOf = (key: SourceFolderKey) =>
      flags.filter((flag) => flag.key === key).map((flag) => ({ path: flag.path }));
    const declared = {
      skills: entriesOf("skills"),
      commands: entriesOf("commands"),
      context: entriesOf("context"),
      docs: entriesOf("docs").map((entry) => ({ name: path.basename(entry.path), ...entry })),
    } satisfies Record<SourceFolderKey, ReadonlyArray<{ readonly path: string }>>;
    const invalid = declared.docs.find(
      (entry) => Schema.is(DocsAddressSchema.fields.name)(entry.name) === false,
    );
    if (invalid !== undefined)
      return yield* new SourceAddRequestError({
        code: "declaration-docs-name-invalid",
        message: `The folder name "${invalid.name}" is no docs name: docs are named after their folder, in lowercase letters, digits and hyphens. Rename the folder, or write tack.yaml by hand with its own name.`,
      });
    const clash = declared.docs.flatMap((entry, index) => {
      const first = declared.docs.slice(0, index).find((other) => other.name === entry.name);
      return first === undefined ? [] : [{ first, entry }];
    })[0];
    if (clash !== undefined)
      return yield* new SourceAddRequestError({
        code: "declaration-docs-name-clash",
        message: `Both ${clash.first.path} and ${clash.entry.path} would be docs "${clash.entry.name}", and docs names must differ. Write tack.yaml by hand with a name for each.`,
      });
    const declaration = {
      version: 1,
      ...Object.fromEntries(
        sourceFolderKeys.flatMap((key) =>
          declared[key].length === 0 ? [] : [[key, declared[key]]],
        ),
      ),
    } satisfies SourceDeclaration;
    return yield* planned(root, declaration);
  },
  (effect, sourcePath) =>
    effect.pipe(
      Effect.mapError((error) =>
        "code" in error
          ? error
          : new SourceStorageError({
              code: "source-access-failed",
              message: error.message,
              operation: "plan source declaration",
              path: sourcePath,
            }),
      ),
    ),
);

/**
 * Refuses a `tack.yaml` at `folder` that a registered source's declaration reaches: the file would
 * take the folder out of that source, which would then report its entry. The fix is in the
 * registered source, so the refusal names it.
 */
export const refuseScaffoldInsideSources = Effect.fnUntraced(function* (
  folder: string,
  inspections: ReadonlyArray<DeclaredSourceInspection>,
) {
  const reaches = yield* Effect.forEach(inspections, (inspection) =>
    inspection.status === "unhealthy"
      ? Effect.succeed(undefined)
      : declarationReaching(inspection.registration, inspection.declaration, folder).pipe(
          Effect.map((reach) => (reach === undefined ? undefined : { inspection, reach })),
        ),
  );
  const found = reaches.find((reaching) => reaching !== undefined);
  if (found === undefined) return;
  const { inspection, reach } = found;
  const owner = inspection.label ?? inspection.registration.id;
  yield* new SourceAddRequestError({
    code: "declaration-inside-source",
    message:
      "holds" in reach
        ? `${folder} holds the ${reach.holds} of source ${owner}. A tack.yaml here would take that entry out of ${owner}. Remove the entry from ${owner} first, then repeat.`
        : `${folder} is inside the ${reach.walks} of source ${owner}. A tack.yaml here would take this folder out of ${owner}. Add exclude: ["${reach.exclude}/**"] to that entry first, then repeat.`,
  });
});

/** Creates a previewed declaration exclusively, including when another process creates it first. */
export const writeSourceScaffold = Effect.fn("sources.writeSourceScaffold")(function* (
  plan: NonNullable<Effect.Success<ReturnType<typeof planSourceScaffold>>>,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(plan.declarationPath, plan.content, { flag: "wx" }).pipe(
    Effect.mapError(
      (error) =>
        new SourceStorageError({
          code: "declaration-access-failed",
          message: error.message,
          operation: "create source declaration without overwriting",
          path: plan.declarationPath,
        }),
    ),
  );
});
