import { Schema } from "effect";
import { SkillChoiceSchema } from "../choices/choice-schema.ts";
import { ProjectNameSchema } from "../projects/project-schema.ts";
import { DocsResourceReferenceSchema } from "../docs/docs-schema.ts";
import type { StateProject } from "../state/state-schema.ts";

/**
 * The operator intent that removing a source or a project deletes with it. Previews list it so the
 * operator sees every pick and docs attachment that goes, not only the links.
 */

/** A pick that the removal deletes, with the namespace that held it. */
export const DroppedPickSchema = SkillChoiceSchema;

/** A docs attachment that the removal detaches, with the project that held it. */
export const DroppedDocsAttachmentSchema = Schema.Struct({
  projectName: ProjectNameSchema,
  ...DocsResourceReferenceSchema.fields,
  writingDefault: Schema.optionalKey(Schema.Literal(true)),
});

/** A pick that a removal deletes. */
export type DroppedPick = typeof DroppedPickSchema.Type;

/** A docs attachment that a removal detaches. */
export type DroppedDocsAttachment = typeof DroppedDocsAttachmentSchema.Type;

/** The picks of one project, each with its namespace, kept only when `keep` holds. */
export const projectPicks = (
  project: StateProject,
  keep: (pick: DroppedPick) => boolean = () => true,
): ReadonlyArray<DroppedPick> =>
  (project.choices ?? [])
    .map((choice): DroppedPick => ({
      ...choice,
      namespace: { _tag: "project", projectName: project.name },
    }))
    .filter(keep);

/** The docs attachments of one project, each with its project, kept only when `keep` holds. */
export const projectDocsAttachments = (
  project: StateProject,
  keep: (attachment: DroppedDocsAttachment) => boolean = () => true,
): ReadonlyArray<DroppedDocsAttachment> =>
  (project.docs?.attachments ?? [])
    .map((attachment): DroppedDocsAttachment => ({ projectName: project.name, ...attachment }))
    .filter(keep);
