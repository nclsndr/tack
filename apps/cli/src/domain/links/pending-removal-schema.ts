import { Schema } from "effect";
import { managedLinkDestinationPath } from "../agents/agent-layout.ts";
import { ManagedLinkEvidenceSchema } from "./managed-link-schema.ts";
import { CanonicalPathSchema } from "../identity/identity-schema.ts";
import { compareCodeUnits } from "../identity/ordering.ts";

/** Why Tack retained one cleanup obligation. Stronger causes must not be downgraded. */
export const PendingRemovalCauseSchema = Schema.Literals([
  "root-removal",
  "project-removal",
  "adapter-disable",
  "clean",
  "reset",
]);

/** The last JSON-safe result of attempting one pending cleanup obligation. */
export const PendingRemovalLastResultSchema = Schema.Union([
  Schema.TaggedStruct("blocked", { message: Schema.String }),
  Schema.TaggedStruct("filesystem-failure", { message: Schema.String }),
  Schema.TaggedStruct("interrupted", { message: Schema.String }),
]);

/** One durable, JSON-safe cleanup obligation retaining exact deletion evidence. */
export const PendingRemovalSchema = Schema.Struct({
  cause: PendingRemovalCauseSchema,
  evidence: ManagedLinkEvidenceSchema,
  lastResult: Schema.optionalKey(PendingRemovalLastResultSchema),
});

/** Public cleanup obligation with its derived destination. */
export const ReportedPendingRemovalSchema = Schema.Struct({
  ...PendingRemovalSchema.fields,
  destinationPath: CanonicalPathSchema,
}).check(
  Schema.makeFilter((pending) =>
    pending.destinationPath === managedLinkDestinationPath(pending.evidence)
      ? []
      : ["Pending-removal destination must derive from its adapter, target, and address."],
  ),
);

/** Adds the destination only when a command reports a pending obligation. */
export const reportPendingRemoval = (pending: PendingRemoval) => ({
  ...pending,
  destinationPath: managedLinkDestinationPath(pending.evidence),
});

/** A persisted cleanup obligation. */
export type PendingRemoval = typeof PendingRemovalSchema.Type;

/** Public pending-removal shape retained by command envelopes. */
export const ReportedPendingRemovalCollectionSchema = Schema.Array(
  ReportedPendingRemovalSchema,
).check(
  Schema.makeFilter((pending) => {
    const destinations = pending.map((item) => item.destinationPath);
    const sorted = [...destinations].sort(compareCodeUnits);
    return [
      ...(new Set(destinations).size === destinations.length
        ? []
        : ["Pending removals must be unique by destination path."]),
      ...(destinations.every((destination, index) => destination === sorted[index])
        ? []
        : ["Pending removals must use canonical code-unit ordering."]),
    ];
  }),
);
export type ReportedPendingRemoval = typeof ReportedPendingRemovalSchema.Type;

/** A persisted last-result value. */
export type PendingRemovalLastResult = typeof PendingRemovalLastResultSchema.Type;

/** A cause with the stable precedence used when obligations are merged. */
export type PendingRemovalCause = typeof PendingRemovalCauseSchema.Type;

const causeRank: Record<PendingRemovalCause, number> = {
  clean: 0,
  reset: 1,
  "adapter-disable": 2,
  "root-removal": 3,
  "project-removal": 4,
};

/** Returns the stronger of two cleanup causes without depending on insertion order. */
export const strongerPendingRemovalCause = (
  left: PendingRemovalCause,
  right: PendingRemovalCause,
) => (causeRank[left] >= causeRank[right] ? left : right);
