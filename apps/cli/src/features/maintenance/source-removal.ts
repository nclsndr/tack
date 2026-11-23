import { Effect, Schema } from "effect";
import { ChoiceNamespaceSchema } from "../../domain/choices/choice-schema.ts";
import {
  DroppedDocsAttachmentSchema,
  DroppedPickSchema,
  projectDocsAttachments,
  projectPicks,
  type DroppedPick,
} from "../../domain/reconciliation/dropped-intent-schema.ts";
import {
  RemovalPlanSchema,
  RemovalResultSchema,
} from "../../domain/reconciliation/removal-schema.ts";
import { ResourceAddressSchema } from "../../domain/sources/catalog-schema.ts";
import type { DeclaredSourceInspection } from "../../domain/sources/source-inspection.ts";
import {
  SourceRegistrationIdSchema,
  type SourceRegistration,
} from "../../domain/sources/source-schema.ts";
import { CanonicalPathSchema } from "../../domain/identity/identity-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import type { State, StateProject } from "../../domain/state/state-schema.ts";
import type { StateCheckpointWriter, StateOptions } from "../../services/state-store.ts";
import { applyRemovalWithWriter } from "../removal/removal-apply.ts";
import { planRemoval } from "../removal/removal-plan.ts";
import type { CommandSnapshot } from "../snapshot/command-snapshot.ts";
import { previewOrApply } from "../writer/recovered-writer.ts";

/** The registered source a removal names, as the operator knows it. */
const RemovedSourceSchema = Schema.Struct({
  id: SourceRegistrationIdSchema,
  canonicalPath: CanonicalPathSchema,
  /** Absent when the source has no usable label, such as a source that is gone. */
  label: Schema.optionalKey(Schema.String),
});

/**
 * A fixed profile application that depends on the removed source. One the source publishes is
 * `dropped`, which returns its namespace to daily selection on its next sync; one that only holds
 * members of the source is kept and reports those members as `unresolved`.
 */
const AffectedProfileApplicationSchema = Schema.Struct({
  namespace: ChoiceNamespaceSchema,
  profileName: Schema.String,
  sourceRegistrationId: SourceRegistrationIdSchema,
  outcome: Schema.Literals(["dropped", "unresolved"]),
  /** Every retained member of a dropped application; the source's members of an unresolved one. */
  members: Schema.Array(ResourceAddressSchema),
});

/** A registered source that refers to the removed source and is left with a dangling reference. */
const DependantSourceSchema = Schema.Struct({
  sourceRegistrationId: SourceRegistrationIdSchema,
  label: Schema.optionalKey(Schema.String),
  /** `depends-on` names the source's label; `bundle-binding` binds a bundle label to its ID. */
  reason: Schema.Literals(["depends-on", "bundle-binding"]),
});

/** What removing one source deletes and affects, with the cleanup of its links and docs mounts. */
export const SourceRemovalPlanSchema = Schema.Struct({
  kind: Schema.Literal("source-removal-plan"),
  version: Schema.Literal(1),
  source: RemovedSourceSchema,
  removal: RemovalPlanSchema,
  picks: Schema.Array(DroppedPickSchema),
  docsAttachments: Schema.Array(DroppedDocsAttachmentSchema),
  profileApplications: Schema.Array(AffectedProfileApplicationSchema),
  dependants: Schema.Array(DependantSourceSchema),
});

/** The outcome of applying one source removal plan. */
export const SourceRemovalResultSchema = Schema.Struct({
  kind: Schema.Literal("source-removal-application"),
  version: Schema.Literal(1),
  source: RemovedSourceSchema,
  removal: RemovalResultSchema,
});

/** A validated source removal plan. */
export type SourceRemovalPlan = typeof SourceRemovalPlanSchema.Type;

/** Reports a source reference that names no removable registration. */
export class SourceRemovalError extends Schema.TaggedError<SourceRemovalError>()(
  "SourceRemovalError",
  {
    code: Schema.Literals([
      "source-not-found",
      "source-label-ambiguous",
      "source-builtin",
      "source-bundle-provided",
    ]),
    message: Schema.String,
    /** The registration IDs an ambiguous label names, for the operator to choose from. */
    candidates: Schema.Array(Schema.String),
  },
) {}

const isRegistrationId = Schema.is(SourceRegistrationIdSchema);

const refuse = (
  code: SourceRemovalError["code"],
  message: string,
  candidates: ReadonlyArray<string> = [],
) => Effect.fail(new SourceRemovalError({ code, message, candidates }));

/**
 * Resolves a source label or registration ID to exactly one removable inspection. A source that is
 * gone has no label, so only its registration ID names it.
 */
const resolveRemovedSource = (
  inspections: ReadonlyArray<DeclaredSourceInspection>,
  reference: string,
) => {
  const matches = inspections.filter((inspection) =>
    isRegistrationId(reference)
      ? inspection.registration.id === reference
      : inspection.label === reference,
  );
  const [only] = matches;
  if (matches.length > 1)
    return refuse(
      "source-label-ambiguous",
      `Source label ${reference} belongs to several registrations. Use one registration ID.`,
      matches.map((inspection) => inspection.registration.id).sort(compareCodeUnits),
    );
  if (only === undefined)
    return refuse(
      "source-not-found",
      `No registered source has the label or registration ID ${reference}. A source that is gone has no label: use its registration ID from \`tack source\`.`,
    );
  if (only.origin === "builtin")
    return refuse("source-builtin", "The built-in source ships with Tack and cannot be removed.");
  if (only.registration.bundle !== undefined)
    return refuse(
      "source-bundle-provided",
      "A bundle-provided source keeps verified content under the state directory, and source remove does not remove it.",
    );
  return Effect.succeed(only);
};

