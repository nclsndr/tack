import { Effect, FileSystem, Path, Result } from "effect";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { resolveCatalogFromInspections } from "../sources/catalog.ts";
import type { Catalog } from "../../domain/sources/catalog-schema.ts";
import { inspectSourcesFromState } from "../sources/source.ts";
import { type DeclaredSourceInspection } from "../../domain/sources/source-inspection.ts";
import type { State } from "../../domain/state/state-schema.ts";
import { sourceDisplayName, type HealthyInspection } from "./import-destination.ts";
import type { ImportRecord } from "../../domain/imports/import-record.ts";
import type {
  ImportList,
  ImportProblem,
  ImportState,
  ImportSummary,
} from "../../domain/imports/import-schema.ts";
import { hasLeftoverStaging } from "./import-write.ts";
import { readImportsSection } from "./imports-section.ts";
import { compareFolderToRecord, localChangeSummary, type LocalChange } from "./local-change.ts";
import { readDeclarationText } from "../sources/declaration-file.ts";

/** An import record with the source it lives in, ready to display or act on. */
export type SourceImport = {
  readonly inspection: HealthyInspection;
  readonly record: ImportRecord;
  /** The skill's name: the last segment of the record's folder. */
  readonly name: string;
  readonly reference: string;
};

const noChanges = {
  added: [],
  removed: [],
  changed: [],
  executable: [],
  special: [],
} as const;

/** The plain, JSON-safe form of a local-change comparison. */
export const importStateOf = (change: LocalChange): ImportState =>
  change.state === "changed"
    ? { ...change, state: "changed" }
    : { ...noChanges, state: change.state };

const isHealthy = (inspection: DeclaredSourceInspection): inspection is HealthyInspection =>
  inspection.status === "healthy" && inspection.origin !== "builtin";

/** What reading every source's imports found: the records and the sources that cannot be read. */
type ImportsObservation = {
  readonly imports: ReadonlyArray<SourceImport>;
  readonly problems: ReadonlyArray<ImportProblem>;
};

/**
 * Reads the imports section of every healthy registered source, offline. A source whose section
 * does not decode, or that holds a staging folder left by an interrupted write, is a problem; the
 * other sources are unaffected.
 */
export const observeImports = Effect.fnUntraced(function* (
  inspections: ReadonlyArray<DeclaredSourceInspection>,
) {
  const observed = yield* Effect.forEach(inspections.filter(isHealthy), (inspection) =>
    Effect.gen(function* () {
      const name = sourceDisplayName(inspection);
      const root = inspection.registration.canonicalPath;
      const text = yield* readDeclarationText(root).pipe(Effect.orElseSucceed(() => ""));
      const section = readImportsSection(text);
      const leftover = yield* hasLeftoverStaging(root);
      const problems: ReadonlyArray<ImportProblem> = [
        ...(Result.isFailure(section)
          ? [
              {
                source: name,
                registrationId: inspection.registration.id,
                code: "imports-invalid" as const,
                message: `The imports section of ${root}/tack.yaml (line ${section.failure.line}): ${section.failure.message}`,
              },
            ]
          : []),
        ...(leftover
          ? [
              {
                source: name,
                registrationId: inspection.registration.id,
                code: "staging-left-over" as const,
                message: `${root}/.tack-import-staging holds an interrupted import write. The next \`tack import add --into ${name} --apply\` or \`tack import remove <reference> --apply\` finishes or rolls it back.`,
              },
            ]
          : []),
      ];
      const imports = Result.isSuccess(section)
        ? section.success.records.map((record): SourceImport => {
            const skillName = record.path.split("/").at(-1) ?? record.path;
            return { inspection, record, name: skillName, reference: `${name}:${skillName}` };
          })
        : [];
      return { imports, problems };
    }),
  );
  return {
    imports: observed
      .flatMap((entry) => entry.imports)
      .sort(
        (left, right) =>
          compareCodeUnits(left.reference, right.reference) ||
          compareCodeUnits(left.record.path, right.record.path),
      ),
    problems: observed.flatMap((entry) => entry.problems),
  } satisfies ImportsObservation;
});

/** Whether the catalog holds a skill at exactly this folder of the source. */
const cataloged = (catalog: Pick<Catalog, "entries">, sourceId: string, folder: string) =>
  catalog.entries.some(
    (entry) =>
      entry.sourceRegistrationId === sourceId &&
      entry.address.kind === "skill" &&
      entry.directoryPath === folder,
  );

/** Summarizes one imported skill: its record, its local state and what is wrong with it. */
export const summarizeImport = Effect.fnUntraced(function* (
  item: SourceImport,
  catalog: Pick<Catalog, "entries">,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { record, inspection } = item;
  const folder = path.join(inspection.registration.canonicalPath, record.path);
  const change = yield* compareFolderToRecord(folder, record);
  const real = yield* fileSystem.realPath(folder).pipe(Effect.orElseSucceed(() => folder));
  const present = change.state !== "missing";
  const conditions: ImportSummary["conditions"] = [
    ...(present
      ? []
      : [
          {
            code: "import-folder-missing" as const,
            message: `${record.path} is gone. Move it back, or run \`tack import remove ${item.reference} --apply\` to drop the record.`,
          },
        ]),
    ...(present && cataloged(catalog, inspection.registration.id, real) === false
      ? [
          {
            code: "import-folder-not-cataloged" as const,
            message: `${record.path} is not a skill of ${sourceDisplayName(inspection)}'s catalog: no skills entry covers it, a pattern excludes it, or its name clashes. Check its tack.yaml skills entry.`,
          },
        ]
      : []),
    ...(change.state === "changed"
      ? [
          {
            code: "import-locally-changed" as const,
            message: localChangeSummary(change),
          },
        ]
      : []),
  ];
  return {
    reference: item.reference,
    name: item.name,
    source: sourceDisplayName(inspection),
    registrationId: inspection.registration.id,
    path: record.path,
    location: record.location,
    transport: record.transport,
    ref: {
      kind: record["ref-kind"],
      ...(record.ref === undefined ? {} : { request: record.ref }),
      tracking: record["ref-kind"] === "default" || record["ref-kind"] === "branch",
    },
    revision: record.revision,
    upstreamPath: record["upstream-path"],
    importedAt: record["imported-at"],
    local: importStateOf(change),
    conditions,
  } satisfies ImportSummary;
});

/** The `import` listing: every imported skill of every registered source, offline. */
export const inspectImports = Effect.fn("imports.inspectImports")(function* (state: State) {
  const inspections = yield* inspectSourcesFromState(state);
  const catalog = yield* resolveCatalogFromInspections(inspections);
  const observed = yield* observeImports(inspections);
  const imports = yield* Effect.forEach(observed.imports, (item) => summarizeImport(item, catalog));
  return { kind: "import-list", imports, problems: observed.problems } satisfies ImportList;
});
