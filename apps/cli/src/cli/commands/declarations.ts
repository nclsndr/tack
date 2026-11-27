import { Schema } from "effect";
import { CheckReportSchema } from "../../domain/check/check-schema.ts";
import { DoctorReportSchema } from "../../domain/doctor/doctor-schema.ts";
import {
  HistoryListPayloadSchema,
  HistoryRecordSchema,
  ScriptRunPayloadSchema,
  ScriptShowPayloadSchema,
} from "../../domain/execution/execution-schema.ts";
import { GuideIndexSchema, GuideSchema } from "../../domain/guides/guide-schema.ts";
import {
  ImportApplicationSchema,
  ImportListSchema,
  ImportPlanSchema,
  ImportRemovalApplicationSchema,
  ImportRemovalPlanSchema,
} from "../../domain/imports/import-schema.ts";
import { RemovalResultSchema } from "../../domain/reconciliation/removal-schema.ts";
import { SyncApplicationSchema, SyncPlanSchema } from "../../domain/reconciliation/sync-schema.ts";
import { UpgradeGuideSchema } from "../../domain/self/upgrade-guide.ts";
import { InitApplicationSchema, InitPlanSchema } from "../../domain/setup/machine-init-schema.ts";
import { CatalogReportSchema } from "../../domain/sources/catalog-report.ts";
import { StatusPayloadSchema } from "../../domain/status/status-schema.ts";
import {
  ChoiceChangePayloadSchema,
  ChoiceListPayloadSchema,
  ChoiceRemovalPayloadSchema,
} from "../../features/choices/choice.ts";
import {
  DocsListPayloadSchema,
  DocsSettingsPayloadSchema,
  DocsTargetPayloadSchema,
} from "../../features/docs/docs.ts";
import {
  HistoryClearApplicationSchema,
  HistoryClearPlanSchema,
} from "../../features/execution/execution.ts";
import { TypesPlanSchema } from "../../features/execution/script-types.ts";
import { SourceListPayloadSchema } from "../../features/imports/import-display.ts";
import {
  AdapterDisablementPlanSchema,
  AdapterDisablementResultSchema,
} from "../../features/maintenance/adapter-disablement.ts";
import {
  ProjectRemovalPlanSchema,
  ProjectRemovalResultSchema,
} from "../../features/maintenance/project-removal.ts";
import { SelectedRemovalPlanSchema } from "../../features/maintenance/selected-removal.ts";
import {
  SourceRemovalPlanSchema,
  SourceRemovalResultSchema,
} from "../../features/maintenance/source-removal.ts";
import { BundleApplyPlanSchema } from "../../features/profiles/bundle-apply.ts";
import {
  BundleExportedSchema,
  BundleExportPlanSchema,
} from "../../features/profiles/bundle-export.ts";
import { BundleInspectionPayloadSchema } from "../../features/profiles/bundle-read.ts";
import {
  ProfileApplyPlanSchema,
  ProfileDeliveryApplicationSchema,
} from "../../features/profiles/profile-apply.ts";
import {
  ProfileAdoptedSchema,
  ProfileAdoptPlanSchema,
  ProfileSavedSchema,
  ProfileSavePlanSchema,
} from "../../features/profiles/profile-copy.ts";
import {
  ProjectInspectionsPayloadSchema,
  ProjectRegistrationPayloadSchema,
} from "../../features/projects/project.ts";
import { DocsIconsPayloadSchema } from "../../features/reader/icon-lookup.ts";
import { ReaderSearchPayloadSchema } from "../../features/reader/search.ts";
import { ReaderSessionPayloadSchema } from "../../features/reader/session.ts";
import {
  AdapterListPayloadSchema,
  AdapterSettingsPayloadSchema,
} from "../../features/reconciliation/agent.ts";
import {
  ProjectRefreshCommandPlanSchema,
  ProjectRefreshCommandResultSchema,
} from "../../features/refresh/project-refresh-schema.ts";
import { SourceScaffoldPlanSchema } from "../../features/sources/source-scaffold.ts";
import {
  SourceRegistrationPayloadSchema,
  SourceRegistrationPlanSchema,
  SourceRelocationPayloadSchema,
} from "../../features/sources/source.ts";
import { StateInitializationPayloadSchema } from "../../services/state-store.ts";
import { VersionReportSchema } from "../../version.ts";
import { ExploreSessionSchema, HelpPayloadSchema } from "./command-payloads.ts";
import type { FlagRequestTag, Invocation } from "./model.ts";
import type { MutationMode } from "./operation-contract.ts";

/** The envelope slots a successful or partial run can fill. */
export const payloadSlots = ["result", "plan", "applied"] as const;

/** One envelope payload slot. */
export type PayloadSlot = (typeof payloadSlots)[number];

