import { Effect } from "effect";
import {
  makeCommandSnapshot,
  resolveInvocationCatalog,
} from "../../features/snapshot/command-snapshot.ts";
import { emptyState } from "../../domain/state/state-schema.ts";
import type { SourceInspection } from "../../domain/sources/source-inspection.ts";
import type { ReferenceIndex } from "../../features/sources/resource-reference.ts";
import type { StateOptions } from "../../services/state-store.ts";
import type { PublicEnvelope } from "../envelope/public-outcome.ts";

const registrationId = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

const directoryName = (canonicalPath: string) =>
  canonicalPath.slice(canonicalPath.lastIndexOf("/") + 1);

/**
 * The sources with a display name for each unhealthy one whose label cannot be read: its directory
 * name, the name its `source-unhealthy` path ends with. A name another source carries, or that
 * several unhealthy sources share, would be ambiguous, so that source keeps its registration ID.
 */
const namedSources = (
  sources: ReadonlyArray<SourceInspection>,
): ReadonlyArray<SourceInspection> => {
  const unnamed = (source: SourceInspection) =>
    source.status === "unhealthy" && source.label === undefined;
  const nameOf = (source: SourceInspection) =>
    unnamed(source) ? directoryName(source.registration.canonicalPath) : source.label;
  return sources.map((source) => {
    const name = directoryName(source.registration.canonicalPath);
    return unnamed(source) && sources.filter((other) => nameOf(other) === name).length === 1
      ? { ...source, label: name, labelOrigin: "derived" }
      : source;
  });
};

/**
 * The catalog's references for a human view, or `undefined` when the view needs none. An envelope
 * names a resource by its registration ID, so one that carries no ID skips the catalog read, and a
 * catalog that cannot be read leaves the registration IDs in place instead of failing the view.
 */
export const loadReferenceIndex = (envelope: PublicEnvelope, stateOptions: StateOptions) =>
  registrationId.test(JSON.stringify(envelope))
    ? resolveInvocationCatalog(stateOptions).pipe(
        // Before any state exists, as in a first `tack init` preview, only the built-ins are known.
        Effect.catchTag("StateNotInitializedError", () =>
          makeCommandSnapshot(emptyState()).pipe(Effect.flatMap((snapshot) => snapshot.catalog)),
        ),
        Effect.map((catalog): ReferenceIndex | undefined => ({
          entries: catalog.entries,
          ...(catalog.sources === undefined ? {} : { sources: namedSources(catalog.sources) }),
        })),
        Effect.catchCause(() => Effect.succeed<ReferenceIndex | undefined>(undefined)),
      )
    : Effect.succeed<ReferenceIndex | undefined>(undefined);
