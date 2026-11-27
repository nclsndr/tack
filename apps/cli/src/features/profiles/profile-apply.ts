import { Effect, Schema } from "effect";
import {
  ResourceAddressSchema,
  resourceAddressIdentity,
} from "../../domain/sources/catalog-schema.ts";
import {
  ProfileApplicationSchema,
  type ProfileApplication,
} from "../../domain/state/profile-application-schema.ts";
import { ProfilePlanFindingSchema } from "../../domain/profiles/profile-schema.ts";
import { DocsLinkApplicationSchema } from "../../domain/docs/docs-schema.ts";
import { ReconciliationApplyResultSchema } from "../../domain/reconciliation/reconciliation-application-schema.ts";
import {
  profileDelivery,
  ProfileDeliverySkipSchema,
} from "../../domain/profiles/profile-delivery.ts";
import { readRegisteredProfile, type RegisteredProfile } from "./profile-reference.ts";
import {
  makeCommandSnapshot,
  readInvocationSnapshot,
  writerInvocationSnapshot,
  type CommandSnapshot,
} from "../snapshot/command-snapshot.ts";
import {
  inspectProfileTarget,
  withProfileApplication,
  type ProfileTargetRequest,
} from "./profile-target.ts";
import {
  applySyncPlan,
  planSync,
  type SyncApplication,
  type SyncPlan,
} from "../reconciliation/sync-command.ts";
import type { PreviewOrApplied } from "../../domain/plan-and-apply.ts";
import { recoverLinkJournal } from "../links/link-settlement.ts";
import {
  withStateCheckpointWriter,
  type StateCheckpointWriter,
  type StateOptions,
} from "../../services/state-store.ts";

export type ProfileApplyRequest = ProfileTargetRequest & {
  readonly reference: string;
  readonly apply: boolean;
  readonly cwd: string;
};
/**
 * The fields a fixed profile application plans, shared by `profile apply` and
 * `profile apply-bundle`: the target, the existing selection it replaces, the fixed members, why it
 * refuses, and the delivery it would make.
 */
export const profileApplyPlanFields = {
  reference: Schema.String,
  targets: Schema.Array(Schema.String),
  existing: Schema.Array(Schema.String),
  direct: Schema.Array(ResourceAddressSchema),
  required: Schema.Array(ResourceAddressSchema),
  findings: Schema.Array(ProfilePlanFindingSchema),
  refused: Schema.Boolean,
  delivery: Schema.Struct({
    notes: Schema.Array(Schema.String),
    skipped: Schema.Array(ProfileDeliverySkipSchema),
    incomplete: Schema.Boolean,
  }),
  effects: Schema.Array(Schema.String),
  application: Schema.optionalKey(ProfileApplicationSchema),
};

/** The `profile apply` plan payload. */
export const ProfileApplyPlanSchema = Schema.Struct({
  kind: Schema.Literal("profile-apply"),
  ...profileApplyPlanFields,
});

/**
 * A `profile apply` plan. Once the target and members pass, it carries the sync plan its delivery
 * applies; the payload publishes that plan as it is.
 */
export type ProfileApplyPlan = typeof ProfileApplyPlanSchema.Type & { readonly sync?: SyncPlan };

/**
 * The sync a profile application applied, as its payload publishes it. A profile always plans its
 * agent links, since it never narrows them away as `sync --no-adapters` does.
 */
export const ProfileDeliveryApplicationSchema = Schema.Struct({
  resources: ReconciliationApplyResultSchema,
  docs: Schema.Array(DocsLinkApplicationSchema),
});

/** A fixed profile application's plan, and what its delivery did once applied. */
export type ProfileApplyExecution<Plan extends { readonly sync?: SyncPlan } = ProfileApplyPlan> =
  PreviewOrApplied<Plan, SyncApplication>;