const fromSource = (id: string) => (address: { readonly sourceRegistrationId: string }) =>
  address.sourceRegistrationId === id;

/** Every pick of the source's resources: the user namespace's first, then each project's. */
const sourcePicks = (state: State, id: string): ReadonlyArray<DroppedPick> => [
  ...state.data.userChoices
    .filter((choice) => fromSource(id)(choice.address))
    .map((choice): DroppedPick => ({ ...choice, namespace: { _tag: "user" } })),
  ...state.data.projects.flatMap((project) =>
    projectPicks(project, (pick) => fromSource(id)(pick.address)),
  ),
];

const affectedApplications = (state: State, id: string) =>
  (state.data.profileApplications ?? []).flatMap((application) => {
    const dropped = application.sourceRegistrationId === id;
    const members = dropped
      ? application.inventory
      : application.inventory.filter((address) => fromSource(id)(address));
    return dropped || members.length > 0
      ? [
          {
            namespace: application.namespace,
            profileName: application.profileName,
            sourceRegistrationId: application.sourceRegistrationId,
            outcome: dropped ? ("dropped" as const) : ("unresolved" as const),
            members,
          },
        ]
      : [];
  });

const dependantsOf = (
  inspections: ReadonlyArray<DeclaredSourceInspection>,
  removed: DeclaredSourceInspection,
) =>
  inspections.flatMap((inspection) => {
    if (inspection.registration.id === removed.registration.id) return [];
    const label = inspection.label === undefined ? {} : { label: inspection.label };
    const id = inspection.registration.id;
    return [
      ...(removed.label !== undefined && (inspection.dependsOn ?? []).includes(removed.label)
        ? [{ sourceRegistrationId: id, ...label, reason: "depends-on" as const }]
        : []),
      ...(Object.values(inspection.registration.bundle?.bindings ?? {}).includes(
        removed.registration.id,
      )
        ? [{ sourceRegistrationId: id, ...label, reason: "bundle-binding" as const }]
        : []),
    ];
  });

const removedSource = (inspection: DeclaredSourceInspection) => ({
  id: inspection.registration.id,
  canonicalPath: inspection.registration.canonicalPath,
  ...(inspection.label === undefined ? {} : { label: inspection.label }),
});

const planFromSnapshot = Effect.fnUntraced(function* (
  snapshot: CommandSnapshot,
  reference: string,
) {
  const { state } = snapshot;
  const inspections = yield* snapshot.sourceInspections;
  const inspection = yield* resolveRemovedSource(inspections, reference);
  const id = inspection.registration.id;
  const removal = yield* planRemoval(state, {
    cause: "clean",
    scope: { _tag: "source", sourceRegistrationId: id },
  });
  return {
    kind: "source-removal-plan",
    version: 1,
    source: removedSource(inspection),
    removal,
    picks: sourcePicks(state, id),
    docsAttachments: state.data.projects.flatMap((project) =>
      projectDocsAttachments(project, fromSource(id)),
    ),
    profileApplications: affectedApplications(state, id),
    dependants: dependantsOf(inspections, inspection),
  } satisfies SourceRemovalPlan;
});

const withoutSourceIntent = (project: StateProject, id: string): StateProject => ({
  ...project,
  ...(project.choices === undefined
    ? {}
    : { choices: project.choices.filter((choice) => fromSource(id)(choice.address) === false) }),
  ...(project.docs === undefined
    ? {}
    : {
        docs: {
          ...project.docs,
          attachments: project.docs.attachments.filter(
            (attachment) => fromSource(id)(attachment) === false,
          ),
        },
      }),
});

/**
 * Forgets one source registration and the intent that names it: its picks in every namespace, its
 * docs attachments and the fixed profile applications it publishes. Link evidence alone authorizes
 * any cleanup still owed, so nothing waits for that cleanup to settle.
 */
const withoutSource = (state: State, registration: Pick<SourceRegistration, "id">): State => {
  const id = registration.id;
  const applications = state.data.profileApplications;
  return {
    ...state,
    data: {
      ...state.data,
      sources: state.data.sources.filter((source) => source.id !== id),
      userChoices: state.data.userChoices.filter(
        (choice) => fromSource(id)(choice.address) === false,
      ),
      projects: state.data.projects.map((project) => withoutSourceIntent(project, id)),
      ...(applications === undefined
        ? {}
        : {
            profileApplications: applications.filter(
              (application) => application.sourceRegistrationId !== id,
            ),
          }),
    },
  };
};

const applyPlan = Effect.fnUntraced(function* (
  writer: StateCheckpointWriter,
  plan: SourceRemovalPlan,
) {
  const removal = yield* applyRemovalWithWriter(writer, plan.removal, (state) =>
    withoutSource(state, plan.source),
  );
  return {
    kind: "source-removal-application",
    version: 1,
    source: plan.source,
    removal,
  } satisfies typeof SourceRemovalResultSchema.Type;
});

/**
 * Plans or applies the removal of one registered source, named by its label or registration ID:
 * every link and docs mount Tack made for its resources, in every project and at user level, and
 * then its registration and the intent that names it. The source directory is never touched.
 */
export const removeSource = Effect.fn("maintenance.removeSource")(function* (
  stateOptions: StateOptions,
  reference: string,
  options: { readonly apply: boolean },
) {
  return yield* previewOrApply(stateOptions, {
    apply: options.apply,
    plan: (snapshot) => planFromSnapshot(snapshot, reference),
    applyPlan,
  });
});
