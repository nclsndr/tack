import { Schema } from "effect";
import { posixPath as path } from "../identity/portable.ts";
import type { LinkEvidence, LinkRecord } from "../links/link-record-schema.ts";
import { CanonicalPathSchema } from "../identity/identity-schema.ts";
import { isStrictlyInside } from "../identity/path-containment.ts";
import { NextCommandsSchema } from "../hints/next-commands.ts";
import { ProjectNameSchema } from "../projects/project-schema.ts";
import { SkillNameSchema, resourceAddressIdentity } from "../sources/catalog-schema.ts";
import { SourceRegistrationIdSchema } from "../sources/source-schema.ts";
import { compareCodeUnits, sortedUnique } from "../identity/ordering.ts";
import {
  PendingRemovalCauseSchema,
  PendingRemovalLastResultSchema,
} from "../links/pending-removal-schema.ts";

export const DocsResourceReferenceSchema = Schema.Struct({
  sourceRegistrationId: SourceRegistrationIdSchema,
  name: SkillNameSchema,
});
export type DocsResourceReference = typeof DocsResourceReferenceSchema.Type;
/**
 * A docs resource as an operator names it, optionally qualified by source label or ID.
 */
export type DocsResourceRequest = {
  readonly reference: string;
};
/** Compares docs identities without conflating resources from different sources. */
export const docsResourceIdentity = (resource: DocsResourceReference): string =>
  resourceAddressIdentity({ ...resource, kind: "docs" });
export const DocsDestinationSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 &&
    value.startsWith("/") === false &&
    value.includes("\\") === false &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
      ? []
      : ["Docs destination must be a relative path inside each project root."],
  ),
);
export const DocsProjectSchema = Schema.Struct({
  projectName: ProjectNameSchema,
  attachments: Schema.Array(DocsResourceReferenceSchema),
  destination: Schema.optionalKey(DocsDestinationSchema),
  defaultWritingResource: Schema.optionalKey(DocsResourceReferenceSchema),
}).check(
  Schema.makeFilter((value) => {
    const identities = value.attachments.map((entry) => docsResourceIdentity(entry));
    return [
      ...(new Set(identities).size === identities.length
        ? []
        : ["Docs attachments must be unique."]),
      ...(value.defaultWritingResource === undefined ||
      identities.includes(docsResourceIdentity(value.defaultWritingResource))
        ? []
        : ["The default writing resource must be attached."]),
    ];
  }),
);
export type DocsProject = typeof DocsProjectSchema.Type;
export const DocsManagedLinkSchema = Schema.Struct({
  projectName: ProjectNameSchema,
  root: CanonicalPathSchema,
  resource: DocsResourceReferenceSchema,
  destinationPath: CanonicalPathSchema,
  sourceDirectoryPath: CanonicalPathSchema,
}).check(
  Schema.makeFilter((entry) => {
    return isStrictlyInside(entry.root, entry.destinationPath)
      ? []
      : ["Docs evidence must keep its destination inside its root."];
  }),
);
export type DocsManagedLink = typeof DocsManagedLinkSchema.Type;
/** Computes the one canonical raw target for a docs link. */
export const docsRelativeTarget = (
  evidence: Pick<DocsManagedLink, "destinationPath" | "sourceDirectoryPath">,
): string => path.relative(path.dirname(evidence.destinationPath), evidence.sourceDirectoryPath);

/** Adds link text only at the public report boundary. */
export const reportDocsManagedLink = (evidence: DocsManagedLink) => ({
  ...evidence,
  relativeTarget: docsRelativeTarget(evidence),
});

/** Keeps only durable ownership evidence from a public action. */
export const storedDocsManagedLink = (evidence: DocsManagedLink): DocsManagedLink => ({
  projectName: evidence.projectName,
  root: evidence.root,
  resource: evidence.resource,
  destinationPath: evidence.destinationPath,
  sourceDirectoryPath: evidence.sourceDirectoryPath,
});

