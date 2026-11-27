import { ProfileDeliverySchema } from "../profiles/profile-delivery.ts";
import { ProfileApplicationSchema } from "../profiles/profile-application.ts";
import { Schema, Struct } from "effect";
import { AgentAdapterIdSchema, EnabledAdaptersSchema } from "../links/agent-adapter-schema.ts";
import {
  ChoiceNamespaceSchema,
  SkillChoiceSchema,
  UserLinkedExcludeSchema,
  choiceNamespaceIdentity,
} from "../choices/choice-schema.ts";
import { DependencyResolutionSchema } from "../choices/dependency-resolution.ts";
import { DestinationObservationSchema } from "../reconciliation/destination-observation-schema.ts";
import { CanonicalPathSchema } from "../identity/identity-schema.ts";
import { DocsPendingRemovalsSchema } from "../docs/docs-schema.ts";
import {
  DestinationSharingSchema,
  ReconciliationSelectionSchema,
} from "../reconciliation/reconciliation-schema.ts";
import {
  ManagedLinkEvidenceSchema,
  ManagedLinkTargetSchema,
} from "../links/managed-link-schema.ts";
import { isInCodeUnitOrder, isSortedUnique, sortedUnique } from "../identity/ordering.ts";
import {
  ReportedPendingRemovalCollectionSchema,
  ReportedPendingRemovalSchema,
} from "../links/pending-removal-schema.ts";
import {
  ProjectLifecycleSchema,
  ProjectNameSchema,
  ProjectRootIssueCodeSchema,
} from "../projects/project-schema.ts";
import { InitialSelectionSchema } from "../choices/selection.ts";
import { CatalogReportSchema } from "../sources/catalog-report.ts";
import { sourceLabelFacts } from "../sources/source-inspection.ts";
import { SelectableAddressSchema, resourceAddressIdentity } from "../sources/catalog-schema.ts";
import {
  SourceIssueCodeSchema,
  SourceRegistrationSchema,
  SourceWarningSchema,
} from "../sources/source-schema.ts";

/** The only read-only status format emitted by this Tack release. */
export const statusReportVersion = 1 as const;

/** The effective namespace selected for one status report. */
const StatusScopeSchema = Schema.Union([
  Schema.TaggedStruct("all", {}),
  Schema.TaggedStruct("project", { projectName: ProjectNameSchema }),
  Schema.TaggedStruct("user", {}),
]);

const StatusIssueSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});

/** The label of a source and where it came from, as `status` reports them. */
const statusLabelFacts = Struct.pick(sourceLabelFacts, ["label", "labelOrigin"]);

/** The current health of one retained source registration. */
const StatusSourceSchema = Schema.Union([
  Schema.Struct({
    registration: SourceRegistrationSchema,
    status: Schema.Literal("healthy"),
    ...statusLabelFacts,
    /** Heads-ups that never change health or an exit code, such as a source that declares nothing. */
    warnings: Schema.optionalKey(Schema.Array(SourceWarningSchema)),
  }),
  Schema.Struct({
    issue: Schema.Struct({ code: SourceIssueCodeSchema, message: Schema.String }),
    registration: SourceRegistrationSchema,
    status: Schema.Literal("unhealthy"),
    ...statusLabelFacts,
  }),
]);

const StatusAnchorSchema = Schema.Union([
  Schema.Struct({ path: CanonicalPathSchema, status: Schema.Literal("healthy") }),
  Schema.Struct({
    issue: StatusIssueSchema,
    path: CanonicalPathSchema,
    status: Schema.Literal("unhealthy"),
  }),
]);

/** One retained project root, including removal handoff membership and observed health. */
export const StatusProjectRootSchema = Schema.Struct({
  health: Schema.Literals(["healthy", "missing", "unhealthy"]),
  issue: Schema.optionalKey(
    Schema.Struct({ code: ProjectRootIssueCodeSchema, message: Schema.String }),
  ),
  lifecycle: ProjectLifecycleSchema,
  path: CanonicalPathSchema,
}).check(
  Schema.makeFilter((root) => {
    const healthyAgreement =
      root.health === "healthy" ? root.issue === undefined : root.issue !== undefined;
    const missingAgreement = root.health !== "missing" || root.issue?.code === "root-missing";
    return [
      ...(healthyAgreement ? [] : ["Project-root health and issue must agree."]),
      ...(missingAgreement ? [] : ["Missing roots must retain the root-missing issue."]),
    ];
  }),
);

/** One scoped registered project with current anchor and root observations. */
export const StatusProjectSchema = Schema.Struct({
  anchor: StatusAnchorSchema,
  /**
   * The root-relative folder that holds the project's docs mounts, such as `.tack/docs`; absent
   * while no docs resource is attached.
   */
  docsDestination: Schema.optionalKey(Schema.String),
  lifecycle: ProjectLifecycleSchema,
  name: ProjectNameSchema,
  roots: Schema.Array(StatusProjectRootSchema).check(
    sortedUnique(
      (root) => root.path,
      "Status project roots must use unique canonical code-unit ordering.",
    ),
  ),
});

