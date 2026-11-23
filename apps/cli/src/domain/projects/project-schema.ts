import { Schema } from "effect";
import { CanonicalPathSchema, IdentifierSchema } from "../identity/identity-schema.ts";
import { isSortedUnique } from "../identity/ordering.ts";

/** A canonical project namespace name. */
export const ProjectNameSchema = IdentifierSchema;

/** A non-empty path stored in project state after filesystem canonicalization. */
export const ProjectPathSchema = CanonicalPathSchema;

/** The lifecycle of a registered project namespace. */
export const ProjectLifecycleSchema = Schema.Literals(["active", "removing"]);

/** A durable operator intent that refresh must not infer from transient cleanup evidence. */
const ProjectRemovalIntentSchema = Schema.Literal("project");

const projectUnhealthyRootIssueCodes = [
  "root-access-failed",
  "root-location-changed",
  "root-not-directory",
] as const;

/** Stable unhealthy project-root reasons, excluding a retained missing root. */
export const ProjectUnhealthyRootIssueCodeSchema = Schema.Literals(projectUnhealthyRootIssueCodes);

/** Stable project-root health reasons exposed by inspection and planning. */
export const ProjectRootIssueCodeSchema = Schema.Literals([
  ...projectUnhealthyRootIssueCodes,
  "root-missing",
]);

/** A stable project-root health reason. */
export type ProjectRootIssueCode = typeof ProjectRootIssueCodeSchema.Type;

/** A stable unhealthy project-root reason. */
export type ProjectUnhealthyRootIssueCode = typeof ProjectUnhealthyRootIssueCodeSchema.Type;

/** The persisted identity and roots for one registered project namespace. */
export const ProjectRecordSchema = Schema.Struct({
  gitCommonDirectory: ProjectPathSchema,
  name: ProjectNameSchema,
  removalIntent: Schema.optionalKey(ProjectRemovalIntentSchema),
  removingRoots: Schema.optionalKey(Schema.Array(ProjectPathSchema)),
  roots: Schema.Array(ProjectPathSchema),
}).check(
  Schema.makeFilter((project) => {
    const removingRoots = project.removingRoots ?? [];
    const roots = project.roots;
    const allRoots = [...roots, ...removingRoots];
    return [
      ...(roots.length === 0 && removingRoots.length === 0
        ? ["Removing projects must retain only non-empty handoff roots."]
        : []),
      ...(project.removingRoots !== undefined && removingRoots.length === 0
        ? ["Present handoff-root collections must not be empty."]
        : []),
      ...(project.removalIntent !== undefined && roots.length !== 0
        ? ["Explicit project-removal intent requires the removing lifecycle."]
        : []),
      ...(isSortedUnique(roots)
        ? []
        : ["Active project roots must use unique canonical code-unit ordering."]),
      ...(isSortedUnique(removingRoots)
        ? []
        : ["Handoff project roots must use unique canonical code-unit ordering."]),
      ...(new Set(allRoots).size === allRoots.length
        ? []
        : ["A project cannot repeat an active or handoff root."]),
    ];
  }),
);

/** A validated project registration. */
export type ProjectRecord = typeof ProjectRecordSchema.Type;

/** Published project fields retain the derived removing marker. */
export const ReportedProjectRecordSchema = Schema.Struct({
  ...ProjectRecordSchema.fields,
  lifecycle: Schema.optionalKey(ProjectLifecycleSchema),
}).check(
  Schema.makeFilter((project) => [
    ...(Schema.is(ProjectRecordSchema)(project) ? [] : ["Reported projects need valid roots."]),
    ...(project.lifecycle === undefined ||
    project.lifecycle === (project.roots.length === 0 ? "removing" : "active")
      ? []
      : ["Reported project lifecycle must derive from active roots."]),
  ]),
);

/** Publishes registration fields without nested runtime intent. */
export const projectRecordView = (project: ProjectRecord): ProjectRecord => ({
  name: project.name,
  gitCommonDirectory: project.gitCommonDirectory,
  roots: project.roots,
  ...(project.removingRoots === undefined || project.removingRoots.length === 0
    ? {}
    : { removingRoots: project.removingRoots }),
  ...(project.removalIntent === undefined ? {} : { removalIntent: project.removalIntent }),
});

/** Adds the lifecycle marker where command envelopes have always published it. */
export const reportProjectRecord = (project: ProjectRecord) => ({
  ...projectRecordView(project),
  ...(project.roots.length === 0 ? { lifecycle: "removing" as const } : {}),
});

/** Derives the lifecycle from active roots. */
export const projectLifecycle = (project: ProjectRecord) =>
  project.roots.length === 0 ? ("removing" as const) : ("active" as const);

/** A target selector understood by the application use cases. */
export type TargetSelector =
  | { readonly _tag: "bare" }
  | { readonly _tag: "all" }
  | { readonly _tag: "project"; readonly projectName: string }
  | { readonly _tag: "user" };