/**
 * The kinds of the stable `--json` payloads, the only payloads published with a schema. Each is the
 * `kind` literal of the schema that describes it.
 */
export const stablePayloadKinds = [
  "doctor-report",
  "skill-status",
  "sync-plan",
  "sync-application",
  "init-plan",
  "init-application",
  "upgrade-guide",
] as const;

/** A payload schema: it decodes and encodes without any service. */
type PayloadSchema = Schema.Codec<unknown>;

/** A payload schema led by the `kind` of a stable payload. */
type StablePayloadSchema = PayloadSchema & {
  readonly fields: { readonly kind: Schema.Literal<(typeof stablePayloadKinds)[number]> };
};

/** The schema of each slot a command fills; a slot it never fills is absent. */
export type PayloadSchemas<S extends PayloadSchema = PayloadSchema> = {
  readonly [Slot in PayloadSlot]?: S;
};

/**
 * The public contract of one command: the words after `tack` that select it, how it changes state,
 * and the schema of each payload slot. A stable command's payloads are part of the stable `--json`
 * contract, so each of its schemas names a stable kind.
 */
export type CommandDeclaration = {
  readonly path: readonly [string, ...Array<string>];
  readonly mode: MutationMode;
} & (
  | ({ readonly stable?: false } & PayloadSchemas)
  | ({ readonly stable: true } & PayloadSchemas<StablePayloadSchema>)
);

/** `state clean` plans and applies the same removal whether or not `--pending` selects `retry`. */
const stateClean = {
  path: ["state", "clean"],
  mode: "preview-apply",
  plan: SelectedRemovalPlanSchema,
  applied: RemovalResultSchema,
} as const satisfies CommandDeclaration;

/**
 * Every invocation the command tree declares, by tag. Envelope command names and command paths
 * derive only from this table, and parser tests keep it in agreement with the tree.
 */
