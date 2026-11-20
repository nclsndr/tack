import { Effect, Schema } from "effect";
import type { ResourceKind } from "../../domain/resources/kinds.ts";
import type { Catalog, CatalogEntry } from "../../domain/sources/catalog-schema.ts";
import { SourceRegistrationIdSchema } from "../../domain/sources/source-schema.ts";
import { NextCommandsSchema } from "../../domain/hints/next-commands.ts";

/** The command that lists every healthy resource a reference can name. */
export const inspectCatalog = ["tack", "catalog"];

/** An operator reference that cannot identify exactly one healthy resource. */
export class ResourceReferenceError extends Schema.TaggedError<ResourceReferenceError>()(
  "ResourceReferenceError",
  {
    code: Schema.Literals([
      "resource-not-found",
      "resource-ambiguous",
      "source-label-ambiguous",
      "builtin-skill-locked",
    ]),
    message: Schema.String,
    candidates: Schema.Array(Schema.String),
    /** The commands the message names as the fix, as data the envelope's `next` is filled from. */
    next: Schema.optionalKey(NextCommandsSchema),
  },
) {}

const isRegistrationId = Schema.is(SourceRegistrationIdSchema);

/** The source facts a reference reads: its registration ID and its label. */
export type ReferenceSource = {
  readonly registration: { readonly id: string };
  readonly label?: string;
  readonly labelOrigin?: string;
};

/** Uses an unambiguous source label when available, otherwise the stable registration ID. */
export const sourceQualifier = (
  catalog: { readonly sources?: ReadonlyArray<ReferenceSource> },
  sourceId: string,
): string => {
  const source = catalog.sources?.find((item) => item.registration.id === sourceId);
  return source?.labelOrigin === "clashing" ? sourceId : (source?.label ?? sourceId);
};

/** What a reference needs from a catalog: the resources and the sources that label them. */
export type ReferenceIndex = {
  readonly entries: ReadonlyArray<{
    readonly address: { readonly kind: string; readonly name: string };
    readonly sourceRegistrationId: string;
  }>;
  readonly sources?: ReadonlyArray<ReferenceSource>;
};

/**
 * Names a resource without a qualifier only when its kind and name are unique, and with the source
 * qualifier otherwise. An address whose source has no matching resource keeps its qualifier, since
 * the bare name would point at another resource.
 */
export const referenceFor = (
  index: ReferenceIndex,
  address: { readonly kind: string; readonly name: string; readonly sourceRegistrationId: string },
): string => {
  const matches = index.entries.filter(
    (candidate) =>
      candidate.address.kind === address.kind && candidate.address.name === address.name,
  );
  return matches.length === 1 && matches[0]?.sourceRegistrationId === address.sourceRegistrationId
    ? address.name
    : `${sourceQualifier(index, address.sourceRegistrationId)}:${address.name}`;
};

/** Names a catalog resource by its shortest unambiguous reference. */
export const shortestReference = (
  catalog: Pick<Catalog, "entries" | "sources">,
  entry: CatalogEntry,
): string =>
  referenceFor(catalog, {
    kind: entry.address.kind,
    name: entry.address.name,
    sourceRegistrationId: entry.sourceRegistrationId,
  });

/**
 * Resolves a name, a label-qualified name, or an ID-qualified name without guessing. A failure
 * suggests `command` for each candidate, followed by `flags` so that a suggestion keeps the target
 * the operator chose, such as `--project demo`.
 */
export const resolveResourceReference = Effect.fnUntraced(function* <
  Entry extends {
    readonly address: { readonly kind: ResourceKind; readonly name: string };
    readonly sourceRegistrationId: string;
  },
>(
  catalog: {
    readonly entries: ReadonlyArray<Entry>;
    readonly sources?: ReadonlyArray<ReferenceSource>;
  },
  reference: string,
  kinds: ReadonlyArray<ResourceKind>,
  command: string,
  kind?: ResourceKind,
  flags: ReadonlyArray<string> = [],
) {
  const colon = reference.indexOf(":");
  const prefix = colon < 0 ? undefined : reference.slice(0, colon);
  const matchingSources =
    prefix === undefined ? [] : (catalog.sources ?? []).filter((item) => item.label === prefix);
  const qualified =
    prefix !== undefined && (isRegistrationId(prefix) || matchingSources.length > 0);
  const name = qualified ? reference.slice(colon + 1) : reference;
  if (matchingSources.length > 1)
    return yield* new ResourceReferenceError({
      code: "source-label-ambiguous",
      message: `Source label ${prefix} belongs to several registrations. Use one registration ID.`,
      candidates: matchingSources.map((item) => item.registration.id),
    });
  const sourceId =
    prefix === undefined
      ? undefined
      : isRegistrationId(prefix)
        ? prefix
        : matchingSources[0]?.registration.id;
  const candidates = catalog.entries.filter(
    (entry) =>
      kinds.includes(entry.address.kind) &&
      (kind === undefined || entry.address.kind === kind) &&
      entry.address.name === name &&
      (sourceId === undefined || entry.sourceRegistrationId === sourceId),
  );
  const [only] = candidates;
  if (only !== undefined && candidates.length === 1) return only;
  const kindClash = new Set(candidates.map((entry) => entry.address.kind)).size > 1;
  const commands = candidates.map(
    (entry) =>
      `${command} ${sourceQualifier(catalog, entry.sourceRegistrationId)}:${entry.address.name}${kindClash ? ` --kind ${entry.address.kind}` : ""}${flags.map((flag) => ` ${flag}`).join("")}`,
  );
  return yield* new ResourceReferenceError({
    code: candidates.length === 0 ? "resource-not-found" : "resource-ambiguous",
    message:
      candidates.length === 0
        ? `No healthy resource matches ${reference}. Run ${inspectCatalog.join(" ")} to inspect available resources.`
        : `${reference} matches several resources. Use ${commands.join(" or ")}.`,
    candidates: commands,
    ...(candidates.length === 0 ? { next: [inspectCatalog] } : {}),
  });
});