/** Desired selection and conflicts for one active or removal-suspended namespace. */
export const StatusNamespaceSchema = Schema.Struct({
  profile: Schema.optionalKey(
    Schema.Struct({
      application: ProfileApplicationSchema,
      issues: Schema.Array(Schema.String),
      delivery: ProfileDeliverySchema,
    }),
  ),
  choices: Schema.Array(SkillChoiceSchema),
  desired: Schema.Array(SelectableAddressSchema),
  undelivered: Schema.Array(
    Schema.Struct({
      address: SelectableAddressSchema,
      adapter: Schema.optionalKey(AgentAdapterIdSchema),
      reason: Schema.Literals([
        "context-not-delivered",
        "capability-unsupported",
        "linked-for-user",
        "no-enabled-adapter",
      ]),
    }),
  ),
  lifecycle: Schema.Literals(["active", "suspended-removing"]),
  namespace: ChoiceNamespaceSchema,
  resolution: DependencyResolutionSchema,
  selection: InitialSelectionSchema,
}).check(
  Schema.makeFilter((namespace) => {
    const identity = choiceNamespaceIdentity(namespace.namespace);
    const choiceIdentities = namespace.choices.map((choice) =>
      resourceAddressIdentity(choice.address),
    );
    const desiredIdentities = namespace.desired.map((address) => resourceAddressIdentity(address));
    return [
      ...(namespace.choices.every(
        (choice) => choiceNamespaceIdentity(choice.namespace) === identity,
      )
        ? []
        : ["Status namespace choices must belong to the reported namespace."]),
      ...(isInCodeUnitOrder(choiceIdentities)
        ? []
        : ["Status namespace choices must use deterministic ordering."]),
      ...(isSortedUnique(desiredIdentities)
        ? []
        : ["Desired status addresses must use unique canonical ordering."]),
      ...(choiceNamespaceIdentity(namespace.selection.namespace) === identity
        ? []
        : ["Status selection must belong to the reported namespace."]),
    ];
  }),
);

const targetHealthSchema = Schema.Literals(["healthy", "missing", "unhealthy"]).annotate({
  description:
    "Whether the project root or user home the destination belongs to is a usable directory. It says nothing about the link itself: the link's health is the destination `_tag`.",
});

const destinationFields = {
  adapter: AgentAdapterIdSchema,
  desired: Schema.Array(ManagedLinkEvidenceSchema),
  destinationPath: CanonicalPathSchema,
  evidence: Schema.optionalKey(ManagedLinkEvidenceSchema),
  observation: DestinationObservationSchema,
  pendingRemoval: Schema.optionalKey(ReportedPendingRemovalSchema),
  /** Present when an operator's directory alias makes another adapter reach this directory. */
  sharing: Schema.optionalKey(DestinationSharingSchema),
  target: ManagedLinkTargetSchema,
  targetHealth: targetHealthSchema,
} as const;

/**
 * What each destination `_tag` means and what fixes it. A healthy link is `matching`; every other
 * tag needs attention, and `expected-absent` does not mean the destination should stay empty.
 */
const destinationMeanings = {
  matching: "Healthy: the link is where Tack recorded it and points at the expected target.",
  "target-missing":
    "Not healthy: the project root or user home this destination belongs to is missing. Run `tack doctor` for the cause.",
  "expected-absent":
    "Not healthy: a link is expected here and is absent. `tack sync --apply` creates it.",
  unrecorded:
    "Not healthy: the link Tack would write is here, but Tack has no record of it, as when a clone checks out a committed link. `tack sync --apply` adopts it as Tack's own and leaves it in place.",
  "evidence-absent":
    "Not healthy: Tack still records a link that is gone from disk. `tack sync --apply` settles it.",
  "evidence-changed":
    "Not healthy: Tack still records a link that was changed outside Tack and is no longer selected. `tack sync --apply` releases it: Tack forgets the record and leaves the link in place.",
  drift:
    "Not healthy: what is on disk differs from what Tack recorded or selected. `tack sync --apply` repairs a link Tack owns.",
  "hand-made":
    "Needs a decision: a file or folder Tack never linked was here first. Tack keeps it and does not link the resource here; `tack pick exclude` keeps yours on purpose, or move it, then sync.",
  "foreign-entry":
    "Not healthy: a file or folder Tack does not own is in the way of a link Tack recorded here, or of a link in a directory another adapter shares. Tack never overwrites it: move it, then sync.",
  "selection-conflict":
    "Not healthy: two or more selected resources need this destination. Run `tack pick exclude` for the one you do not want, then sync.",
  "observation-failed":
    "Not healthy: the destination could not be read. Run `tack doctor` for the cause.",
} as const;