/** Validates reachable registered sources and the complete target before preparing fixed delivery. */
export const planProfileApply = Effect.fnUntraced(function* (
  options: StateOptions,
  request: ProfileApplyRequest,
  snapshot: CommandSnapshot,
  verifiedProfile?: RegisteredProfile,
) {
  const boundary = yield* inspectProfileTarget(snapshot.state, options, request);
  const findings = [...boundary.findings];
  const base = {
    kind: ProfileApplyPlanSchema.fields.kind.literal,
    reference: request.reference,
    targets: boundary.targets,
    existing: boundary.existing,
    direct: [],
    required: [],
    delivery: { notes: [], skipped: [], incomplete: false },
    effects: [],
  };
  const loaded =
    verifiedProfile === undefined
      ? yield* readRegisteredProfile(snapshot, request.reference)
      : {
          resolved: verifiedProfile,
          findings: verifiedProfile.inventory.findings.filter(
            (finding) => finding.severity === "error",
          ),
        };
  findings.push(...loaded.findings);
  if (loaded.resolved === undefined)
    return { ...base, findings, refused: true } satisfies ProfileApplyPlan;
  const { owner, profile, inventory } = loaded.resolved;
  const omissionNotes = inventory.findings
    .filter((finding) => finding.severity === "warning")
    .map((finding) => finding.message);
  const application: ProfileApplication = {
    namespace: request.namespace,
    profileName: profile.name,
    sourceRegistrationId: owner.registration.id,
    direct: inventory.direct,
    inventory: [
      ...new Map(
        [...inventory.direct, ...inventory.required].map((address) => [
          resourceAddressIdentity(address),
          address,
        ]),
      ).values(),
    ],
    targets: boundary.targets,
  };
  if (
    request.namespace._tag === "user" &&
    application.inventory.some((address) => address.kind === "docs")
  )
    findings.push({
      code: "profile-docs-require-project",
      message:
        "Docs need a project target. Choose a project or explicitly remove docs from this profile before user application.",
    });
  if (findings.length > 0)
    return {
      ...base,
      ...inventory,
      findings,
      application,
      delivery: { notes: omissionNotes, skipped: [], incomplete: false },
      refused: true,
    } satisfies ProfileApplyPlan;
  const staged = yield* makeCommandSnapshot(
    withProfileApplication(snapshot.state, application),
    snapshot,
  );
  const sync = yield* planSync(
    options,
    {
      apply: false,
      cwd: request.cwd,
      includeOptional: false,
      noDocs: false,
      selector: request.namespace,
    },
    staged,
  );
  if (sync.resources?.plan.units.some((unit) => unit.summary.collision > 0))
    findings.push({
      code: "profile-delivery-collision",
      message:
        "Several profile members need the same delivery name. Edit the manifest to choose one before applying; no winner is selected.",
    });
  const effects = [
    ...(sync.resources?.plan.units ?? []).flatMap((unit) => [
      ...unit.actions.map(
        (action) =>
          `${action._tag}: ${"destinationPath" in action ? action.destinationPath : action.directoryPath}`,
      ),
      ...unit.conflicts.map(
        (conflict) =>
          `${conflict._tag}: ${"destinationPath" in conflict ? conflict.destinationPath : unit.target.canonicalPath}`,
      ),
    ]),
    ...sync.docs.flatMap((plan) =>
      plan.actions.map((action) => `docs ${action.action}: ${action.evidence.destinationPath}`),
    ),
  ];
  const delivery = profileDelivery(application, snapshot.state.data.enabledAdapters);
  return {
    ...base,
    direct: inventory.direct,
    required: inventory.required,
    findings,
    application,
    sync,
    delivery: { ...delivery, notes: [...omissionNotes, ...delivery.notes] },
    effects,
    refused: findings.length > 0,
  } satisfies ProfileApplyPlan;
});

/**
 * A pending link journal is an input to a profile preflight: an entry of another context refuses
 * the profile, and an entry of its target counts as existing selection. So the plan under the
 * writer lock reads the journal as it is, and only a plan that `passes` recovers it; the use case
 * then replans from the recovered document. A refused plan leaves the journal untouched.
 */
export const recoverAfterPreflight = Effect.fnUntraced(function* <Prepared, E, R>(
  writer: StateCheckpointWriter,
  prepare: (snapshot: CommandSnapshot) => Effect.Effect<Prepared, E, R>,
  passes: (prepared: Prepared) => boolean,
) {
  const preflight = yield* prepare(yield* writerInvocationSnapshot(writer.current()));
  if (passes(preflight) === false) return preflight;
  yield* recoverLinkJournal(writer);
  return yield* prepare(yield* writerInvocationSnapshot(writer.current()));
});

/** A plan that passed, so it carries the intent it retains and the delivery it applies. */
export const isApplicablePlan = <
  Plan extends {
    readonly refused: boolean;
    readonly application?: ProfileApplication;
    readonly sync?: SyncPlan;
  },
>(
  plan: Plan,
): plan is Plan & { readonly application: ProfileApplication; readonly sync: SyncPlan } =>
  plan.refused === false && plan.application !== undefined && plan.sync !== undefined;

/** Replans under the writer lock, retains exact intent, then uses ordinary ownership-safe delivery. */
export const runProfileApply = Effect.fn("profiles.runProfileApply")(function* (
  options: StateOptions,
  request: ProfileApplyRequest,
) {
  const preview: ProfileApplyPlan = yield* planProfileApply(
    options,
    request,
    yield* readInvocationSnapshot(options),
  );
  if (request.apply === false || preview.refused === true) return { plan: preview };
  return yield* withStateCheckpointWriter(options, (writer) =>
    Effect.gen(function* () {
      const plan: ProfileApplyPlan = yield* recoverAfterPreflight(
        writer,
        (snapshot) => planProfileApply(options, request, snapshot),
        isApplicablePlan,
      );
      if (isApplicablePlan(plan) === false) return { plan };
      yield* writer.checkpoint((state) =>
        Effect.succeed({
          state: withProfileApplication(state, plan.application),
          value: undefined,
        }),
      );
      return { plan, applied: yield* applySyncPlan(writer, plan.sync) };
    }),
  );
});
