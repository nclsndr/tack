import { Yaml } from "../../domain/runtime-neutral.ts";
import { Effect, FileSystem, Path, Predicate, Schema } from "effect";
import { ResourceKindSchema, resourceKinds } from "../../domain/resources/kinds.ts";
import { SourceFindingSchema, type SourceFinding } from "../../domain/sources/source-check.ts";
import {
  declarationResourceKeys,
  sourceDeclarationVersion,
  sourceFolderPath,
  SourceValidationErrorCodeSchema,
  suggestedSourceName,
  type SourceDeclaration,
} from "../../domain/sources/source-schema.ts";
import { NextCommandsSchema } from "../../domain/hints/next-commands.ts";
import { fieldLine } from "../../domain/sources/field-line.ts";
import { Source, SourceStorageError, validateDeclaration } from "./source.ts";
import { declarationFileName } from "./declaration-file.ts";
import { inspectValidatedSource } from "./source-check.ts";
import { declarationReaching } from "./resource-declarations.ts";
import type { DeclaredSourceInspection } from "../../domain/sources/source-inspection.ts";
import { loadsNothing } from "../../domain/sources/declaration-facts.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";

/** One entry of the declaration `source add` would write, with what catalog discovery finds under it. */
const PlannedEntrySchema = Schema.Struct({
  kind: ResourceKindSchema,
  /** The declared folder or file, `.` for the source folder itself. */
  path: Schema.optionalKey(Schema.String),
  /** The docs name. */
  name: Schema.optionalKey(Schema.String),
  /** The names of the resources the entry puts in the catalog, in code-unit order. */
  resources: Schema.Array(Schema.String),
  /** The entry's problems, as `tack check` reports them, at their line in the submitted config. */
  findings: Schema.Array(SourceFindingSchema),
});

/** Where `source add --config` read its JSON: the flag's own value, or standard input for `-`. */
const ConfigOriginSchema = Schema.Literals(["argument", "standard-input"]);

/** The `source add --config` plan for a source without a declaration: the file it would create. */
export const SourceScaffoldPlanSchema = Schema.Struct({
  kind: Schema.Literal("source-scaffold"),
  sourcePath: Schema.String,
  /** The label the source would take, absent when a `SOURCE:NAME` reference would need its ID. */
  name: Schema.optionalKey(Schema.String),
  /** Where the JSON was read; `--apply` reads the same JSON from the same place again. */
  config: ConfigOriginSchema,
  declarationPath: Schema.String,
  /** The tack.yaml `--apply` writes: the decoded config, normalized to YAML. */
  content: Schema.String,
  entries: Schema.Array(PlannedEntrySchema),
  /** The findings of the declaration as a whole: its profile publications and its warnings. */
  findings: Schema.Array(SourceFindingSchema),
});

/** The plan as `source add` publishes it: the schema's fields only, without the declaration. */
export const scaffoldPlanJson = Schema.encodeSync(SourceScaffoldPlanSchema);

/** Why `source add` refuses to plan or write a declaration, before it writes anything. */
export class SourceAddRequestError extends Schema.TaggedError<SourceAddRequestError>()(
  "SourceAddRequestError",
  {
    code: Schema.Literals([
      "declaration-config-required",
      "declaration-exists",
      "declaration-inside-source",
      "declaration-loads-nothing",
      "config-unreadable",
      "config-not-json",
      "config-imports-not-allowed",
    ]),
    message: Schema.String,
    /** The commands the message names as the fix. */
    next: Schema.optionalKey(NextCommandsSchema),
  },
) {}

/**
 * A submitted config that does not validate: each issue `tack check` would report for the same
 * declaration, at its field and its line in the submitted text when it has them.
 */
