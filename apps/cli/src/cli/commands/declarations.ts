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
 * The public contract of one command: how it changes state and the schema of each payload slot. A
 * stable command's payloads are part of the stable `--json` contract, so each of its schemas names
 * a stable kind. The path is declared only where the tag's words do not spell it (see
 * `commandPathOf`), and the mode only where {@link modeOf} would not read it from the slots.
 */
export type CommandDeclaration = {
  readonly path?: readonly [string, ...Array<string>];
  readonly mode?: MutationMode;
} & (
  | ({ readonly stable?: false } & PayloadSchemas)
  | ({ readonly stable: true } & PayloadSchemas<StablePayloadSchema>)
);

/**
 * How a command changes state: its declared mode, or else read from its slots. A plan is previewed
 * and applied with `--apply`, an applied payload alone is written at once, and a result alone is
 * read-only.
 */
export const modeOf = (declaration: CommandDeclaration): MutationMode =>
  declaration.mode ??
  (declaration.plan !== undefined
    ? "preview-apply"
    : declaration.applied === undefined
      ? "read-only"
      : "immediate");

/** `state clean`, with or without `--pending`, and `state reset` plan and apply one removal. */
const stateRemoval = {
  plan: SelectedRemovalPlanSchema,
  applied: RemovalResultSchema,
} as const satisfies CommandDeclaration;

/**
 * Every invocation the command tree declares, by tag. A tag spells its command path, so envelope
 * command names and command paths derive from the tag, or from the path declared where the words
 * differ. Parser tests keep this table in agreement with the tree.
 */
export const commandDeclarations = {
  "adapter-disable": {
    plan: AdapterDisablementPlanSchema,
    applied: AdapterDisablementResultSchema,
  },
  "adapter-enable": { applied: AdapterSettingsPayloadSchema },
  "adapter-list": { result: AdapterListPayloadSchema },
  catalog: { result: CatalogReportSchema },
  check: { result: CheckReportSchema },
  "docs-attach": { applied: DocsSettingsPayloadSchema },
  "docs-configure": { applied: DocsSettingsPayloadSchema },
  "docs-detach": { applied: DocsSettingsPayloadSchema },
  "docs-icons": { result: DocsIconsPayloadSchema },
  "docs-list": { result: DocsListPayloadSchema },
  "docs-search": { result: ReaderSearchPayloadSchema },
  "docs-serve": { result: ReaderSessionPayloadSchema },
  "docs-target": { result: DocsTargetPayloadSchema },
  doctor: { stable: true, result: DoctorReportSchema },
  explore: { mode: "conditional", result: ExploreSessionSchema },
  guide: { result: Schema.Union([GuideIndexSchema, GuideSchema]) },
  "import-add": { plan: ImportPlanSchema, applied: ImportApplicationSchema },
  "import-list": { result: ImportListSchema },
  "import-remove": { plan: ImportRemovalPlanSchema, applied: ImportRemovalApplicationSchema },
  // It writes at once and reports what it planned beside what it applied.
  init: { mode: "immediate", stable: true, plan: InitPlanSchema, applied: InitApplicationSchema },
  "pick-exclude": { applied: ChoiceChangePayloadSchema },
  "pick-include": { applied: ChoiceChangePayloadSchema },
  "pick-list": { result: ChoiceListPayloadSchema },
  "pick-remove": { applied: ChoiceRemovalPayloadSchema },
  "profile-adopt": { plan: ProfileAdoptPlanSchema, applied: ProfileAdoptedSchema },
  "profile-apply": { plan: ProfileApplyPlanSchema, applied: ProfileDeliveryApplicationSchema },
  "profile-apply-bundle": {
    path: ["profile", "apply-bundle"],
    plan: BundleApplyPlanSchema,
    applied: ProfileDeliveryApplicationSchema,
  },
  "profile-export": { plan: BundleExportPlanSchema, applied: BundleExportedSchema },
  "profile-inspect-bundle": {
    path: ["profile", "inspect-bundle"],
    result: BundleInspectionPayloadSchema,
  },
  "profile-save": { plan: ProfileSavePlanSchema, applied: ProfileSavedSchema },
  "project-add": { applied: ProjectRegistrationPayloadSchema },
  "project-list": { result: ProjectInspectionsPayloadSchema },
  "project-refresh": {
    plan: ProjectRefreshCommandPlanSchema,
    applied: ProjectRefreshCommandResultSchema,
  },
  "project-remove": { plan: ProjectRemovalPlanSchema, applied: ProjectRemovalResultSchema },
  "script-history-clear": { plan: HistoryClearPlanSchema, applied: HistoryClearApplicationSchema },
  "script-history-list": { result: HistoryListPayloadSchema },
  "script-history-show": { result: HistoryRecordSchema },
  "script-run": { mode: "execute", result: ScriptRunPayloadSchema },
  "script-show": { result: ScriptShowPayloadSchema },
  "source-add": {
    // A preview registers a source or scaffolds its tack.yaml; an application publishes the
    // scaffold it wrote, if any, beside the registration.
    plan: Schema.Union([SourceRegistrationPlanSchema, SourceScaffoldPlanSchema]),
    applied: SourceRegistrationPayloadSchema,
  },
  "source-list": { result: SourceListPayloadSchema },
  "source-relocate": { applied: SourceRelocationPayloadSchema },
  "source-remove": { plan: SourceRemovalPlanSchema, applied: SourceRemovalResultSchema },
  "state-clean": stateRemoval,
  // `state clean --pending`: the flag, not a word, selects it.
  "state-clean-pending": { ...stateRemoval, path: ["state", "clean"] },
  "state-init": { applied: StateInitializationPayloadSchema },
  "state-reset": stateRemoval,
  status: { stable: true, result: StatusPayloadSchema },
  sync: { stable: true, plan: SyncPlanSchema, applied: SyncApplicationSchema },
  // `--apply` publishes the plan it wrote as `applied`, so both slots hold the same plan.
  types: { plan: TypesPlanSchema, applied: TypesPlanSchema },
  upgrade: { stable: true, result: UpgradeGuideSchema },
  "upgrade-status": { stable: true, result: UpgradeGuideSchema },
} as const satisfies Record<Exclude<Invocation["_tag"], FlagRequestTag>, CommandDeclaration>;

/** The payload schemas of the `--help` and `--version` requests, which no command word selects. */
const flagRequestPayloads = {
  help: { result: HelpPayloadSchema },
  version: { result: VersionReportSchema },
} as const satisfies Record<FlagRequestTag, PayloadSchemas>;

type InvocationPayloads = typeof commandDeclarations & typeof flagRequestPayloads;

/** The payload schemas of one invocation, a command or a flag request. */
export const payloadSchemasOf = (tag: Invocation["_tag"]): PayloadSchemas =>
  tag === "help" || tag === "version" ? flagRequestPayloads[tag] : commandDeclarations[tag];

/** The decoded type of what an invocation declares for one slot; `never` for a slot it never fills. */
export type DeclaredPayload<
  Tag extends Invocation["_tag"],
  Slot extends PayloadSlot,
> = Tag extends unknown
  ? InvocationPayloads[Tag] extends { readonly [K in Slot]: { readonly Type: infer A } }
    ? A
    : never
  : never;
