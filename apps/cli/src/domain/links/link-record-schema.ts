import { Schema } from "effect";
import { isStrictlyInside } from "../identity/path-containment.ts";
import { agentAdapterDescriptor } from "../agents/agent-adapter.ts";
import { deliversKind, managedLinkDestinationPath } from "../agents/agent-layout.ts";
import {
  CommandAddressSchema,
  DocsAddressSchema,
  SkillAddressSchema,
  isLinkableAddress,
  resourceAddressIdentity,
} from "../sources/catalog-schema.ts";
import { AgentAdapterIdSchema } from "../agents/agent-adapter-schema.ts";
import { CanonicalPathSchema } from "../identity/identity-schema.ts";
import {
  ManagedLinkTargetSchema,
  managedLinkTargetIdentity,
  type ManagedLinkEvidence,
} from "./managed-link-schema.ts";
import { compareCodeUnits } from "../identity/ordering.ts";
import {
  PendingRemovalCauseSchema,
  PendingRemovalLastResultSchema,
  strongerPendingRemovalCause,
  type PendingRemoval,
  type PendingRemovalCause,
  type PendingRemovalLastResult,
} from "./pending-removal-schema.ts";

/** Normalizes Windows separators and drive spelling for physical destination comparison only. */
export const physicalDestinationIdentity = (destination: string): string =>
  /^(?:[A-Za-z]:[\\/]|\\\\)/.test(destination)
    ? destination.replaceAll("/", "\\").replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
    : destination;

/** The obligation to remove one link: why it is owed and how its last attempt ended. */
const LinkRemovalSchema = Schema.Struct({
  cause: PendingRemovalCauseSchema,
  lastResult: Schema.optionalKey(PendingRemovalLastResultSchema),
});

/**
 * What a link delivers. It decides where the destination comes from, which parent policy applies
 * and which ownership proof is used: an agent resource through an adapter, or a docs mount.
 */
const LinkDeliverySchema = Schema.Union([
  Schema.TaggedStruct("agent", { adapter: AgentAdapterIdSchema }),
  Schema.TaggedStruct("docs", {}),
]);

/** The resources a link can deliver, each an exact identity with its source. */
const LinkResourceSchema = Schema.Union([
  SkillAddressSchema,
  CommandAddressSchema,
  DocsAddressSchema,
]);

const linkEvidenceFields = {
  destinationPath: CanonicalPathSchema,
  sourceDirectoryPath: CanonicalPathSchema,
  resource: LinkResourceSchema,
  target: ManagedLinkTargetSchema,
  delivery: LinkDeliverySchema,
} as const;

type LinkShape = Schema.Struct.Type<typeof linkEvidenceFields>;

/** What each delivery kind requires of the link it delivers. */
const deliveryIssues = (link: LinkShape): string[] => {
  if (link.delivery._tag === "docs") {
    if (link.resource.kind !== "docs") return ["A docs link must deliver a docs resource."];
    if (link.target._tag !== "project-root") return ["A docs link must belong to a project root."];
    return isStrictlyInside(link.target.canonicalPath, link.destinationPath)
      ? []
      : ["Docs evidence must keep its destination inside its root."];
  }
  const kind = link.resource.kind;
  if (
    kind === "docs" ||
    deliversKind(agentAdapterDescriptor(link.delivery.adapter), link.target, kind) === false
  )
    return ["Managed-link evidence requires an adapter destination for its resource kind."];
  return link.destinationPath ===
    managedLinkDestinationPath({
      adapter: link.delivery.adapter,
      address: link.resource,
      target: link.target,
    })
    ? []
    : ["An agent link's destination must be where its adapter places the resource."];
};

/**
 * Durable evidence for one link Tack created: where it is, what it points at, which exact resource
 * it delivers, which target it belongs to and how it was delivered. Agent links and docs mounts
 * share this one shape.
 */
export const LinkEvidenceSchema = Schema.Struct(linkEvidenceFields).check(
  Schema.makeFilter(deliveryIssues),
);

/** The ownership proof for one link, whatever it delivers. */
export type LinkEvidence = typeof LinkEvidenceSchema.Type;

/**
 * The one record of a physical link destination. It holds the ownership evidence and, when one
 * exists, the removal owed for that destination. A record without `removal` is managed with
 * nothing owed. A `pendingOnly` record is no longer managed, but its removal is still owed.
 */