/** Records the evidence of a docs mount in the one link ledger. */
export const docsLink = (evidence: DocsManagedLink): LinkEvidence => ({
  destinationPath: evidence.destinationPath,
  sourceDirectoryPath: evidence.sourceDirectoryPath,
  resource: {
    kind: "docs",
    name: evidence.resource.name,
    sourceRegistrationId: evidence.resource.sourceRegistrationId,
  },
  target: {
    _tag: "project-root",
    canonicalPath: evidence.root,
    projectName: evidence.projectName,
  },
  delivery: { _tag: "docs" },
});

/** The docs evidence a link holds, or absence for a link of another delivery kind. */
export const managedDocsEvidence = (link: LinkEvidence): DocsManagedLink | undefined =>
  link.delivery._tag === "docs" &&
  link.resource.kind === "docs" &&
  link.target._tag === "project-root"
    ? {
        projectName: link.target.projectName,
        root: link.target.canonicalPath,
        resource: {
          sourceRegistrationId: link.resource.sourceRegistrationId,
          name: link.resource.name,
        },
        destinationPath: link.destinationPath,
        sourceDirectoryPath: link.sourceDirectoryPath,
      }
    : undefined;

/** The docs mounts Tack still manages, in record order. */
export const managedDocsLinksOf = (records: ReadonlyArray<LinkRecord>): DocsManagedLink[] =>
  records.flatMap((record) => {
    const evidence = record.pendingOnly === true ? undefined : managedDocsEvidence(record);
    return evidence === undefined ? [] : [evidence];
  });

/** Published docs evidence still includes derived link text. */
const ReportedDocsManagedLinkSchema = Schema.Struct({
  ...DocsManagedLinkSchema.fields,
  relativeTarget: Schema.String,
}).check(
  Schema.makeFilter((entry) =>
    Schema.is(DocsManagedLinkSchema)(entry) &&
    path.isAbsolute(entry.relativeTarget) === false &&
    path.resolve(path.dirname(entry.destinationPath), entry.relativeTarget) ===
      entry.sourceDirectoryPath
      ? []
      : [
          "Docs evidence must keep its destination inside its root and its relative target must resolve to the recorded source.",
        ],
  ),
);
export type ReportedDocsManagedLink = typeof ReportedDocsManagedLinkSchema.Type;

/** One docs mount whose removal is owed, with why and how its last attempt ended. */
const DocsPendingRemovalSchema = Schema.Struct({
  cause: PendingRemovalCauseSchema,
  evidence: ReportedDocsManagedLinkSchema,
  lastResult: Schema.optionalKey(PendingRemovalLastResultSchema),
});
export type DocsPendingRemoval = typeof DocsPendingRemovalSchema.Type;

/** The docs removals a command reports: unique by destination, in code-unit order. */
export const DocsPendingRemovalsSchema = Schema.Array(DocsPendingRemovalSchema).check(
  sortedUnique((item) => item.evidence.destinationPath, {
    duplicate: "Docs pending removals must be unique by destination path.",
    unordered: "Docs pending removals must use canonical code-unit ordering.",
  }),
);

/** The docs removals the link records owe, in canonical destination order, as every report requires. */
export const docsPendingRemovalsOf = (records: ReadonlyArray<LinkRecord>): DocsPendingRemoval[] =>
  records
    .flatMap((record) => {
      const evidence = managedDocsEvidence(record);
      return record.removal === undefined || evidence === undefined
        ? []
        : [{ ...record.removal, evidence: reportDocsManagedLink(evidence) }];
    })
    .sort((left, right) =>
      compareCodeUnits(left.evidence.destinationPath, right.evidence.destinationPath),
    );

/** Reports actionable docs selection, configuration, and mount failures. */
export class DocsError extends Schema.TaggedError<DocsError>()("DocsError", {
  code: Schema.String,
  message: Schema.String,
  /** Safe public facts that let an operator repair the input, such as ambiguous candidates. */
  details: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  /** The commands the message names as the fix, as data the envelope's `next` is filled from. */
  next: Schema.optionalKey(NextCommandsSchema),
}) {}

