import { Effect, FileSystem, Path } from "effect";
import { parseSkillDocument, parseCommandDocument } from "./resource-frontmatter.ts";
import { discoverSource, catalogQuarantine, type ResourceCandidate } from "./catalog-discovery.ts";
import {
  declarationFacts,
  type DeclarationFacts,
  type DeclarationRecord,
} from "../../domain/sources/declaration-facts.ts";
import {
  catalogEntryPath,
  type Catalog,
  type CatalogEntry,
  type CatalogQuarantine,
} from "../../domain/sources/catalog-schema.ts";
import { publicSourceInspection } from "./source.ts";
import {
  type DeclaredSourceInspection,
  type SourceInspection,
} from "../../domain/sources/source-inspection.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import {
  projectSourcesSkillName,
  reservedSkillNames,
} from "../../domain/generated/sources-skill.ts";

export type { Catalog } from "../../domain/sources/catalog-schema.ts";

/** A source inspection; a healthy one also lists what each of its declarations contributes. */
export type SourceDeclarationsView =
  | (Extract<SourceInspection, { status: "healthy" }> & {
      readonly declarations: ReadonlyArray<DeclarationFacts>;
    })
  | Extract<SourceInspection, { status: "unhealthy" }>;

/** What every entry parsed from a candidate carries, whatever its kind. */
type EntryCommon = {
  readonly declaredPath?: string;
  readonly directoryPath: string;
  readonly sourcePath: string;
  readonly sourceRegistrationId: string;
};

type CandidateKind = ResourceCandidate["kind"];
type CandidateOf<K extends CandidateKind> = Extract<ResourceCandidate, { readonly kind: K }>;
type CandidateParser<Candidate extends ResourceCandidate> = (
  candidate: Candidate,
  common: EntryCommon,
) => Effect.Effect<CatalogEntry | CatalogQuarantine, never, FileSystem.FileSystem | Path.Path>;

/**
 * Reads a skill or command document and parses it, or quarantines the candidate under the given
 * code when the document cannot be read.
 */
const parseDocument = Effect.fnUntraced(function* (
  candidate: CandidateOf<"skill"> | CandidateOf<"command">,
  common: EntryCommon,
  unreadable: CatalogQuarantine["code"],
  parse: (encoded: string) => Effect.Effect<CatalogEntry | CatalogQuarantine>,
) {
  const fs = yield* FileSystem.FileSystem;
  const encoded = yield* fs.readFileString(candidate.filePath).pipe(
    Effect.map((value) => ({ value }) as const),
    Effect.catch((error) => Effect.succeed({ error } as const)),
  );
  if ("error" in encoded)
    return catalogQuarantine(
      candidate.source,
      common.directoryPath,
      unreadable,
      encoded.error.message,
      candidate.address,
      candidate.filePath,
      candidate.kind,
    );
  return yield* parse(encoded.value);
});