export const commandDeclarations = {
  "adapter-disable": {
    path: ["adapter", "disable"],
    mode: "preview-apply",
    plan: AdapterDisablementPlanSchema,
    applied: AdapterDisablementResultSchema,
  },
  "adapter-list": { path: ["adapter"], mode: "read-only", result: AdapterListPayloadSchema },
  "adapter-set": {
    path: ["adapter", "enable"],
    mode: "immediate",
    applied: AdapterSettingsPayloadSchema,
  },
  catalog: { path: ["catalog"], mode: "read-only", result: CatalogReportSchema },
  "choice-remove": {
    path: ["pick", "remove"],
    mode: "immediate",
    applied: ChoiceRemovalPayloadSchema,
  },
  "choice-set": {
    path: ["pick", "include"],
    mode: "immediate",
    applied: ChoiceChangePayloadSchema,
  },
  "choice-exclude": {
    path: ["pick", "exclude"],
    mode: "immediate",
    applied: ChoiceChangePayloadSchema,
  },
  clean: stateClean,
  doctor: { path: ["doctor"], mode: "read-only", stable: true, result: DoctorReportSchema },
  "docs-attach": {
    path: ["docs", "attach"],
    mode: "immediate",
    applied: DocsSettingsPayloadSchema,
  },
  check: { path: ["check"], mode: "read-only", result: CheckReportSchema },
  "docs-icons": { path: ["docs", "icons"], mode: "read-only", result: DocsIconsPayloadSchema },
  "docs-configure": {
    path: ["docs", "configure"],
    mode: "immediate",
    applied: DocsSettingsPayloadSchema,
  },
  "docs-detach": {
    path: ["docs", "detach"],
    mode: "immediate",
    applied: DocsSettingsPayloadSchema,
  },
  "docs-list": { path: ["docs"], mode: "read-only", result: DocsListPayloadSchema },
  "docs-search": { path: ["docs", "search"], mode: "read-only", result: ReaderSearchPayloadSchema },
  "docs-serve": { path: ["docs", "serve"], mode: "read-only", result: ReaderSessionPayloadSchema },
  "docs-target": { path: ["docs", "target"], mode: "read-only", result: DocsTargetPayloadSchema },
  explore: { path: ["explore"], mode: "conditional", result: ExploreSessionSchema },
  guide: {
    path: ["guide"],
    mode: "read-only",
    result: Schema.Union([GuideIndexSchema, GuideSchema]),
  },
  "history-clear": {
    path: ["script", "history", "clear"],
    mode: "preview-apply",
    plan: HistoryClearPlanSchema,
    applied: HistoryClearApplicationSchema,
  },
  "history-list": {
    path: ["script", "history"],
    mode: "read-only",
    result: HistoryListPayloadSchema,
  },
  "history-show": {
    path: ["script", "history", "show"],
    mode: "read-only",
    result: HistoryRecordSchema,
  },
  "import-add": {
    path: ["import", "add"],
    mode: "preview-apply",
    plan: ImportPlanSchema,
    applied: ImportApplicationSchema,
  },
  "import-list": { path: ["import"], mode: "read-only", result: ImportListSchema },
  "import-remove": {
    path: ["import", "remove"],
    mode: "preview-apply",
    plan: ImportRemovalPlanSchema,
    applied: ImportRemovalApplicationSchema,
  },
  init: { path: ["state", "init"], mode: "immediate", applied: StateInitializationPayloadSchema },
  // It writes at once and reports what it planned beside what it applied.
  "machine-init": {
    path: ["init"],
    mode: "immediate",
    stable: true,
    plan: InitPlanSchema,
    applied: InitApplicationSchema,
  },
  "pick-list": { path: ["pick"], mode: "read-only", result: ChoiceListPayloadSchema },
  "project-add": {
    path: ["project", "add"],
    mode: "immediate",
    applied: ProjectRegistrationPayloadSchema,
  },
  "project-list": { path: ["project"], mode: "read-only", result: ProjectInspectionsPayloadSchema },
  "project-refresh": {
    path: ["project", "refresh"],
    mode: "preview-apply",
    plan: ProjectRefreshCommandPlanSchema,
    applied: ProjectRefreshCommandResultSchema,
  },
  "project-remove": {
    path: ["project", "remove"],
    mode: "preview-apply",
    plan: ProjectRemovalPlanSchema,
    applied: ProjectRemovalResultSchema,
  },
  reset: { ...stateClean, path: ["state", "reset"] },
  retry: stateClean,
  upgrade: { path: ["upgrade"], mode: "read-only", stable: true, result: UpgradeGuideSchema },
  "script-run": { path: ["script", "run"], mode: "execute", result: ScriptRunPayloadSchema },
  "script-show": { path: ["script", "show"], mode: "read-only", result: ScriptShowPayloadSchema },
  // `--apply` publishes the plan it wrote as `applied`, so both slots hold the same plan.
  types: {
    path: ["types"],
    mode: "preview-apply",
    plan: TypesPlanSchema,
    applied: TypesPlanSchema,
  },
  "source-add": {
    path: ["source", "add"],
    mode: "preview-apply",
    // A preview registers a source or scaffolds its tack.yaml; an application publishes the
    // scaffold it wrote, if any, beside the registration.
    plan: Schema.Union([SourceRegistrationPlanSchema, SourceScaffoldPlanSchema]),
    applied: SourceRegistrationPayloadSchema,
  },
  "profile-apply": {
    path: ["profile", "apply"],
    mode: "preview-apply",
    plan: ProfileApplyPlanSchema,
    applied: ProfileDeliveryApplicationSchema,
  },
  "profile-save": {
    path: ["profile", "save"],
    mode: "preview-apply",
    plan: ProfileSavePlanSchema,
    applied: ProfileSavedSchema,
  },
  "profile-adopt": {
    path: ["profile", "adopt"],
    mode: "preview-apply",
    plan: ProfileAdoptPlanSchema,
    applied: ProfileAdoptedSchema,
  },
  "profile-export": {
    path: ["profile", "export"],
    mode: "preview-apply",
    plan: BundleExportPlanSchema,
    applied: BundleExportedSchema,
  },
  "profile-inspect-bundle": {
    path: ["profile", "inspect-bundle"],
    mode: "read-only",
    result: BundleInspectionPayloadSchema,
  },
  "profile-apply-bundle": {
    path: ["profile", "apply-bundle"],
    mode: "preview-apply",
    plan: BundleApplyPlanSchema,
    applied: ProfileDeliveryApplicationSchema,
  },
  "source-list": { path: ["source"], mode: "read-only", result: SourceListPayloadSchema },
  "source-relocate": {
    path: ["source", "relocate"],
    mode: "immediate",
    applied: SourceRelocationPayloadSchema,
  },
  "source-remove": {
    path: ["source", "remove"],
    mode: "preview-apply",
    plan: SourceRemovalPlanSchema,
    applied: SourceRemovalResultSchema,
  },
  status: { path: ["status"], mode: "read-only", stable: true, result: StatusPayloadSchema },
  sync: {
    path: ["sync"],
    mode: "preview-apply",
    stable: true,
    plan: SyncPlanSchema,
    applied: SyncApplicationSchema,
  },
  "upgrade-status": {
    path: ["upgrade", "status"],
    mode: "read-only",
    stable: true,
    result: UpgradeGuideSchema,
  },
} as const satisfies Record<Exclude<Invocation["_tag"], FlagRequestTag>, CommandDeclaration>;

/** The payload schemas of the `--help` and `--version` requests, which no command word selects. */
export const flagRequestPayloads = {
  help: { result: HelpPayloadSchema },
  version: { result: VersionReportSchema },
} as const satisfies Record<FlagRequestTag, PayloadSchemas>;
