import { Effect, Schema } from "effect";
import { ChoiceNamespaceSchema } from "../../domain/choices/choice-schema.ts";
import {
  DroppedDocsAttachmentSchema,
  DroppedPickSchema,
  projectDocsAttachments,
  projectPicks,
} from "../../domain/reconciliation/dropped-intent-schema.ts";
import {
  RemovalPlanSchema,
  RemovalProjectNotFoundError,
  RemovalResultSchema,
} from "../../domain/reconciliation/removal-schema.ts";
import { ProjectNameSchema } from "../../domain/projects/project-schema.ts";
import { profileApplicationFor } from "../../domain/profiles/profile-application.ts";
import { SourceRegistrationIdSchema } from "../../domain/sources/source-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";
import type { StateCheckpointWriter, StateOptions } from "../../services/state-store.ts";
import { applyRemovalWithWriter } from "../removal/removal-apply.ts";
import { planRemovalFromState } from "../removal/removal-plan.ts";
import { previewOrApply } from "../writer/recovered-writer.ts";

/** The fixed profile application a removed project drops with it. */
const DroppedProfileApplicationSchema = Schema.Struct({
  namespace: ChoiceNamespaceSchema,
  profileName: Schema.String,
  sourceRegistrationId: SourceRegistrationIdSchema,
});

/** What removing one whole project deletes, with the cleanup of every link and docs mount it has. */
export const ProjectRemovalPlanSchema = Schema.Struct({
  kind: Schema.Literal("project-removal-plan"),
  version: Schema.Literal(1),
  project: ProjectNameSchema,
  removal: RemovalPlanSchema,
  picks: Schema.Array(DroppedPickSchema),
  docsAttachments: Schema.Array(DroppedDocsAttachmentSchema),
  profileApplication: Schema.optionalKey(DroppedProfileApplicationSchema),
});

/** The outcome of applying one project removal plan. */
export const ProjectRemovalResultSchema = Schema.Struct({
  kind: Schema.Literal("project-removal-application"),
  version: Schema.Literal(1),
  project: ProjectNameSchema,
  removal: RemovalResultSchema,
});

/** A validated project removal plan. */
export type ProjectRemovalPlan = typeof ProjectRemovalPlanSchema.Type;

const planFromState = Effect.fnUntraced(function* (state: State, projectName: string) {
  const project = state.data.projects.find((candidate) => candidate.name === projectName);
  if (project === undefined) return yield* new RemovalProjectNotFoundError({ projectName });
  const removal = yield* planRemovalFromState(state, {
    cause: "project-removal",
    scope: { _tag: "project", projectName },
  });
  const application = profileApplicationFor(state, { _tag: "project", projectName });
  return {
    kind: "project-removal-plan",
    version: 1,
    project: projectName,
    removal,
    picks: projectPicks(project),
    docsAttachments: projectDocsAttachments(project),
    ...(application === undefined
      ? {}
      : {
          profileApplication: {
            namespace: application.namespace,
            profileName: application.profileName,
            sourceRegistrationId: application.sourceRegistrationId,
          },
        }),
  } satisfies ProjectRemovalPlan;
});

const applyPlan = Effect.fnUntraced(function* (
  writer: StateCheckpointWriter,
  plan: ProjectRemovalPlan,
) {
  const removal = yield* applyRemovalWithWriter(writer, plan.removal);
  return {
    kind: "project-removal-application",
    version: 1,
    project: plan.project,
    removal,
  } satisfies typeof ProjectRemovalResultSchema.Type;
});

/**
 * Plans or applies the removal of one whole registered project: every link and docs mount Tack
 * made in its roots, then the project with its picks, docs settings and fixed profile application.
 * A link that cannot be removed safely keeps the project in removal until a later apply or
 * `state clean --pending` settles it. The worktrees are never touched.
 */
export const removeProject = (
  stateOptions: StateOptions,
  projectName: string,
  options: { readonly apply: boolean },
) =>
  previewOrApply(stateOptions, {
    apply: options.apply,
    plan: ({ state }) => planFromState(state, projectName),
    applyPlan,
  });
