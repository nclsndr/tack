import { Schema } from "effect";
import {
  DocsLinkOutcomeSchema,
  DocsPendingRemovalsSchema,
  DocsRemovalActionsSchema,
} from "../docs/docs-schema.ts";
import { AgentAdapterIdSchema } from "../links/agent-adapter-schema.ts";
import {
  ManagedLinkEvidenceSchema,
  ManagedLinkEvidenceCollectionSchema,
  ManagedLinkTargetSchema,
  managedLinkDestinationIdentity,
  managedLinkTargetIdentity,
} from "../links/managed-link-schema.ts";
import { CanonicalPathSchema } from "../identity/identity-schema.ts";
import {
  PendingRemovalCauseSchema,
  ReportedPendingRemovalCollectionSchema,
  type PendingRemovalCause,
} from "../links/pending-removal-schema.ts";
import { managedLinkDestinationPath } from "../agents/agent-layout.ts";
import { ProjectNameSchema, ReportedProjectRecordSchema } from "../projects/project-schema.ts";
import { SourceRegistrationIdSchema } from "../sources/source-schema.ts";
import { DestinationObservationSchema } from "./destination-observation-schema.ts";
import { compareCodeUnits } from "../identity/ordering.ts";

const SelectedRemovalTargetsSchema = Schema.Array(ManagedLinkTargetSchema).check(
  Schema.makeFilter((targets) => {
    const identities = targets.map((target) => managedLinkTargetIdentity(target));
    const sorted = [...identities].sort(compareCodeUnits);
    return [
      ...(new Set(identities).size === identities.length
        ? []
        : ["Selected removal targets must be unique."]),
      ...(identities.every((identity, index) => identity === sorted[index])
        ? []
        : ["Selected removal targets must use canonical code-unit ordering."]),
    ];
  }),
);

/** The maintenance boundary addressed by one removal plan. */
export const RemovalScopeSchema = Schema.Union([
  Schema.TaggedStruct("project-root", {
    canonicalRoot: CanonicalPathSchema,
    projectName: ProjectNameSchema,
  }),
  Schema.TaggedStruct("project", { projectName: ProjectNameSchema }),
  Schema.TaggedStruct("selected-targets", { targets: SelectedRemovalTargetsSchema }),
  Schema.TaggedStruct("retry-targets", { targets: SelectedRemovalTargetsSchema }),
  Schema.TaggedStruct("adapter", { adapter: AgentAdapterIdSchema }),
  /** Every link and docs mount that delivers a resource of one source, wherever it is. */
  Schema.TaggedStruct("source", { sourceRegistrationId: SourceRegistrationIdSchema }),
  Schema.TaggedStruct("maintenance", {}),
  Schema.TaggedStruct("reset", {}),
]);

/** One planned cleanup operation, before filesystem mutation. */
const RemovalActionSchema = Schema.Union([
  Schema.TaggedStruct("retire", {
    destinationPath: CanonicalPathSchema,
    evidence: ManagedLinkEvidenceSchema,
  }),
  Schema.TaggedStruct("remove", {
    /**
     * Other adapters whose directories resolve through an operator's alias to the physical
     * directory of this link. Removing the link with Tack's authority also removes it for them.
     */
    alsoReachedBy: Schema.optionalKey(Schema.NonEmptyArray(AgentAdapterIdSchema)),
    destinationPath: CanonicalPathSchema,
    evidence: ManagedLinkEvidenceSchema,
  }),
  Schema.TaggedStruct("blocked", {
    destinationPath: CanonicalPathSchema,
    evidence: ManagedLinkEvidenceSchema,
    message: Schema.String,
    observation: DestinationObservationSchema,
  }),
]);

const sortedUniqueKeys = (values: ReadonlyArray<string>) => {
  const sorted = [...values].sort(compareCodeUnits);
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => value === sorted[index])
  );
};

const actionEvidenceDestinationMatches = (action: typeof RemovalActionSchema.Type) =>
  action.destinationPath === managedLinkDestinationPath(action.evidence) &&
  (action._tag !== "blocked" || action.observation.destinationPath === action.destinationPath);

// Planning sorts evidence by this destination identity, which orders resource kind before name.
const sortedEvidence = (values: ReadonlyArray<typeof ManagedLinkEvidenceSchema.Type>) =>
  sortedUniqueKeys(values.map(managedLinkDestinationIdentity));

const sortedProjects = (values: ReadonlyArray<typeof ReportedProjectRecordSchema.Type>) => {
  const sorted = [...values].sort((left, right) => compareCodeUnits(left.name, right.name));
  return (
    new Set(values.map((project) => project.name)).size === values.length &&
    values.every((project, index) => project === sorted[index])
  );
};