/** How a candidate of each kind becomes a catalog entry, or a quarantine when it is not valid. */
const candidateParsers: {
  readonly [K in CandidateKind]: CandidateParser<CandidateOf<K>>;
} = {
  skill: Effect.fnUntraced(function* (candidate, common) {
    const path = yield* Path.Path;
    const { source, filePath, address } = candidate;
    return yield* parseDocument(candidate, common, "skill-file-unreadable", (encoded) =>
      parseSkillDocument({ directoryName: path.basename(common.directoryPath), encoded }).pipe(
        Effect.map(({ name, ...metadata }): CatalogEntry => ({
          ...common,
          ...metadata,
          address: { kind: "skill", name, sourceRegistrationId: source.id },
          skillFilePath: filePath,
        })),
        Effect.catch((error) =>
          Effect.succeed({
            ...catalogQuarantine(
              source,
              common.directoryPath,
              error.code,
              error.message,
              address,
              undefined,
              "skill",
            ),
            skillFilePath: filePath,
            ...(error.field === undefined ? {} : { field: error.field }),
          }),
        ),
      ),
    );
  }),
  command: (candidate, common) => {
    const { source, filePath, address } = candidate;
    return parseDocument(candidate, common, "resource-unreadable", (encoded) =>
      address === undefined
        ? Effect.succeed(
            catalogQuarantine(
              source,
              common.directoryPath,
              "command-name-invalid",
              "A command filename must have a valid portable name.",
              undefined,
              filePath,
              "command",
            ),
          )
        : parseCommandDocument(encoded).pipe(
            Effect.map((metadata): CatalogEntry => ({
              ...common,
              ...metadata,
              address: { ...address, kind: "command" },
              filePath,
            })),
            Effect.catch((error) =>
              Effect.succeed(
                catalogQuarantine(
                  source,
                  common.directoryPath,
                  error.code,
                  error.message,
                  address,
                  filePath,
                ),
              ),
            ),
          ),
    );
  },
  context: Effect.fnUntraced(function* (candidate, common) {
    const fs = yield* FileSystem.FileSystem;
    const { source, filePath, address } = candidate;
    return yield* fs.access(filePath, { readable: true }).pipe(
      Effect.map((): CatalogEntry => ({
        ...common,
        address: { ...address, kind: "context" },
        filePath,
      })),
      Effect.catch((error) =>
        Effect.succeed(
          catalogQuarantine(
            source,
            common.directoryPath,
            "resource-unreadable",
            error.message,
            address,
            filePath,
          ),
        ),
      ),
    );
  }),
  script: (candidate, common) =>
    Effect.succeed({
      ...common,
      address: { ...candidate.address, kind: "script" as const },
      declaredPath: candidate.declaredPath,
      filePath: candidate.filePath,
      description: candidate.description,
    } satisfies CatalogEntry),
};

/** The parser of one kind, typed so that a candidate of that kind is its only argument. */
const candidateParserOf = <K extends CandidateKind>(kind: K): CandidateParser<CandidateOf<K>> =>
  candidateParsers[kind];

/** Parses one candidate with the parser of its kind. */
const parseCandidate = Effect.fnUntraced(function* (candidate: ResourceCandidate) {
  const path = yield* Path.Path;
  return yield* candidateParserOf(candidate.kind)(candidate, {
    declaredPath: candidate.declaredPath,
    directoryPath: path.dirname(candidate.filePath),
    sourcePath: candidate.source.canonicalPath,
    sourceRegistrationId: candidate.source.id,
  });
});
const entryOrder = (left: CatalogEntry, right: CatalogEntry) =>
  compareCodeUnits(left.sourcePath, right.sourcePath) ||
  compareCodeUnits(catalogEntryPath(left), catalogEntryPath(right));
const quarantineOrder = (left: CatalogQuarantine, right: CatalogQuarantine) =>
  compareCodeUnits(
    `${left.sourcePath}\0${left.directoryPath}\0${left.code}`,
    `${right.sourcePath}\0${right.directoryPath}\0${right.code}`,
  );

/**
 * Quarantines a source skill named like a skill Tack generates: its link would take the place of
 * the generated one in every agent's skills folder.
 */
const reserveGeneratedNames = (
  candidate: ResourceCandidate,
  parsed: CatalogEntry | CatalogQuarantine,
): CatalogEntry | CatalogQuarantine =>
  "code" in parsed ||
  parsed.address.kind !== "skill" ||
  reservedSkillNames.includes(parsed.address.name) === false
    ? parsed
    : catalogQuarantine(
        candidate.source,
        parsed.directoryPath,
        "skill-name-reserved",
        `Tack reserves the skill name ${parsed.address.name} for the skill it generates for ${parsed.address.name === projectSourcesSkillName ? "each project" : "the user"}. Rename this skill.`,
        parsed.address,
        undefined,
        "skill",
      );

