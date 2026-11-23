import { Schema } from "effect";
import {
  AgentCapabilityDecisionSchema,
  AgentAdapterIdSchema,
} from "../links/agent-adapter-schema.ts";
import { ChoiceNamespaceSchema } from "../choices/choice-schema.ts";
import {
  DependencyResolutionSchema,
  RequiredDependencyBlockerSchema,
} from "../choices/dependency-resolution.ts";
import { DestinationObservationSchema } from "./destination-observation-schema.ts";
import { CanonicalPathSchema } from "../identity/identity-schema.ts";
import {
  ManagedLinkEvidenceSchema,
  ManagedLinkTargetSchema,
} from "../links/managed-link-schema.ts";
import { LinkableAddressSchema, SkillNameSchema } from "../sources/catalog-schema.ts";
import { ProjectNameSchema } from "../projects/project-schema.ts";
import { linkableKinds } from "../resources/kinds.ts";

const RelativeLinkTargetSchema = Schema.String.check(Schema.isMinLength(1)).check(
  Schema.makeFilter((target) =>
    /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(target)
      ? ["Managed symbolic-link targets must be relative."]
      : [],
  ),
);

/** Dependency decisions retained in the plan for one exact namespace. */
const NamespaceDependencyResolutionSchema = Schema.Struct({
  namespace: ChoiceNamespaceSchema,
  resolution: DependencyResolutionSchema,
});

/** Two or more exact selected addresses that need one destination name. */
const SkillNameCollisionSchema = Schema.Struct({
  addresses: Schema.Array(LinkableAddressSchema).check(Schema.isMinLength(2)),
  name: SkillNameSchema,
});

/** One read-only filesystem or evidence conflict that prevents a path operation. */
const ReconciliationConflictSchema = Schema.Union([
  Schema.TaggedStruct("destination-directory-conflict", {
    observation: DestinationObservationSchema,
  }),
  Schema.TaggedStruct("foreign-destination", {
    addresses: Schema.Array(LinkableAddressSchema),
    destinationPath: CanonicalPathSchema,
    /** The link text Tack would write here, present when exactly one resource wants the name. */
    expectedTarget: Schema.optionalKey(RelativeLinkTargetSchema),
    observation: DestinationObservationSchema,
  }),
  Schema.TaggedStruct("managed-link-drift", {
    destinationPath: CanonicalPathSchema,
    evidence: ManagedLinkEvidenceSchema,
    observation: DestinationObservationSchema,
  }),
  Schema.TaggedStruct("relative-target-unavailable", {
    address: LinkableAddressSchema,
    destinationPath: CanonicalPathSchema,
    sourceDirectoryPath: CanonicalPathSchema,
  }),
]);

/** A future mutation described by planning but not applied by this slice. */
export const ReconciliationActionSchema = Schema.Union([
  Schema.TaggedStruct("directory-create", { directoryPath: CanonicalPathSchema }),
  /**
   * Forgets a link record and leaves the destination untouched: the link is `absent`, or it was
   * changed outside Tack and its resource is no longer selected, so Tack `released` it.
   */
  Schema.TaggedStruct("evidence-retire", {
    destinationPath: CanonicalPathSchema,
    evidence: ManagedLinkEvidenceSchema,
    reason: Schema.Literals(["absent", "released"]),
  }),
  Schema.TaggedStruct("link-remove", {
    /** The required dependencies that block the removed resource, present only for `blocked`. */
    blockers: Schema.optionalKey(Schema.NonEmptyArray(RequiredDependencyBlockerSchema)),
    destinationPath: CanonicalPathSchema,
    evidence: ManagedLinkEvidenceSchema,
    reason: Schema.Literals([
      "blocked",
      "collision",
      "deselected",
      "linked-for-user",
      "replace",
      "cleanup",
      "quarantined",
      "source-missing",
      "source-unhealthy",
    ]),
  }).check(
    Schema.makeFilter((action) =>
      (action.reason === "blocked") === (action.blockers !== undefined)
        ? []
        : ["A blocked link removal must name its blockers, and only a blocked one."],
    ),
  ),
  Schema.TaggedStruct("link-create", {
    destinationPath: CanonicalPathSchema,
    evidence: ManagedLinkEvidenceSchema,
    previousEvidence: Schema.optionalKey(ManagedLinkEvidenceSchema),
    relativeTarget: RelativeLinkTargetSchema,
  }),
  /**
   * Records as Tack's own a link Tack has no record of, which is exactly the link Tack would write:
   * the same text, resolving to the selected source. A link committed to a repository arrives this
   * way in every other clone. The destination is left untouched.
   */
  Schema.TaggedStruct("link-adopt", {
    destinationPath: CanonicalPathSchema,
    evidence: ManagedLinkEvidenceSchema,
    relativeTarget: RelativeLinkTargetSchema,
  }),
]);

const CountSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/**
 * Counts of one unit's planned work. `blocked` counts selected resources of the unit's delivered
 * kinds that a blocked required dependency keeps from being linked. `retire` counts records of
 * absent links and `release` counts records of links changed outside Tack; both only forget.
 * `adopt` counts links already on disk that Tack only records.
 */
const ReconciliationUnitSummarySchema = Schema.Struct({
  adopt: CountSchema,
  blocked: CountSchema,
  collision: CountSchema,
  conflict: CountSchema,
  create: CountSchema,
  release: CountSchema,
  remove: CountSchema,
  retire: CountSchema,
});

/** Whether a unit's adapter delivers one linkable resource kind to the unit's target. */
const KindDeliverySchema = Schema.Literals(["delivered", "unsupported"]);