/** A deterministic, JSON-safe removal-only plan. */
const RemovalPlanFieldsSchema = Schema.Struct({
  actions: Schema.Array(RemovalActionSchema).check(
    Schema.makeFilter((actions) => [
      ...(sortedUniqueKeys(actions.map((action) => action.destinationPath))
        ? []
        : ["Removal actions must use unique code-unit ordered destinations."]),
      ...(actions.every(actionEvidenceDestinationMatches)
        ? []
        : ["Removal actions must derive destinations from their evidence."]),
    ]),
  ),
  cause: PendingRemovalCauseSchema,
  expectedManagedLinks: ManagedLinkEvidenceCollectionSchema.check(
    Schema.makeFilter((evidence) =>
      sortedEvidence(evidence) ? [] : ["Removal evidence must use deterministic ordering."],
    ),
  ),
  /** The docs mounts the plan removes, each observed as a removal or as the conflict apply refuses. */
  docsActions: Schema.optionalKey(DocsRemovalActionsSchema),
  expectedPendingRemovals: ReportedPendingRemovalCollectionSchema,
  expectedProject: Schema.optionalKey(ReportedProjectRecordSchema),
  expectedProjects: Schema.optionalKey(
    Schema.Array(ReportedProjectRecordSchema).check(
      Schema.makeFilter((projects) =>
        sortedProjects(projects) ? [] : ["Removal projects must use deterministic ordering."],
      ),
    ),
  ),
  finalizeProject: Schema.Boolean,
  kind: Schema.Literal("managed-removal-plan"),
  scope: RemovalScopeSchema,
  version: Schema.Literal(1),
});

/** A deterministic, JSON-safe removal-only plan. */
export const RemovalPlanSchema = RemovalPlanFieldsSchema.check(
  Schema.makeFilter((plan) => [
    ...(plan.scope._tag === "reset" && (plan.cause !== "reset" || plan.finalizeProject !== false)
      ? ["Reset removal plans must use the reset cause and cannot finalize projects."]
      : []),
    ...(plan.scope._tag === "retry-targets" &&
    (plan.cause !== "clean" || plan.finalizeProject !== false)
      ? ["Retry removal plans must use the clean fallback cause and scoped finalization."]
      : []),
  ]),
);

/** One applied, safely skipped, or failed cleanup operation. */
const RemovalActionOutcomeSchema = Schema.Union([
  Schema.TaggedStruct("applied", {
    action: Schema.Union([
      Schema.TaggedStruct("retire", {
        destinationPath: CanonicalPathSchema,
        evidence: ManagedLinkEvidenceSchema,
      }),
      Schema.TaggedStruct("remove", {
        destinationPath: CanonicalPathSchema,
        evidence: ManagedLinkEvidenceSchema,
      }),
    ]),
  }),
  Schema.TaggedStruct("skipped", {
    action: RemovalActionSchema,
    reason: Schema.String,
  }),
  Schema.TaggedStruct("failed", {
    action: RemovalActionSchema,
    code: Schema.Literal("filesystem-failure"),
    message: Schema.String,
  }),
]);

/** A durable result from one independent removal run. */
export const RemovalResultSchema = Schema.Struct({
  actions: Schema.Array(RemovalActionOutcomeSchema),
  docsActions: Schema.optionalKey(Schema.Array(DocsLinkOutcomeSchema)),
  /** The docs mounts whose removal is still owed; absent when none is. */
  docsPending: Schema.optionalKey(DocsPendingRemovalsSchema),
  finalizedProject: Schema.Boolean,
  kind: Schema.Literal("managed-removal-application"),
  pending: ReportedPendingRemovalCollectionSchema,
  version: Schema.Literal(1),
});

/** The schema for one cleanup scope. */
export type RemovalScope = typeof RemovalScopeSchema.Type;

/** The schema for one planned cleanup action. */
export type RemovalAction = typeof RemovalActionSchema.Type;

/** The schema for one cleanup plan. */
export type RemovalPlan = typeof RemovalPlanSchema.Type;

/** The schema for one cleanup outcome. */
export type RemovalActionOutcome = typeof RemovalActionOutcomeSchema.Type;

/** The schema for one cleanup result. */
export type RemovalResult = typeof RemovalResultSchema.Type;

/** One explicit removal lifecycle request; the cause defaults from the scope. */
export type RemovalRequest = {
  readonly cause?: PendingRemovalCause;
  readonly scope: RemovalScope;
};

/** Reports an explicit removal request for an unknown project namespace. */
export class RemovalProjectNotFoundError extends Schema.TaggedError<RemovalProjectNotFoundError>()(
  "RemovalProjectNotFoundError",
  { projectName: Schema.String },
) {}

/** Reports an explicit removal request for a root not retained by its project. */
export class RemovalRootNotFoundError extends Schema.TaggedError<RemovalRootNotFoundError>()(
  "RemovalRootNotFoundError",
  { canonicalRoot: Schema.String, projectName: Schema.String },
) {}