export const LinkRecordSchema = Schema.Struct({
  ...linkEvidenceFields,
  removal: Schema.optionalKey(LinkRemovalSchema),
  pendingOnly: Schema.optionalKey(Schema.Literal(true)),
}).check(Schema.makeFilter(deliveryIssues));

/** One link record per physical destination. */
export type LinkRecord = typeof LinkRecordSchema.Type;

/** The evidence a record holds, without its removal obligation. */
export const linkEvidenceOf = (link: LinkEvidence): LinkEvidence => ({
  destinationPath: link.destinationPath,
  sourceDirectoryPath: link.sourceDirectoryPath,
  resource: link.resource,
  target: link.target,
  delivery: link.delivery,
});

/** Compares complete ownership proof, without consulting the filesystem. */
export const linkEvidenceEqual = (left: LinkEvidence, right: LinkEvidence): boolean =>
  physicalDestinationIdentity(left.destinationPath) ===
    physicalDestinationIdentity(right.destinationPath) &&
  left.sourceDirectoryPath === right.sourceDirectoryPath &&
  resourceAddressIdentity(left.resource) === resourceAddressIdentity(right.resource) &&
  managedLinkTargetIdentity(left.target) === managedLinkTargetIdentity(right.target) &&
  left.delivery._tag === right.delivery._tag &&
  (left.delivery._tag !== "agent" ||
    (right.delivery._tag === "agent" && left.delivery.adapter === right.delivery.adapter));

/** Records the evidence of an agent link, where its adapter places it. */
export const agentLink = (evidence: ManagedLinkEvidence): LinkEvidence => ({
  destinationPath: managedLinkDestinationPath(evidence),
  sourceDirectoryPath: evidence.sourceDirectoryPath,
  resource: evidence.address,
  target: evidence.target,
  delivery: { _tag: "agent", adapter: evidence.adapter },
});

/** The agent evidence a link holds, or absence for a link of another delivery kind. */
export const managedAgentEvidence = (link: LinkEvidence): ManagedLinkEvidence | undefined =>
  link.delivery._tag === "agent" && isLinkableAddress(link.resource)
    ? {
        adapter: link.delivery.adapter,
        address: link.resource,
        sourceDirectoryPath: link.sourceDirectoryPath,
        sourceRegistrationId: link.resource.sourceRegistrationId,
        target: link.target,
      }
    : undefined;

/**
 * Link records are unique by physical destination, across both delivery kinds, which is what keeps
 * one proof per destination.
 */
export const LinkRecordsSchema = Schema.Array(LinkRecordSchema).check(
  Schema.makeFilter((records) => {
    const physical = new Set<string>();
    let pendingWithoutRemoval = false;
    for (const record of records) {
      physical.add(physicalDestinationIdentity(record.destinationPath));
      if (record.pendingOnly === true && record.removal === undefined) pendingWithoutRemoval = true;
    }
    return [
      ...(pendingWithoutRemoval ? ["Pending-only link records require a removal obligation."] : []),
      ...(physical.size === records.length
        ? []
        : ["Link records must have unique physical destinations."]),
    ];
  }),
);

/** Agent evidence that Tack still manages, in record order. */
export const managedLinksOf = (records: ReadonlyArray<LinkRecord>): ManagedLinkEvidence[] =>
  records.flatMap((record) => {
    const evidence = record.pendingOnly === true ? undefined : managedAgentEvidence(record);
    return evidence === undefined ? [] : [evidence];
  });

/** Owed agent-link removals in canonical destination order, as every report requires. */
export const pendingRemovalsOf = (records: ReadonlyArray<LinkRecord>): PendingRemoval[] =>
  records
    .flatMap((record) => {
      const evidence = managedAgentEvidence(record);
      return record.removal === undefined || evidence === undefined
        ? []
        : [{ pending: { ...record.removal, evidence }, destination: record.destinationPath }];
    })
    .sort((left, right) => compareCodeUnits(left.destination, right.destination))
    .map(({ pending }) => pending);

/** Never lets a stronger obligation be replaced by a different proof of the same destination. */
const refuseDifferentEvidence = (record: LinkRecord, link: LinkEvidence) => {
  if (record.removal !== undefined && !linkEvidenceEqual(record, link)) {
    throw new Error(
      "A link record that owes a removal cannot take different evidence for its destination.",
    );
  }
};

