import { Effect, FileSystem, Path, Schema } from "effect";
import { importedKey, type ImportedSkillSchema } from "../../domain/sources/catalog-report.ts";
import type { Catalog } from "../../domain/sources/catalog-schema.ts";
import { DeclarationFactsSchema, loadsNothing } from "../../domain/sources/declaration-facts.ts";
import {
  HealthySourceInspectionSchema,
  UnhealthySourceInspectionSchema,
  type DeclaredSourceInspection,
} from "../../domain/sources/source-inspection.ts";
import { inspectSourcesWithDeclarations } from "../sources/catalog.ts";
import type { StateOptions } from "../../services/state-store.ts";
import { readInvocationSnapshot } from "../snapshot/command-snapshot.ts";
import { observeImports, summarizeImport } from "./import-inspect.ts";
import type { ImportProblem, ImportSummary } from "../../domain/imports/import-schema.ts";

/** What `source` says about the imports of one source: counts, and what needs a look. */
const SourceImportFactsSchema = Schema.Struct({
  /** Imported skills the source's imports section records. */
  total: Schema.Number,
  /** Imported skills whose folder differs from its record. Editing is allowed: information. */
  locallyChanged: Schema.Number,
  /** Imported skills whose folder is gone. */
  missing: Schema.Number,
  /** Imported skills present on disk that the catalog does not hold at that folder. */
  uncataloged: Schema.Number,
  /** Whether the imports section does not decode. */
  invalid: Schema.Boolean,
  /** Whether an interrupted write left its staging folder. */
  stagingLeftOver: Schema.Boolean,
});

/** What `source` says about the imports of one source: counts, and what needs a look. */
export type SourceImportFacts = typeof SourceImportFactsSchema.Type;

/**
 * The `source` payload: each source's health, what each declaration of a healthy source
 * contributes, and the imports of a source that has any.
 */
export const SourceListPayloadSchema = Schema.Struct({
  kind: Schema.Literal("source-inspections"),
  sources: Schema.Array(
    Schema.Union([
      Schema.Struct({
        ...HealthySourceInspectionSchema.fields,
        declarations: Schema.Array(DeclarationFactsSchema),
        imports: Schema.optionalKey(SourceImportFactsSchema),
      }),
      Schema.Struct({
        ...UnhealthySourceInspectionSchema.fields,
        imports: Schema.optionalKey(SourceImportFactsSchema),
      }),
    ]),
  ),
});

/** One source as `source` reports it. */
export type SourceListEntry = (typeof SourceListPayloadSchema.Type)["sources"][number];

/**
 * Whether `source` reports a source as broken: it validated, but every declaration has a problem
 * and finds no resource, so it loads nothing.
 */
export const sourceLoadsNothing = (source: SourceListEntry) =>
  source.status === "healthy" && loadsNothing(source.declarations);

/** Everything the offline displays show about imports, computed once from one catalog. */
export type ImportsDisplay = {
  readonly imports: ReadonlyArray<ImportSummary>;
  readonly problems: ReadonlyArray<ImportProblem>;
  /** Imported skills by {@link importedKey}, for the catalog's `imported` tag and details. */
  readonly byDirectory: ReadonlyMap<string, typeof ImportedSkillSchema.Type>;
  /** Counts for each source that has imports or an import problem. */
  readonly bySource: ReadonlyMap<string, SourceImportFacts>;
};

/**
 * Observes the imports of every healthy registered source, offline, with the same facts `import`
 * lists. A missing folder, an unreadable imports section and a leftover staging folder are
 * problems; local changes are not.
 */
export const observeImportsDisplay = Effect.fnUntraced(function* (
  inspections: ReadonlyArray<DeclaredSourceInspection>,
  catalog: Pick<Catalog, "entries">,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const observed = yield* observeImports(inspections);
  const summaries = yield* Effect.forEach(observed.imports, (item) =>
    summarizeImport(item, catalog),
  );
  const keyed = yield* Effect.forEach(observed.imports, (item) => {
    const folder = path.join(item.inspection.registration.canonicalPath, item.record.path);
    return fileSystem.realPath(folder).pipe(
      Effect.orElseSucceed(() => folder),
      Effect.map((real) => importedKey(item.inspection.registration.id, real)),
    );
  });
  const byDirectory = new Map(
    summaries.flatMap(
      (summary, index): ReadonlyArray<readonly [string, typeof ImportedSkillSchema.Type]> => {
        const key = keyed[index];
        return key === undefined
          ? []
          : [
              [
                key,
                {
                  path: summary.path,
                  location: summary.location,
                  ref: summary.ref,
                  revision: summary.revision,
                  local: summary.local.state,
                },
              ],
            ];
      },
    ),
  );
  const registrationIds = [
    ...new Set([
      ...summaries.map((summary) => summary.registrationId),
      ...observed.problems.map((problem) => problem.registrationId),
    ]),
  ];
  const bySource = new Map(
    registrationIds.map((id): readonly [string, SourceImportFacts] => {
      const own = summaries.filter((summary) => summary.registrationId === id);
      const conditions = (code: ImportSummary["conditions"][number]["code"]) =>
        own.filter((summary) => summary.conditions.some((condition) => condition.code === code))
          .length;
      const problems = observed.problems.filter((problem) => problem.registrationId === id);
      return [
        id,
        {
          total: own.length,
          locallyChanged: conditions("import-locally-changed"),
          missing: conditions("import-folder-missing"),
          uncataloged: conditions("import-folder-not-cataloged"),
          invalid: problems.some((problem) => problem.code === "imports-invalid"),
          stagingLeftOver: problems.some((problem) => problem.code === "staging-left-over"),
        },
      ];
    }),
  );
  return {
    imports: summaries,
    problems: observed.problems,
    byDirectory,
    bySource,
  } satisfies ImportsDisplay;
});

/**
 * Resolves the catalog and the imports display from one read of the sources, so the `imported`
 * tags and the counts agree with the catalog they describe.
 */
export const resolveCatalogWithImports = Effect.fn("imports.resolveCatalogWithImports")(function* (
  stateOptions: StateOptions,
) {
  const snapshot = yield* readInvocationSnapshot(stateOptions);
  const inspections = yield* snapshot.sourceInspections;
  const catalog = yield* snapshot.catalog;
  const display = yield* observeImportsDisplay(inspections, catalog);
  return { inspections, catalog, display };
});

/** Lists every source with its declarations and, when it has any, its imports. */
export const listSources = Effect.fn("imports.listSources")(function* (stateOptions: StateOptions) {
  const { catalog, display } = yield* resolveCatalogWithImports(stateOptions);
  return inspectSourcesWithDeclarations(catalog).map((source): SourceListEntry => {
    const facts = display.bySource.get(source.registration.id);
    return facts === undefined ? source : { ...source, imports: facts };
  });
});