const destinationVariant = <
  Tag extends keyof typeof destinationMeanings,
  Fields extends Schema.Struct.Fields,
>(
  tag: Tag,
  fields: Fields,
) => Schema.TaggedStruct(tag, fields).annotate({ description: destinationMeanings[tag] });

/**
 * One desired or retained physical destination and the reconciliation planner's decision for it.
 * The classification is derived once, from the planner, and not re-checked here.
 */
const StatusDestinationSchema = Schema.Union([
  destinationVariant("matching", destinationFields),
  destinationVariant("target-missing", destinationFields),
  destinationVariant("expected-absent", destinationFields),
  destinationVariant("unrecorded", destinationFields),
  destinationVariant("evidence-absent", destinationFields),
  destinationVariant("evidence-changed", destinationFields),
  destinationVariant("drift", destinationFields),
  destinationVariant("hand-made", destinationFields),
  destinationVariant("foreign-entry", destinationFields),
  destinationVariant("selection-conflict", destinationFields),
  destinationVariant("observation-failed", destinationFields),
]);

/** Why an imported skill, or the imports of one source, need a look. */
const StatusImportProblemCodeSchema = Schema.Literals([
  "import-folder-missing",
  "import-folder-not-cataloged",
  "imports-invalid",
  "import-staging-left-over",
]);

/** One problem with the skills a source imported, found offline. Local edits are not problems. */
const StatusImportProblemSchema = Schema.Struct({
  code: StatusImportProblemCodeSchema,
  /** The source label, or its registration ID when it has no usable label. */
  source: Schema.String,
  registrationId: Schema.String,
  /** `source:name`, the reference `import remove` accepts; absent for a source-wide problem. */
  reference: Schema.optionalKey(Schema.String),
  /** The imported skill's folder relative to the source root; absent for a source-wide problem. */
  path: Schema.optionalKey(Schema.String),
  message: Schema.String,
});

/** The imported skills of every registered source, as `import` lists them, offline. */
const StatusImportsSchema = Schema.Struct({
  /** Imported skills across every source. */
  total: Schema.Number,
  /** Imported skills whose folder differs from its record: information, editing is allowed. */
  locallyChanged: Schema.Number,
  problems: Schema.Array(StatusImportProblemSchema),
});

/** A deterministic, versioned snapshot that never changes persisted or observed state. */
export const StatusReportSchema = Schema.Struct({
  /** The concise catalog report `catalog` returns for the same sources. */
  catalog: CatalogReportSchema,
  destinations: Schema.Array(StatusDestinationSchema).check(
    sortedUnique(
      (destination) => destination.destinationPath,
      "Status destinations must use unique canonical code-unit ordering.",
    ),
  ),
  enabledAdapters: EnabledAdaptersSchema,
  imports: StatusImportsSchema,
  kind: Schema.Literal("skill-status"),
  namespaces: Schema.Array(StatusNamespaceSchema),
  pendingRemovals: ReportedPendingRemovalCollectionSchema,
  /** The docs mounts whose removal is owed, like `pendingRemovals` for agent links; absent when none is. */
  docsPendingRemovals: Schema.optionalKey(DocsPendingRemovalsSchema),
  projects: Schema.Array(StatusProjectSchema),
  selection: ReconciliationSelectionSchema,
  scope: StatusScopeSchema,
  sources: Schema.Array(StatusSourceSchema),
  stateDirectory: CanonicalPathSchema,
  /**
   * The excludes of the reported projects that hide nothing, because the user namespace links their
   * resource; absent when there is none.
   */
  userLinkedExcludes: Schema.optionalKey(Schema.Array(UserLinkedExcludeSchema)),
  version: Schema.Literal(statusReportVersion),
});

/** A complete read-only status snapshot. */
export type StatusReport = typeof StatusReportSchema.Type;

/** One observed destination in a status snapshot. */
export type StatusDestination = typeof StatusDestinationSchema.Type;

/** One scoped namespace in a status snapshot. */
export type StatusNamespace = typeof StatusNamespaceSchema.Type;

/** One scoped project in a status snapshot. */
export type StatusProject = typeof StatusProjectSchema.Type;

/** One retained source registration in a status snapshot. */
export type StatusSource = typeof StatusSourceSchema.Type;

/** The imports observation of a status snapshot. */
export type StatusImports = typeof StatusImportsSchema.Type;

/** One effective status scope. */
export type StatusScope = typeof StatusScopeSchema.Type;