export class SourceConfigInvalidError extends Schema.TaggedError<SourceConfigInvalidError>()(
  "SourceConfigInvalidError",
  {
    code: SourceValidationErrorCodeSchema,
    /** Where the JSON was read. */
    config: ConfigOriginSchema,
    issues: Schema.Array(
      Schema.Struct({
        field: Schema.optionalKey(Schema.String),
        message: Schema.String,
        line: Schema.optionalKey(Schema.Number),
      }),
    ),
  },
) {}

/** The JSON `source add --config` read, and where from. */
export type SourceConfig = {
  readonly text: string;
  readonly origin: typeof ConfigOriginSchema.Type;
};

/** The guide that lists every key a tack.yaml takes. */
const tackYamlGuide = ["tack", "guide", "tack-yaml"];

/**
 * The plan that writes a validated declaration at its source, with what each of its entries finds.
 * It keeps the declaration, from which `source add` resolves the label the source would take.
 * A finding on the declaration's field is located at its line in the submitted config.
 */
const planned = Effect.fnUntraced(function* (
  validated: Effect.Success<ReturnType<typeof validateDeclaration>>,
  config: SourceConfig,
) {
  const path = yield* Path.Path;
  const root = validated.canonicalPath;
  const declarationPath = path.join(root, declarationFileName);
  const { entries, findings } = yield* inspectValidatedSource(validated);
  const located = (finding: SourceFinding): SourceFinding =>
    finding.file === declarationPath && finding.field !== undefined
      ? { ...finding, line: fieldLine(config.text, finding.field) }
      : finding;
  return {
    kind: SourceScaffoldPlanSchema.fields.kind.literal,
    sourcePath: root,
    config: config.origin,
    declarationPath,
    content: Yaml.stringify(validated.declaration),
    entries: entries.map((entry) => ({ ...entry, findings: entry.findings.map(located) })),
    findings: findings.map(located),
    declaration: validated.declaration,
  } satisfies typeof SourceScaffoldPlanSchema.Type & { readonly declaration: SourceDeclaration };
});

/** The key a folder's name says it holds: its declaration key or its kind, `skills` or `skill`. */
const keyNamedBy = (name: string) =>
  declarationResourceKeys.find(
    (key) =>
      key === name ||
      Object.entries(resourceKinds).some(
        ([kind, traits]) => kind === name && traits.declarationKey === key,
      ),
  );

/**
 * The declarations a folder without tack.yaml suggests, read from the folders at its top. Skill
 * folders there make it a folder of skills, declared as the skills entry `.`, and each commands
 * or docs folder beside them a source of its own, declared the same way; otherwise each folder
 * named after a kind gets an entry. A placeholder folder remains when neither is found. Each is
 * named after its folder, or `NAME` when the folder suggests no name.
 */
const layoutDeclarations = Effect.fnUntraced(function* (root: string) {
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
  const head = (folder: string) => ({
    version: sourceDeclarationVersion,
    name: suggestedSourceName(path.basename(folder)) ?? "NAME",
  });
  if (skillFolders.length > 0)
    return [
      { folder: root, declaration: { ...head(root), skills: [{ path: sourceFolderPath }] } },
      ...named.flatMap(({ key, name }): ReadonlyArray<{ folder: string; declaration: object }> => {
        const own = head(name);
        return key === "commands"
          ? [
              {
                folder: path.join(root, name),
                declaration: { ...own, commands: [{ path: sourceFolderPath }] },
              },
            ]
          : key === "docs"
            ? [
                {
                  folder: path.join(root, name),
                  declaration: { ...own, docs: [{ name: own.name, path: sourceFolderPath }] },
                },
              ]
            : [];
      }),
    ];
  if (named.length > 0)
    return [
      {
        folder: root,
        declaration: {
          ...head(root),
          ...Object.fromEntries(
            declarationResourceKeys.flatMap((key) => {
              const entries = named
                .filter((folder) => folder.key === key)
                // A docs folder is found by its name, `docs`, which is also a docs name.
                .map(({ name }) => (key === "docs" ? { name, path: name } : { path: name }));
              return entries.length === 0 ? [] : [[key, entries]];
            }),
          ),
        },
      },
    ];
  return [{ folder: root, declaration: { ...head(root), skills: [{ path: "FOLDER" }] } }];
});