/**
 * Which selected kinds the unit's adapter delivers. A selected resource of an `unsupported` kind is
 * not linked for this adapter; `status` lists it as undelivered.
 */
const ReconciliationUnitDeliverySchema = Schema.Struct({
  command: KindDeliverySchema,
  skill: KindDeliverySchema,
});

/**
 * An operator's in-root alias between agent resource directories, such as `.claude/skills`
 * pointing at `.agents/skills`. Every listed adapter reaches the one physical directory, and its
 * links are written once.
 */
const ReconciliationDirectoryAliasSchema = Schema.Struct({
  /** The other enabled adapters that reach the same physical directory. */
  alsoReachedBy: Schema.Array(AgentAdapterIdSchema),
  /** This unit's resource directory, which resolves through the alias. */
  directory: CanonicalPathSchema,
  kind: Schema.Literals(linkableKinds),
  /** The real directory that holds the links. */
  physicalDirectory: CanonicalPathSchema,
});

/**
 * How one destination relates to the other adapters that reach its physical directory through an
 * operator's directory alias. Exactly one adapter, the writer, owns each physical link; the others
 * only observe it, so a shared link is one install and never a foreign entry.
 */
export const DestinationSharingSchema = Schema.Struct({
  /** The adapters, this one included, whose directories resolve to the physical directory. */
  adapters: Schema.Array(AgentAdapterIdSchema),
  /** This adapter's own resource directory, which may be the alias. */
  directory: CanonicalPathSchema,
  /** The real directory that holds the link. */
  physicalDirectory: CanonicalPathSchema,
  role: Schema.Literals(["shared", "writer"]),
  /** For a non-writer: whether the observed link is exactly the one the writer is expected to hold. */
  state: Schema.optionalKey(Schema.Literals(["absent", "matching", "other"])),
  writer: AgentAdapterIdSchema,
});
export type DestinationSharing = typeof DestinationSharingSchema.Type;

/** One independently actionable target-and-adapter planning unit. */
const ReconciliationUnitPlanSchema = Schema.Struct({
  actions: Schema.Array(ReconciliationActionSchema),
  adapter: AgentAdapterIdSchema,
  /** Present when the invocation requires a capability; a `blocked` unit plans no work. */
  capability: Schema.optionalKey(AgentCapabilityDecisionSchema),
  collisions: Schema.Array(SkillNameCollisionSchema),
  conflicts: Schema.Array(ReconciliationConflictSchema),
  /** Present only when a resource directory of this unit is an alias or is reached by one. */
  directoryAliases: Schema.optionalKey(Schema.Array(ReconciliationDirectoryAliasSchema)),
  delivery: ReconciliationUnitDeliverySchema,
  /**
   * The selected resources a project unit does not link because its adapter already links them for
   * the user. Present only when there is one.
   */
  linkedForUser: Schema.optionalKey(Schema.Array(LinkableAddressSchema)),
  summary: ReconciliationUnitSummarySchema,
  target: ManagedLinkTargetSchema,
});

/** The only reconciliation plan version supported by this release. */
export const reconciliationPlanVersion = 1 as const;

/** A deterministic JSON-safe plan with no applied filesystem or state mutations. */
export const ReconciliationPlanSchema = Schema.Struct({
  kind: Schema.Literal("skill-reconciliation-plan"),
  namespaceResolutions: Schema.Array(NamespaceDependencyResolutionSchema),
  units: Schema.Array(ReconciliationUnitPlanSchema),
  version: Schema.Literal(reconciliationPlanVersion),
});

/** The target selection echoed by plan and reconcile alongside the shared plan. */
export const ReconciliationSelectionSchema = Schema.Struct({
  containingRoot: Schema.optionalKey(
    Schema.Struct({ projectName: ProjectNameSchema, root: CanonicalPathSchema }),
  ),
  selector: Schema.Union([
    Schema.TaggedStruct("bare", {}),
    Schema.TaggedStruct("all", {}),
    Schema.TaggedStruct("project", { projectName: ProjectNameSchema }),
    Schema.TaggedStruct("user", {}),
  ]),
  targets: Schema.Array(
    Schema.Union([
      ManagedLinkTargetSchema,
      Schema.TaggedStruct("pending-removal", {
        canonicalPath: CanonicalPathSchema,
        pending: Schema.Union([
          Schema.TaggedStruct("project", {
            canonicalPath: CanonicalPathSchema,
            projectName: ProjectNameSchema,
          }),
          Schema.TaggedStruct("user", { canonicalPath: CanonicalPathSchema }),
        ]),
      }),
    ]),
  ),
});

/** The complete plan in the CLI payload, including requested and resolved targets. */
export const ReconciliationCommandPlanSchema = Schema.Struct({
  ...ReconciliationPlanSchema.fields,
  selection: ReconciliationSelectionSchema,
});

export type NamespaceDependencyResolution = typeof NamespaceDependencyResolutionSchema.Type;
export type ReconciliationAction = typeof ReconciliationActionSchema.Type;
export type ReconciliationConflict = typeof ReconciliationConflictSchema.Type;
export type ReconciliationPlan = typeof ReconciliationPlanSchema.Type;
export type ReconciliationUnitPlan = typeof ReconciliationUnitPlanSchema.Type;
export type ReconciliationUnitSummary = typeof ReconciliationUnitSummarySchema.Type;
export type ReconciliationDirectoryAlias = typeof ReconciliationDirectoryAliasSchema.Type;
export type ReconciliationUnitDelivery = typeof ReconciliationUnitDeliverySchema.Type;
