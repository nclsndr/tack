import { Schema } from "effect";
import { HandMadeEntrySchema } from "../agents/hand-made-entry.ts";
import { ManagedLinkEvidenceCollectionSchema } from "../links/managed-link-schema.ts";
import { DocsLinkApplicationSchema, DocsLinkPlanSchema } from "../docs/docs-schema.ts";
import { RemovalPlanSchema, RemovalResultSchema } from "../reconciliation/removal-schema.ts";
import {
  ProjectNameSchema,
  ProjectPathSchema,
  ReportedProjectRecordSchema,
} from "./project-schema.ts";

/** The only project-refresh plan version supported by this release. */
export const projectRefreshPlanVersion = 1 as const;

/** The project registrations addressed by one refresh plan. */
const ProjectRefreshScopeSchema = Schema.Union([
  Schema.TaggedStruct("all", {}),
  Schema.TaggedStruct("project", { projectName: ProjectNameSchema }),
]);

/** Requested refresh selector and the evidence used for a bare request. */
export const ProjectRefreshSelectionSchema = Schema.Struct({
  cwd: Schema.optionalKey(ProjectPathSchema),
  selector: Schema.Union([
    Schema.TaggedStruct("bare", {}),
    Schema.TaggedStruct("all", {}),
    Schema.TaggedStruct("project", { projectName: ProjectNameSchema }),
  ]),
  projectName: Schema.optionalKey(ProjectNameSchema),
  matchedBy: Schema.optionalKey(
    Schema.Union([
      Schema.TaggedStruct("git-directory", { gitCommonDirectory: ProjectPathSchema }),
      Schema.TaggedStruct("containing-root", { root: ProjectPathSchema }),
    ]),
  ),
});

/** A stale root and the safe lifecycle handoff selected by the planner. */
const ProjectRefreshRemovalSchema = Schema.Struct({
  action: Schema.Literals(["deregister", "handoff"]),
  canonicalRoot: ProjectPathSchema,
  finalProject: Schema.Boolean,
  hasManagedEvidence: Schema.Boolean,
  rootReachable: Schema.Boolean,
});

/** The expected project snapshot and deterministic root changes for one refresh. */
const ProjectRefreshProjectSchema = Schema.Struct({
  additions: Schema.Array(ProjectPathSchema),
  expectedManagedLinks: ManagedLinkEvidenceCollectionSchema,
  expectedProject: ReportedProjectRecordSchema,
  observedRoots: Schema.Array(ProjectPathSchema),
  reactivations: Schema.Array(ProjectPathSchema),
  removals: Schema.Array(ProjectRefreshRemovalSchema),
});

/** A deterministic, read-only refresh plan for registered project worktrees. */
const ProjectRefreshPlanSchema = Schema.Struct({
  kind: Schema.Literal("project-refresh-plan"),
  projects: Schema.Array(ProjectRefreshProjectSchema),
  scope: ProjectRefreshScopeSchema,
  version: Schema.Literal(projectRefreshPlanVersion),
});

/** A root transition reported by refresh application. */
const ProjectRefreshChangeSchema = Schema.Struct({
  action: Schema.Literals(["added", "deregistered", "handoff", "reactivated"]),
  canonicalRoot: ProjectPathSchema,
  projectName: ProjectNameSchema,
});

/** A deterministic outcome from applying one refresh plan. */
const ProjectRefreshResultSchema = Schema.Struct({
  changes: Schema.Array(ProjectRefreshChangeSchema),
  removedProjects: Schema.Array(ProjectNameSchema),
  version: Schema.Literal(projectRefreshPlanVersion),
});

export type ProjectRefreshRemoval = typeof ProjectRefreshRemovalSchema.Type;
export type ProjectRefreshScope = typeof ProjectRefreshScopeSchema.Type;
export type ProjectRefreshProject = typeof ProjectRefreshProjectSchema.Type;
export type ProjectRefreshPlan = typeof ProjectRefreshPlanSchema.Type;
export type ProjectRefreshChange = typeof ProjectRefreshChangeSchema.Type;
export type ProjectRefreshResult = typeof ProjectRefreshResultSchema.Type;

/** The only composite project-refresh command format supported by this release. */
export const projectRefreshCommandVersion = 1 as const;

/** A Git refresh paired with the exact cleanup work its handoffs require. */
export const ProjectRefreshCommandPlanSchema = Schema.Struct({
  docs: DocsLinkPlanSchema,
  handMade: Schema.Array(HandMadeEntrySchema).annotate({
    description:
      "Entries in the skill and command folders of the enabled agents, in the roots this refresh adds or reactivates, that Tack has no record of. Refresh leaves them untouched.",
  }),
  kind: Schema.Literal("project-refresh-command-plan"),
  refresh: ProjectRefreshPlanSchema,
  removals: Schema.Array(RemovalPlanSchema),
  selection: ProjectRefreshSelectionSchema,
  version: Schema.Literal(projectRefreshCommandVersion),
});

/** The state and filesystem outcomes from applying one composite refresh plan. */
export const ProjectRefreshCommandResultSchema = Schema.Struct({
  docs: DocsLinkApplicationSchema,
  kind: Schema.Literal("project-refresh-command-application"),
  refresh: ProjectRefreshResultSchema,
  removals: Schema.Array(RemovalResultSchema),
  version: Schema.Literal(projectRefreshCommandVersion),
});

export type ProjectRefreshCommandPlan = typeof ProjectRefreshCommandPlanSchema.Type;
export type ProjectRefreshCommandResult = typeof ProjectRefreshCommandResultSchema.Type;