/**
 * How to declare a folder without tack.yaml: write its declaration as JSON for
 * `source add --config`, starting from what its layout suggests, and the guide that lists every
 * key. `source add` and `tack check` both give it.
 */
export const declarationAdvice = Effect.fnUntraced(function* (root: string) {
  const suggested = yield* layoutDeclarations(root);
  const suggestions = suggested.map(({ folder, declaration }) =>
    folder === root
      ? JSON.stringify(declaration)
      : `${JSON.stringify(declaration)} for ${folder} as a source of its own`,
  );
  return {
    advice: `Write its tack.yaml as JSON and preview it with tack source add ${root} --config 'JSON', or --config - to read it from standard input; tack guide tack-yaml lists every key. Its layout suggests ${new Intl.ListFormat("en").format(suggestions)}.`,
    next: [tackYamlGuide],
  };
});

/**
 * Why `source add` does not write a previewed declaration: every entry has a problem and finds no
 * resource, so the source would load nothing. Undefined when the declaration loads anything.
 */
export const scaffoldLoadsNothing = (plan: typeof SourceScaffoldPlanSchema.Type) =>
  loadsNothing(
    plan.entries.map((entry) => ({
      resources: entry.resources.length,
      // A warning never stops the declaration loading.
      problems: entry.findings.filter((finding) => finding.severity === "error"),
    })),
  )
    ? new SourceAddRequestError({
        code: "declaration-loads-nothing",
        message: `Every entry of the tack.yaml this config declares has a problem and finds no resource, so ${plan.sourcePath} would load nothing. Fix the problems under each entry, then preview again.`,
      })
    : undefined;

/**
 * Plans the declaration `source add --config` writes. It returns undefined when the source has its
 * tack.yaml and no config was given, so the source registers as it is. It refuses a config for a
 * source that has tack.yaml, and a source without one that no config describes. A config is JSON,
 * names no `imports`, and validates as `tack check` validates the tack.yaml it would write.
 */
export const planSourceScaffold = Effect.fn("sources.planSourceScaffold")(
  function* (sourcePath: string, config: SourceConfig | undefined) {
    const sourceService = yield* Source;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // A tack.yaml, healthy or not, is the user's: a config never writes over it.
    if (
      config !== undefined &&
      (yield* fs.exists(path.join(path.resolve(sourcePath), declarationFileName))) === true
    )
      return yield* new SourceAddRequestError({
        code: "declaration-exists",
        message: `${path.resolve(sourcePath)} already has tack.yaml, and source add never writes over it. Edit tack.yaml by hand and run tack check, or register the source as it is.`,
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
    if (config === undefined) {
      const { advice, next } = yield* declarationAdvice(root);
      return yield* new SourceAddRequestError({
        code: "declaration-config-required",
        message: `${root} has no tack.yaml. ${advice}`,
        next,
      });
    }
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(config.text),
      catch: (cause) =>
        new SourceAddRequestError({
          code: "config-not-json",
          message: `--config takes the declaration as JSON, or - to read it from standard input: ${String(cause)}. tack guide tack-yaml lists every key.`,
          next: [tackYamlGuide],
        }),
    });
    if (Predicate.hasProperty(parsed, "imports") === true)
      return yield* new SourceAddRequestError({
        code: "config-imports-not-allowed",
        message:
          "--config cannot declare imports: tack import add writes that key when it imports a skill. Remove it, register the source, then import with tack import add.",
      });
    const validated = yield* validateDeclaration(root, {
      text: config.text,
      parsed,
      format: "json",
    }).pipe(
      Effect.mapError(
        (error) =>
          new SourceConfigInvalidError({
            code: error.code,
            config: config.origin,
            issues: error.issues ?? [{ message: error.message }],
          }),
      ),
    );
    return yield* planned(validated, config);
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