/**
 * The stable reason a planned docs link cannot proceed. Each code names one cause, so a program can
 * tell them apart without reading the message.
 */
export const DocsConflictCodeSchema = Schema.Literals([
  "docs-destination-escape",
  "docs-root-moved",
  "docs-parent-not-directory",
  "docs-parent-redirected",
  "docs-parent-unreadable",
  "docs-destination-modified",
  "docs-destination-occupied",
]);
export type DocsConflictCode = typeof DocsConflictCodeSchema.Type;

/** A planned docs link that cannot proceed, with the stable reason. */
const DocsLinkConflictSchema = Schema.Struct({
  action: Schema.Literal("conflict"),
  evidence: ReportedDocsManagedLinkSchema,
  code: DocsConflictCodeSchema,
  message: Schema.String,
});

/** One docs link action, shared by reconciliation and lifecycle reporting. */
const DocsLinkActionSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["create", "remove", "keep"]),
    evidence: ReportedDocsManagedLinkSchema,
  }),
  DocsLinkConflictSchema,
]);
export type DocsLinkAction = typeof DocsLinkActionSchema.Type;

/**
 * The docs mounts a removal plan names, each as the removal Tack is authorized to make or as the
 * conflict apply would refuse: unique by destination.
 */
export const DocsRemovalActionsSchema = Schema.Array(
  Schema.Union([
    Schema.Struct({ action: Schema.Literal("remove"), evidence: ReportedDocsManagedLinkSchema }),
    DocsLinkConflictSchema,
  ]),
).check(
  Schema.makeFilter((actions) =>
    new Set(actions.map((action) => action.evidence.destinationPath)).size === actions.length
      ? []
      : ["Docs link destinations must be unique."],
  ),
);
export type DocsRemovalAction = (typeof DocsRemovalActionsSchema.Type)[number];

/** A resource and, when known, the destination affected by a docs issue. */
const DocsIssueSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  subject: Schema.Struct({
    resource: Schema.optionalKey(DocsResourceReferenceSchema),
    destinationPath: Schema.optionalKey(CanonicalPathSchema),
    projectName: Schema.optionalKey(ProjectNameSchema),
  }),
});
export type DocsIssue = typeof DocsIssueSchema.Type;

/** The proposed docs work, including unavailable resources and known conflicts. */
export const DocsLinkPlanSchema = Schema.Struct({
  actions: Schema.Array(DocsLinkActionSchema),
  complete: Schema.Boolean,
  issues: Schema.Array(DocsIssueSchema),
  kind: Schema.Literal("docs-reconciliation-plan"),
});
export type DocsLinkPlan = typeof DocsLinkPlanSchema.Type;
/** Kept for callers that use the plan's action summary. */
export const DocsLinkReportSchema = DocsLinkPlanSchema;
export type DocsLinkReport = DocsLinkPlan;

/** The outcome for one proposed docs action, in its plan position. */
export const DocsLinkOutcomeSchema = Schema.Union([
  Schema.TaggedStruct("applied", { action: DocsLinkActionSchema }),
  Schema.TaggedStruct("blocked", {
    action: DocsLinkActionSchema,
    code: DocsConflictCodeSchema,
    message: Schema.String,
  }),
  Schema.TaggedStruct("failed", {
    action: DocsLinkActionSchema,
    code: Schema.String,
    message: Schema.String,
  }),
  Schema.TaggedStruct("skipped", {
    action: DocsLinkActionSchema,
    reason: Schema.Literal("recovery-pending"),
  }),
]);
export type DocsLinkOutcome = typeof DocsLinkOutcomeSchema.Type;

/** The result of applying one docs plan, with one outcome for every planned action. */
export const DocsLinkApplicationSchema = Schema.Struct({
  actions: Schema.Array(DocsLinkOutcomeSchema),
  complete: Schema.Boolean,
  issues: Schema.Array(DocsIssueSchema),
  kind: Schema.Literal("docs-reconciliation-application"),
});
export type DocsLinkApplication = typeof DocsLinkApplicationSchema.Type;