/** Where a destination's occupant is, without repeating the destination path. */
const ObservedEntrySchema = Schema.Union([
  Schema.TaggedStruct("absent", {}),
  Schema.TaggedStruct("entry", { entryType: Schema.Literals(["file", "directory", "special"]) }),
  Schema.TaggedStruct("relative-link", {
    canonicalTarget: CanonicalPathSchema,
    rawTarget: Schema.String,
  }),
  Schema.TaggedStruct("unresolved-relative-link", {
    message: Schema.String,
    rawTarget: Schema.String,
  }),
  Schema.TaggedStruct("absolute-link", { rawTarget: Schema.String }),
  Schema.TaggedStruct("access-failed", {
    message: Schema.String,
    operation: Schema.Literals(["read-link", "resolve-link-target", "stat"]),
  }),
]).annotate({
  description:
    "What is at the destination now. Present only when the destination is not `matching`; the path itself is the destination's `destinationPath`.",
});

const publicDestinationFields = {
  adapter: AgentAdapterIdSchema,
  /** The resource this destination serves: the selected one, else the one Tack last recorded. */
  address: Schema.optionalKey(SelectableAddressSchema),
  /** Every selected resource that needs this destination; present for a `selection-conflict`. */
  candidates: Schema.optionalKey(Schema.Array(SelectableAddressSchema)),
  destinationPath: CanonicalPathSchema,
  observed: Schema.optionalKey(ObservedEntrySchema),
  pendingRemoval: Schema.optionalKey(ReportedPendingRemovalSchema),
  /** Present when an operator's directory alias makes another adapter reach this directory. */
  sharing: Schema.optionalKey(DestinationSharingSchema),
  target: ManagedLinkTargetSchema,
  targetHealth: targetHealthSchema,
} as const;

/** A destination as `status --json` publishes it: one resource, one path, what was found. */
const StatusPayloadDestinationSchema = Schema.Union([
  destinationVariant("matching", publicDestinationFields),
  destinationVariant("target-missing", publicDestinationFields),
  destinationVariant("expected-absent", publicDestinationFields),
  destinationVariant("unrecorded", publicDestinationFields),
  destinationVariant("evidence-absent", publicDestinationFields),
  destinationVariant("evidence-changed", publicDestinationFields),
  destinationVariant("drift", publicDestinationFields),
  destinationVariant("hand-made", publicDestinationFields),
  destinationVariant("foreign-entry", publicDestinationFields),
  destinationVariant("selection-conflict", publicDestinationFields),
  destinationVariant("observation-failed", publicDestinationFields),
]);

/** How many resources the catalog holds and how many candidates or sources it could not use. */
const StatusCatalogCountsSchema = Schema.Struct({
  /** Resources a pick can select. */
  resources: Schema.Number,
  /** Declared candidates Tack could not use. `tack catalog` lists each with its cause. */
  quarantined: Schema.Number,
  /** Sources that supplied no resources. `tack catalog` names them. */
  unavailable: Schema.Number,
}).annotate({
  description: "Catalog totals only. Run `tack catalog` for the resources and their issues.",
});

/**
 * What `status --json` publishes in `result`: the report without its catalog copy and without the
 * evidence each destination repeats. The complete report stays internal, for `doctor`.
 */
export const StatusPayloadSchema = Schema.Struct({
  ...StatusReportSchema.fields,
  catalog: StatusCatalogCountsSchema,
  destinations: Schema.Array(StatusPayloadDestinationSchema).check(
    sortedUnique(
      (destination) => destination.destinationPath,
      "Status destinations must use unique canonical code-unit ordering.",
    ),
  ),
});

/** The published status payload. */
export type StatusPayload = typeof StatusPayloadSchema.Type;

/** One destination of the published status payload. */
export type StatusPayloadDestination = typeof StatusPayloadDestinationSchema.Type;

const payloadDestination = (destination: StatusDestination): StatusPayloadDestination => {
  const address = (destination.desired[0] ?? destination.evidence)?.address;
  const { _tag, adapter, destinationPath, pendingRemoval, sharing, target, targetHealth } =
    destination;
  const observation = destination.observation;
  const { destinationPath: _path, ...observed } = observation;
  return {
    _tag,
    adapter,
    ...(address === undefined ? {} : { address }),
    ...(destination.desired.length > 1
      ? { candidates: destination.desired.map((desired) => desired.address) }
      : {}),
    destinationPath,
    ...(_tag === "matching" ? {} : { observed }),
    ...(pendingRemoval === undefined ? {} : { pendingRemoval }),
    ...(sharing === undefined ? {} : { sharing }),
    target,
    targetHealth,
  };
};

/** Projects the complete status report onto the payload `status --json` publishes. */
export const statusPayload = (report: StatusReport): StatusPayload => {
  const quarantined = report.catalog.issues.filter(
    ({ subject }) => subject._tag === "resource",
  ).length;
  return {
    ...report,
    catalog: {
      quarantined,
      resources: report.catalog.resources.length,
      unavailable: report.catalog.issues.length - quarantined,
    },
    destinations: report.destinations.map(payloadDestination),
  };
};
