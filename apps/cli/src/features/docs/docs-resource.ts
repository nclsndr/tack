import { Effect, Path, Schema } from "effect";
import type { CommandSnapshot } from "../snapshot/command-snapshot.ts";
import { inspectCatalog, sourceQualifier } from "../sources/resource-reference.ts";
import type { Catalog, DocsCatalogEntry } from "../../domain/sources/catalog-schema.ts";
import {
  SourceRegistrationIdSchema,
  type SourceRegistration,
} from "../../domain/sources/source-schema.ts";
import {
  DocsError,
  docsResourceIdentity,
  type DocsProject,
  type DocsResourceReference,
  type DocsResourceRequest,
} from "../../domain/docs/docs-schema.ts";

/** The project-relative directory that holds docs mounts when none is configured. */
const defaultDocsDestination = ".tack/docs";

/** Derives the single mount path of one source-qualified docs resource under a project root. */
export const docsDestinationPath = (
  path: Path.Path,
  root: string,
  settings: Pick<DocsProject, "destination">,
  resource: DocsResourceReference,
) =>
  path.join(
    root,
    settings.destination ?? defaultDocsDestination,
    resource.sourceRegistrationId,
    resource.name,
  );

/** Finds the healthy catalog entry for one source-qualified docs identity. */
export const findDocsEntry = (
  catalog: Pick<Catalog, "entries">,
  resource: DocsResourceReference,
): DocsCatalogEntry | undefined =>
  catalog.entries.find(
    (entry): entry is DocsCatalogEntry =>
      entry.address.kind === "docs" &&
      docsResourceIdentity({
        ...entry.address,
        sourceRegistrationId: entry.sourceRegistrationId,
      }) === docsResourceIdentity(resource),
  );

/** The registered sources and healthy catalog one docs operation resolves resources against. */
export type DocsSources = {
  readonly registrations: ReadonlyArray<SourceRegistration>;
  readonly catalog: Catalog;
};

/** Reads the registered sources and catalog of one snapshot for one docs operation. */
export const observeDocsSources = Effect.fnUntraced(function* (
  snapshot: Pick<CommandSnapshot, "catalog" | "sourceInspections">,
) {
  const inspections = yield* snapshot.sourceInspections;
  return {
    registrations: inspections.map((inspection) => inspection.registration),
    catalog: yield* snapshot.catalog,
  } satisfies DocsSources;
});

const isRegistrationId = Schema.is(SourceRegistrationIdSchema);

/**
 * Resolves a docs reference to a source-qualified identity without guessing on a clash.
 */
export const resolveDocsResource = Effect.fnUntraced(function* (
  sources: DocsSources,
  request: DocsResourceRequest,
  _cwd: string,
) {
  const separator = request.reference.indexOf(":");
  const prefix = separator < 0 ? undefined : request.reference.slice(0, separator);
  const labels = sources.catalog.sources ?? [];
  const matchingLabels =
    prefix === undefined ? [] : labels.filter((source) => source.label === prefix);
  const name = prefix === undefined ? request.reference : request.reference.slice(separator + 1);
  if (matchingLabels.length > 1)
    return yield* new DocsError({
      code: "docs-source-label-ambiguous",
      message: `Source label ${String(prefix)} matches several registrations: ${matchingLabels.map((source) => source.registration.id).join(", ")}. Use a registration ID.`,
      details: { candidates: matchingLabels.map((source) => source.registration.id) },
    });
  if (prefix !== undefined && !isRegistrationId(prefix) && matchingLabels.length === 0)
    return yield* new DocsError({
      code: "docs-source-not-registered",
      message: `No registered source has label ${String(prefix)}. Run tack source list, then use a source label or registration ID.`,
      details: { source: prefix },
    });
  const sourceRegistrationId =
    prefix === undefined
      ? undefined
      : isRegistrationId(prefix)
        ? prefix
        : matchingLabels[0]?.registration.id;
  if (sourceRegistrationId !== undefined) return { sourceRegistrationId, name };
  const candidates = sources.catalog.entries.filter(
    (entry): entry is DocsCatalogEntry =>
      entry.address.kind === "docs" && entry.address.name === name,
  );
  const [only, ...others] = candidates;
  if (only === undefined)
    return yield* new DocsError({
      code: "docs-resource-unavailable",
      message: `No healthy registered source declares docs resource ${name}. Choose one from ${inspectCatalog.join(" ")} or qualify it with a registration ID.`,
      details: { name },
      next: [inspectCatalog],
    });
  if (others.length > 0)
    return yield* new DocsError({
      code: "docs-resource-ambiguous",
      message: `${candidates.length} registered sources declare docs resource ${name}. Use ${candidates.map((entry) => `tack docs attach ${sourceQualifier(sources.catalog, entry.sourceRegistrationId)}:${name}`).join(" or ")}.`,
      details: {
        name,
        candidates: candidates.map((entry) => ({
          name: entry.address.name,
          sourceRegistrationId: entry.sourceRegistrationId,
          sourcePath: entry.sourcePath,
        })),
      },
    });
  return {
    sourceRegistrationId: only.sourceRegistrationId,
    name,
  };
});