/**
 * One change to the ledger of link records. A change names the evidence of one destination:
 *
 * - `manage` records that Tack manages this evidence. A new destination gets a record, and different
 *   evidence replaces the previous evidence only while no removal is owed. A record that is only
 *   pending becomes managed again with its removal intact.
 * - `unmanage` records that Tack no longer manages this evidence. A destination with no removal owed
 *   has no record left. A destination that owes a removal stays as a pending-only record.
 * - `owe` owes a removal. An existing obligation keeps its stronger cause and its last result. A
 *   destination with no record gets a pending-only one.
 * - `result` replaces the last result of an owed removal and keeps its recorded cause. A destination
 *   that owes nothing yet gets the weakest cause, so an attempt is never recorded without an
 *   obligation.
 * - `settle` ends both the management and the removal, so the record is deleted.
 */
export type LinkChange =
  | { readonly _tag: "manage"; readonly link: LinkEvidence }
  | { readonly _tag: "unmanage"; readonly link: LinkEvidence }
  | {
      readonly _tag: "owe";
      readonly link: LinkEvidence;
      readonly cause: PendingRemovalCause;
    }
  | {
      readonly _tag: "result";
      readonly link: LinkEvidence;
      readonly lastResult: PendingRemovalLastResult;
    }
  | { readonly _tag: "settle"; readonly link: LinkEvidence };

/** The record a destination holds after one change, or none when the change leaves it no record. */
const recordAfter = (
  existing: LinkRecord | undefined,
  change: LinkChange,
): LinkRecord | undefined => {
  switch (change._tag) {
    case "manage":
      if (existing === undefined) return linkEvidenceOf(change.link);
      refuseDifferentEvidence(existing, change.link);
      return existing.removal === undefined
        ? linkEvidenceOf(change.link)
        : { ...linkEvidenceOf(existing), removal: existing.removal };
    case "unmanage":
      return existing?.removal === undefined
        ? undefined
        : { ...linkEvidenceOf(existing), removal: existing.removal, pendingOnly: true as const };
    case "owe":
      if (existing === undefined) {
        return {
          ...linkEvidenceOf(change.link),
          removal: { cause: change.cause },
          pendingOnly: true as const,
        };
      }
      refuseDifferentEvidence(existing, change.link);
      return {
        ...existing,
        removal:
          existing.removal === undefined
            ? { cause: change.cause }
            : {
                ...existing.removal,
                cause: strongerPendingRemovalCause(existing.removal.cause, change.cause),
              },
      };
    case "result":
      if (existing === undefined) {
        return {
          ...linkEvidenceOf(change.link),
          removal: { cause: "clean", lastResult: change.lastResult },
          pendingOnly: true as const,
        };
      }
      refuseDifferentEvidence(existing, change.link);
      return {
        ...existing,
        removal: { cause: existing.removal?.cause ?? "clean", lastResult: change.lastResult },
      };
    case "settle":
      return undefined;
    // Coverage skip: the exhaustive never guard cannot run for a well-typed change.
    /* v8 ignore next -- @preserve */
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
};

/**
 * Applies changes in order. The records are indexed by physical destination once, so a long list of
 * changes costs a pass over the ledger, not a search for each. A record keeps its place while it
 * changes, and a destination recorded again after it was deleted goes to the end.
 */
export const applyLinkChanges = (
  records: ReadonlyArray<LinkRecord>,
  changes: ReadonlyArray<LinkChange>,
): LinkRecord[] => {
  const byDestination = new Map(
    records.map((record) => [physicalDestinationIdentity(record.destinationPath), record]),
  );
  for (const change of changes) {
    const destination = physicalDestinationIdentity(change.link.destinationPath);
    const next = recordAfter(byDestination.get(destination), change);
    if (next === undefined) byDestination.delete(destination);
    else byDestination.set(destination, next);
  }
  return [...byDestination.values()];
};

/** Every record becomes pending-only, and records with no removal owed are deleted. */
export const onlyOwedRemovals = (records: ReadonlyArray<LinkRecord>): LinkRecord[] =>
  records.flatMap((record) =>
    record.removal === undefined
      ? []
      : [{ ...linkEvidenceOf(record), removal: record.removal, pendingOnly: true as const }],
  );
