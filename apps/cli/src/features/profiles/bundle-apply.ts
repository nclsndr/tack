import { Effect, FileSystem, Path, Schema } from "effect";
import { BundleManifestSchema } from "../../domain/bundles/bundle-schema.ts";
import type { SyncPlan } from "../reconciliation/sync-command.ts";
import { readBundleArchive } from "./bundle-read.ts";
import {
  inspectProfileTarget,
  withProfileApplication,
  type ProfileTargetRequest,
} from "./profile-target.ts";
import { planBundleRetention, writeBundlePayload } from "./bundle-retention.ts";
import { inspectBundleProjection, withBundleSources } from "./bundle-snapshot.ts";
import {
  planProfileApply,
  profileApplyPlanFields,
  type ProfileApplyExecution,
  type ProfileApplyPlan,
} from "./profile-apply.ts";
import { applySyncPlan } from "../reconciliation/sync-command.ts";
import { recoverLinkJournal } from "../links/link-settlement.ts";
import {
  readInvocationSnapshot,
  writerInvocationSnapshot,
  type CommandSnapshot,
} from "../snapshot/command-snapshot.ts";
import { withStateCheckpointWriter, type StateOptions } from "../../services/state-store.ts";

export type BundleApplyRequest = ProfileTargetRequest & {
  readonly file: string;
  readonly apply: boolean;
  readonly cwd: string;
};
/**
 * The `profile apply-bundle` plan payload: a fixed profile application of the verified bundle,
 * with its manifest once read and the sources it retains for it.
 */
export const BundleApplyPlanSchema = Schema.Struct({
  kind: Schema.Literal("profile-apply-bundle"),
  ...profileApplyPlanFields,
  bundle: Schema.optionalKey(BundleManifestSchema),
  sources: Schema.Array(
    Schema.Struct({ sourceKey: Schema.String, registrationId: Schema.String, path: Schema.String }),
  ),
});

/** A `profile apply-bundle` plan, with the sync plan its delivery applies like `profile apply`. */
export type BundleApplyPlan = typeof BundleApplyPlanSchema.Type & { readonly sync?: SyncPlan };
export type BundleApplyResult = ProfileApplyExecution<BundleApplyPlan>;
const refusal = (file: string, findings: ProfileApplyPlan["findings"]): BundleApplyPlan => ({
  kind: BundleApplyPlanSchema.fields.kind.literal,
  reference: file,
  targets: [],
  existing: [],
  direct: [],
  required: [],
  delivery: { notes: [], incomplete: false },
  effects: [],
  findings,
  refused: true,
  sources: [],
});

const prepareBundleApply = Effect.fnUntraced(function* (
  options: StateOptions,
  request: BundleApplyRequest,
  snapshot: CommandSnapshot,
) {
  const boundary = yield* inspectProfileTarget(snapshot.state, options, request);
  if (boundary.findings.length > 0)
    return {
      plan: {
        ...refusal(request.file, boundary.findings),
        targets: boundary.targets,
        existing: boundary.existing,
      },
      retention: undefined,
    };
  const archive = yield* readBundleArchive(request.file);
  const retention = yield* planBundleRetention(snapshot.state, options, archive.manifest);
  const verified = yield* inspectBundleProjection(
    snapshot.state,
    retention.registrations,
    archive.manifest,
    archive.entries,
  );
  const applied = yield* planProfileApply(
    options,
    { ...request, reference: verified.reference },
    verified.snapshot,
    verified.verifiedProfile,
  );
  const plan: BundleApplyPlan = {
    ...applied,
    kind: BundleApplyPlanSchema.fields.kind.literal,
    bundle: archive.manifest,
    sources: retention.registrations.map((source) => ({
      sourceKey: source.bundle?.sourceKey ?? "",
      registrationId: source.id,
      path: source.canonicalPath,
    })),
  };
  return { plan, retention: { ...retention, archive } };
});

/** Validates complete boundary and artifact before retaining/registering projections or replacing intent. */
export const runBundleApply = Effect.fnUntraced(function* (
  options: StateOptions,
  request: BundleApplyRequest,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const preview = yield* prepareBundleApply(
        options,
        request,
        yield* readInvocationSnapshot(options),
      );
      if (request.apply === false || preview.plan.refused === true) return { plan: preview.plan };
      return yield* withStateCheckpointWriter(options, (writer) =>
        Effect.gen(function* () {
          let prepared = yield* prepareBundleApply(
            options,
            request,
            yield* writerInvocationSnapshot(writer.current()),
          );
          if (prepared.plan.refused === true || prepared.retention === undefined)
            return { plan: prepared.plan };
          // Recovery is authorized only after the entire target and incoming projection pass preflight.
          yield* recoverLinkJournal(writer);
          prepared = yield* prepareBundleApply(
            options,
            request,
            yield* writerInvocationSnapshot(writer.current()),
          );
          const { retention, plan } = prepared;
          if (
            plan.refused === true ||
            retention === undefined ||
            plan.application === undefined ||
            plan.sync === undefined
          )
            return { plan };
          if (retention.reuse === false) {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            yield* fs.makeDirectory(path.dirname(retention.directory), { recursive: true });
            yield* writeBundlePayload(
              retention.directory,
              retention.archive.entries,
              retention.archive.manifest,
            );
          }
          const application = plan.application;
          yield* writer.checkpoint((state) =>
            Effect.succeed({
              state: withProfileApplication(
                withBundleSources(state, retention.registrations),
                application,
              ),
              value: undefined,
            }),
          );
          return { plan, applied: yield* applySyncPlan(writer, plan.sync) };
        }),
      );
    }),
  ).pipe(
    Effect.catchTag("BundleError", (error) =>
      Effect.succeed({
        plan: refusal(request.file, [{ code: error.code, message: error.message }]),
      }),
    ),
    Effect.map((result): BundleApplyResult => result),
  );
});