/** Resolves the unified resource catalog for one validated source-inspection snapshot. */
export const resolveCatalog = Effect.fnUntraced(function* (
  inspections: ReadonlyArray<DeclaredSourceInspection>,
): Effect.fn.Return<Catalog, never, FileSystem.FileSystem | Path.Path> {
  const entries: Array<CatalogEntry> = [];
  const quarantined: Array<CatalogQuarantine> = [];
  /** The declaration that put each entry in, so counts and problems reach the right row. */
  const declarationOf = new Map<CatalogEntry, DeclarationRecord>();
  const recordsOf = new Map<string, ReadonlyArray<DeclarationRecord>>();
  const unhealthySources: Array<Catalog["unhealthySources"][number]> = [];
  for (const inspection of [...inspections].sort((left, right) =>
    compareCodeUnits(left.registration.canonicalPath, right.registration.canonicalPath),
  )) {
    if (inspection.status === "unhealthy") {
      unhealthySources.push(inspection);
      continue;
    }
    const discovery = yield* discoverSource(inspection.registration, inspection.declaration);
    const docs = discovery.docs;
    docs.entries.forEach((entry, index) => {
      const added =
        inspection.origin === undefined ? entry : { ...entry, origin: inspection.origin };
      entries.push(added);
      const record = docs.owners[index];
      if (record !== undefined) declarationOf.set(added, record);
    });
    quarantined.push(...docs.quarantined);
    quarantined.push(...discovery.quarantined);
    for (const candidate of discovery.candidates) {
      const parsed = reserveGeneratedNames(candidate, yield* parseCandidate(candidate));
      if ("code" in parsed) {
        quarantined.push(parsed);
        candidate.record.problems.push({
          code: parsed.code,
          message: parsed.message,
          candidatePath: parsed.skillFilePath ?? parsed.filePath ?? parsed.directoryPath,
        });
      } else {
        const added: CatalogEntry =
          inspection.origin === undefined ? parsed : { ...parsed, origin: inspection.origin };
        entries.push(added);
        declarationOf.set(added, candidate.record);
      }
    }
    recordsOf.set(inspection.registration.id, [...discovery.records, ...docs.records]);
  }
  const groups = entries.reduce((grouped, entry) => {
    const key = JSON.stringify([
      entry.sourceRegistrationId,
      entry.address.kind,
      entry.address.name,
    ]);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    return grouped;
  }, new Map<string, ReadonlyArray<CatalogEntry>>());
  const duplicateEntries = [...groups.values()].filter((group) => group.length > 1).flat();
  const duplicates = new Set(duplicateEntries);
  const duplicateQuarantines = duplicateEntries.map((entry) => {
    const quarantine = catalogQuarantine(
      { canonicalPath: entry.sourcePath, id: entry.sourceRegistrationId },
      entry.directoryPath,
      entry.address.kind === "skill" ? "skill-address-duplicate" : "resource-address-duplicate",
      "More than one valid resource has the same exact address.",
      entry.address,
      catalogEntryPath(entry),
    );
    declarationOf.get(entry)?.problems.push({
      code: quarantine.code,
      message: quarantine.message,
      candidatePath: catalogEntryPath(entry),
    });
    return quarantine;
  });
  const contributed = new Map<DeclarationRecord, number>();
  for (const entry of entries) {
    const record = declarationOf.get(entry);
    if (record !== undefined && duplicates.has(entry) === false)
      contributed.set(record, (contributed.get(record) ?? 0) + 1);
  }
  return {
    entries: entries.filter((entry) => duplicates.has(entry) === false).sort(entryOrder),
    quarantined: [...quarantined, ...duplicateQuarantines].sort(quarantineOrder),
    unhealthySources,
    declarations: Object.fromEntries(
      [...recordsOf].map(([id, records]): [string, ReadonlyArray<DeclarationFacts>] => [
        id,
        records.map((record) => declarationFacts(record, contributed.get(record) ?? 0)),
      ]),
    ),
    sources: [...inspections]
      .sort(
        (left, right) =>
          compareCodeUnits(left.origin ?? "registered", right.origin ?? "registered") ||
          compareCodeUnits(left.registration.id, right.registration.id),
      )
      .map((inspection) => publicSourceInspection(inspection)),
  };
});

/**
 * Adds what each source's declarations contribute to the catalog's source inspections. It reads
 * the same declarations and resources as the catalog and changes nothing.
 */
export const inspectSourcesWithDeclarations = (catalog: Catalog) =>
  (catalog.sources ?? []).map((source): SourceDeclarationsView =>
    source.status === "healthy"
      ? { ...source, declarations: catalog.declarations?.[source.registration.id] ?? [] }
      : source,
  );
