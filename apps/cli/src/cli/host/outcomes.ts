import { Schema } from "effect";
import {
  HistoryListPayloadSchema,
  type HistoryList,
  type OperatorRunResult,
} from "../../domain/execution/execution-schema.ts";
import { statusPayload, type StatusReport } from "../../domain/status/status-schema.ts";
import {
  DocsLinkApplicationSchema,
  DocsLinkPlanSchema,
  type DocsLinkApplication,
  type DocsLinkPlan,
} from "../../domain/docs/docs-schema.ts";
import { ReconciliationApplyResultSchema } from "../../domain/reconciliation/reconciliation-application-schema.ts";
import { ReconciliationCommandPlanSchema } from "../../domain/reconciliation/reconciliation-schema.ts";
import {
  SyncApplicationSchema,
  SyncPlanSchema,
  type SyncOptions,
} from "../../domain/reconciliation/sync-schema.ts";
import { CatalogReportSchema } from "../../domain/sources/catalog-report.ts";
import { statusPartialCauses } from "../../features/status/status.ts";
import {
  projectInspectionCauses,
  reconciliationApplicationCauses,
  removalCauses,
  sourceCauses,
} from "../../features/reconciliation/partial-cause.ts";
import type { SyncApplication, SyncPlan } from "../../features/reconciliation/sync-command.ts";
import type { UserLinkedExclude } from "../../features/reconciliation/linked-for-user.ts";
import type {
  ProfileApplyExecution,
  ProfileApplyPlan,
} from "../../features/profiles/profile-apply.ts";
import type { BundleApplyPlan } from "../../features/profiles/bundle-apply.ts";
import {
  ProjectInspectionsPayloadSchema,
  type ProjectInspection,
} from "../../features/projects/project.ts";
import type { SelectionEcho } from "../../features/projects/project.ts";
import type { CheckoutObservation } from "../../features/projects/checkout.ts";
import type { State } from "../../domain/state/state-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import {
  SourceListPayloadSchema,
  sourceLoadsNothing,
  type SourceListEntry,
} from "../../features/imports/import-display.ts";
import type { RemovalPlan, RemovalResult } from "../../domain/reconciliation/removal-schema.ts";
import { DoctorReportSchema, type DoctorReport } from "../../domain/doctor/doctor-schema.ts";
import { DocsIconsPayloadSchema, type DocsIconLookup } from "../../features/reader/icon-lookup.ts";
import { ReaderSearchPayloadSchema, type ReaderSearch } from "../../features/reader/search.ts";
import { DocsListPayloadSchema, type DocsList } from "../../features/docs/docs.ts";
import {
  ChoiceChangePayloadSchema,
  type ChoiceAddressCandidates,
  type SetSkillChoiceResult,
} from "../../features/choices/choice.ts";
import type { SelectableAddress } from "../../domain/sources/catalog-schema.ts";
import { commandLine } from "./command-line.ts";
import { partialCauseDiagnostic } from "./partial-causes.ts";
import type { PublicDiagnosticSchema, PublicOutcome } from "./public-outcome.ts";

type Diagnostic = typeof PublicDiagnosticSchema.Type;

/** Validates a domain value as the JSON placed in a public payload slot. */
export const toJson = Schema.decodeUnknownSync(Schema.Json);

/** A successful read-only observation. */
export const resultOutcome = (result: unknown): PublicOutcome => ({
  classification: "success",
  diagnostics: [],
  result: toJson(result),
});

/** A successful immediate mutation. */
export const appliedOutcome = (applied: unknown): PublicOutcome => ({
  applied: toJson(applied),
  classification: "success",
  diagnostics: [],
});

/** Names the response family of a payload; `kind` leads the serialized object. */
const kinded = <const Kind extends string, Value extends object>(kind: Kind, value: Value) => ({
  kind,
  ...value,
});

/** A payload schema whose `kind` literal names the response family and leads the payload. */
type KindedPayloadSchema = {
  readonly Type: { readonly kind: string };
  readonly fields: { readonly kind: Schema.Literal<string> };
};

/** What a producer returns for a payload schema: every field but the `kind` the schema adds. */
export type PayloadFields<S extends KindedPayloadSchema> = Omit<S["Type"], "kind">;

/** The payload a producer's fields make under the given schema, with its `kind` leading. */
const payloadAs = <S extends KindedPayloadSchema>(schema: S, fields: PayloadFields<S>) =>
  kinded(schema.fields.kind.literal, fields);

/** A successful read-only observation whose payload follows the given schema. */
export const resultAs =
  <S extends KindedPayloadSchema>(schema: S) =>
  (result: PayloadFields<S>): PublicOutcome =>
    resultOutcome(payloadAs(schema, result));

/** A successful immediate mutation whose payload follows the given schema. */
export const appliedAs =
  <S extends KindedPayloadSchema>(schema: S) =>
  (applied: PayloadFields<S>): PublicOutcome =>
    appliedOutcome(payloadAs(schema, applied));

/**
 * A note that a project exclude hides nothing: the user namespace links the resource, so every
 * agent in the project still sees it. It is a note, not a warning, so the exclude keeps its exit
 * status; the views name the user exclude under Next.
 */
const userLinkedExcludeDiagnostic = ({ address, projectName }: UserLinkedExclude): Diagnostic => ({
  code: "project-exclude-linked-for-user",
  details: toJson({ subject: { address, projectName } }),
  message: `Project ${projectName} cannot hide ${address.kind} ${address.name}: the user namespace links it, so every agent in the project still sees it. Excluding it for the user turns it off everywhere.`,
  severity: "info",
});

/**
 * Presents a persisted choice. A choice whose address the catalog lacks is still kept, since a
 * source can provide it later, but it is not accepted silently: a warning names the address and
 * the catalog addresses the operator probably meant. A project exclude that the user namespace
 * outranks is noted the same way.
 */
export const choiceSetOutcome = (
  applied: SetSkillChoiceResult,
  candidates: ReadonlyArray<SelectableAddress> | undefined,
  userLinked: ReadonlyArray<UserLinkedExclude>,
): PublicOutcome => ({
  ...appliedAs(ChoiceChangePayloadSchema)(applied),
  diagnostics: [
    ...userLinked.map(userLinkedExcludeDiagnostic),
    ...(candidates === undefined
      ? []
      : [
          {
            code: "choice-address-not-in-catalog",
            details: toJson({
              candidates,
              subject: { address: applied.choice.address },
            } satisfies ChoiceAddressCandidates),
            message: "The chosen address is not in the current catalog; check it for a typo.",
            severity: "warning" as const,
          },
        ]),
  ],
});

/** Reports `partial` with the given warnings when any are present, and success otherwise. */
const partialWhen = (
  warnings: ReadonlyArray<Omit<Diagnostic, "severity">>,
): Pick<PublicOutcome, "classification" | "diagnostics"> => ({
  classification: warnings.length > 0 ? "partial" : "success",
  diagnostics: warnings.map((warning) => ({ ...warning, severity: "warning" })),
});

/** A preview, or a preview plus its application when one ran. */
const planOutcome = (
  execution: { readonly plan: unknown; readonly applied?: unknown },
  warnings: ReadonlyArray<Omit<Diagnostic, "severity">>,
): PublicOutcome => ({
  ...(execution.applied === undefined ? {} : { applied: toJson(execution.applied) }),
  ...partialWhen(warnings),
  plan: toJson(execution.plan),
});

/** A successful preview, plus its application when one ran. */
export const previewOutcome = (execution: {
  readonly plan: unknown;
  readonly applied?: unknown;
}): PublicOutcome => planOutcome(execution, []);

/**
 * Presents a preview/apply workflow whose removal work can retain obligations: each blocked action
 * of a preview, or each action an application did not apply, is a partial cause naming its
 * destination. `causes` adds the workflow's other partial causes.
 */
export const removalOutcome = (
  execution: { readonly plan: unknown; readonly applied?: unknown },
  removals: {
    readonly planned: ReadonlyArray<Pick<RemovalPlan, "actions">>;
    readonly applied: ReadonlyArray<Pick<RemovalResult, "actions">> | undefined;
  },
  causes: ReadonlyArray<Omit<Diagnostic, "severity">> = [],
): PublicOutcome =>
  planOutcome(execution, [
    ...removalCauses(removals.planned, removals.applied).map(partialCauseDiagnostic),
    ...causes,
  ]);

const strict = { onExcessProperty: "error" } as const;
const validCommandPlan = Schema.decodeUnknownSync(ReconciliationCommandPlanSchema, strict);
const validApplyResult = Schema.decodeUnknownSync(ReconciliationApplyResultSchema, strict);
const validDocsPlan = Schema.decodeUnknownSync(DocsLinkPlanSchema, strict);
const validDocsApplication = Schema.decodeUnknownSync(DocsLinkApplicationSchema, strict);

/**
 * The warnings of one project's docs mounts. They come from the applied result when there is one,
 * since application can meet new conflicts.
 */
const docsWarnings = (
  plan: DocsLinkPlan,
  applied: DocsLinkApplication | undefined,
): ReadonlyArray<Omit<Diagnostic, "severity">> => {
  const report = applied ?? plan;
  const subject = (action: DocsLinkPlan["actions"][number]) =>
    toJson({
      subject: {
        resource: action.evidence.resource,
        destinationPath: action.evidence.destinationPath,
      },
    });
  return [
    ...report.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      details: toJson({ subject: issue.subject }),
    })),
    ...(applied === undefined
      ? plan.actions.flatMap((action) =>
          action.action === "conflict"
            ? [{ code: action.code, message: action.message, details: subject(action) }]
            : [],
        )
      : applied.actions.flatMap((outcome) =>
          outcome._tag === "applied"
            ? []
            : [
                {
                  code: outcome._tag === "skipped" ? outcome.reason : outcome.code,
                  message:
                    outcome._tag === "skipped"
                      ? "The docs action was not attempted while recovery is pending."
                      : outcome.message,
                  details: subject(outcome.action),
                },
              ],
        )),
  ];
};

/**
 * Presents a sync preview or application: the agent-link part with the selection it was planned
 * for, one docs part per project, and the owed docs removals. It is partial with one warning per
 * agent-link cause, docs issue or conflict, and owed docs removal.
 */
export const syncOutcome = (
  { plan, applied }: { readonly plan: SyncPlan; readonly applied?: SyncApplication },
  options: SyncOptions | undefined,
): PublicOutcome => {
  const docsPlans = plan.docs.map((docs) => validDocsPlan(docs));
  const application =
    applied === undefined
      ? undefined
      : {
          resources: applied.resources === undefined ? null : validApplyResult(applied.resources),
          docs: applied.docs.map((docs) => validDocsApplication(docs)),
        };
  const pendingField =
    plan.docsPending.length === 0 ? {} : { docsPendingRemovals: plan.docsPending };
  const warned = partialWhen([
    ...[
      ...(plan.resources?.causes ?? []),
      ...(applied?.resources === undefined
        ? []
        : reconciliationApplicationCauses(applied.resources)),
    ].map(partialCauseDiagnostic),
    ...docsPlans.flatMap((docs, index) => docsWarnings(docs, application?.docs[index])),
    ...plan.docsPending.map((pending) =>
      partialCauseDiagnostic({
        code: "pending-removal",
        subject: { cause: pending.cause, destinationPath: pending.evidence.destinationPath },
      }),
    ),
  ]);
  return {
    classification: warned.classification,
    diagnostics: [
      ...warned.diagnostics,
      ...(plan.resources?.userLinkedExcludes ?? []).map(userLinkedExcludeDiagnostic),
    ],
    plan: toJson(
      payloadAs(SyncPlanSchema, {
        resources:
          plan.resources === undefined
            ? null
            : validCommandPlan({ ...plan.resources.plan, selection: plan.resources.selection }),
        docs: docsPlans,
        ...pendingField,
        ...(options === undefined ? {} : { options }),
      }),
    ),
    ...(application === undefined
      ? {}
      : { applied: toJson(payloadAs(SyncApplicationSchema, { ...application, ...pendingField })) }),
  };
};

/**
 * Presents a fixed profile application of `profile apply` or `profile apply-bundle`. It is a domain
 * outcome when it refused before mutation. It is partial when its delivery is incomplete, its sync
 * plan meets a conflict, a blocked member or an incomplete docs mount, or applying left an agent
 * link or docs action unapplied.
 */
export const profileApplyOutcome = ({
  plan,
  applied,
}: ProfileApplyExecution<ProfileApplyPlan | BundleApplyPlan>): PublicOutcome => {
  const incomplete =
    plan.delivery.incomplete ||
    plan.sync?.resources?.plan.units.some(
      (unit) => unit.summary.conflict + unit.summary.blocked > 0,
    ) === true ||
    plan.sync?.docs.some((docs) => docs.complete === false) === true ||
    applied?.resources?.units.some((unit) =>
      unit.actions.some((action) => action._tag !== "applied"),
    ) === true ||
    applied?.docs.some((docs) => docs.actions.some((action) => action._tag !== "applied")) === true;
  return {
    classification: plan.refused ? "domain" : incomplete ? "partial" : "success",
    diagnostics: [],
    plan: toJson(plan),
    ...(applied === undefined ? {} : { applied: toJson(applied) }),
  };
};

/** The setup gap an empty project reports, with the step that closes it. */
const setupWarning = (setup: { readonly message: string; readonly next: string }) => ({
  code: "docs-setup-incomplete",
  details: { next: setup.next },
  message: `${setup.message} Next: ${setup.next}`,
});

/**
 * Presents a docs list, partial when the setup is empty or any attached resource or document is
 * unavailable.
 */
export const docsListOutcome = (result: DocsList): PublicOutcome => ({
  ...partialWhen([
    ...(result.setup === undefined ? [] : [setupWarning(result.setup)]),
    ...(result.issues.length === 0
      ? []
      : [
          {
            code: "docs-partial",
            details: { issues: result.issues.length },
            message: "Some attached docs resources or documents are unavailable.",
          },
        ]),
  ]),
  result: toJson(payloadAs(DocsListPayloadSchema, result)),
});

const validCatalogReport = Schema.decodeUnknownSync(CatalogReportSchema, {
  onExcessProperty: "error",
});

/**
 * Presents a catalog report, partial when it is incomplete. The summary diagnostic counts the
 * result's issues rather than repeating them. A report that breaks its contract, such as a resource
 * whose kind disagrees with its address, is a defect the host reports as an internal error.
 */
export const catalogOutcome = (candidate: unknown): PublicOutcome => {
  const report = validCatalogReport(candidate);
  return {
    ...partialWhen(
      report.complete === true
        ? []
        : [
            {
              code: "catalog-partial",
              details: { issues: report.issues.length },
              message: "Some candidates or sources have issues; see the result issues.",
            },
          ],
    ),
    result: toJson(report),
  };
};

/**
 * Presents source inspection, partial when health or label issues need attention, or when a source
 * loads nothing because every declaration has a problem.
 */
export const sourcesOutcome = (sources: ReadonlyArray<SourceListEntry>): PublicOutcome => ({
  ...partialWhen([
    ...sourceCauses(
      sources.flatMap((source) => (source.status === "unhealthy" ? [source] : [])),
    ).map(partialCauseDiagnostic),
    ...sources.flatMap((source) =>
      sourceLoadsNothing(source)
        ? [
            {
              code: "source-loads-nothing",
              details: { sourceRegistrationId: source.registration.id },
              message: `${source.registration.canonicalPath} loads nothing: every declaration has a problem and finds no resource. tack check on the source shows what to fix.`,
            },
          ]
        : [],
    ),
    ...sources.flatMap((source) =>
      (source.labelIssues ?? []).map((issue) => ({
        code: issue.code,
        details: { sourceRegistrationId: source.registration.id },
        message: issue.message,
      })),
    ),
  ]),
  result: toJson(payloadAs(SourceListPayloadSchema, { sources })),
});

/**
 * Presents project inspection, partial with one warning per removing project, unhealthy anchor,
 * and missing, unhealthy or removing root, as `status` reports them.
 */
export const projectsOutcome = (projects: ReadonlyArray<ProjectInspection>): PublicOutcome => ({
  ...partialWhen(projects.flatMap(projectInspectionCauses).map(partialCauseDiagnostic)),
  result: toJson(payloadAs(ProjectInspectionsPayloadSchema, { projects })),
});

/** Presents status, partial with one warning per unhealthy, unresolved or unreconciled cause. */
export const statusOutcome = (report: StatusReport): PublicOutcome => ({
  ...partialWhen(statusPartialCauses(report).map(partialCauseDiagnostic)),
  result: toJson(statusPayload(report)),
});

/**
 * Warns that the current directory is a worktree of a reported project that Tack has not added,
 * so status cannot vouch for it: that worktree has no links, whatever the registered roots show.
 */
export const withUnregisteredWorktree = (
  outcome: PublicOutcome,
  checkout: CheckoutObservation,
  scope: StatusReport["scope"],
): PublicOutcome =>
  checkout._tag !== "unregistered-worktree" ||
  scope._tag === "user" ||
  (scope._tag === "project" && scope.projectName !== checkout.projectName)
    ? outcome
    : {
        ...outcome,
        classification: outcome.classification === "success" ? "partial" : outcome.classification,
        diagnostics: [
          ...outcome.diagnostics,
          {
            code: "worktree-not-registered",
            details: { projectName: checkout.projectName, root: checkout.root },
            message: `This directory is in ${checkout.root}, a worktree of project ${checkout.projectName} that Tack has not registered yet, so it has no links.`,
            severity: "warning",
          },
        ],
        next: [["tack", "project", "refresh", "--apply"], ...(outcome.next ?? [])],
      };

/** Adds one quiet reminder about pending removals that a narrow selector cannot settle. */
export const withOutsidePendingDiagnostic = (
  outcome: PublicOutcome,
  state: State,
  selection: SelectionEcho,
): PublicOutcome => {
  if (selection.selector._tag === "all") return outcome;
  const projectName =
    selection.selector._tag === "bare"
      ? selection.containingRoot?.projectName
      : selection.selector._tag === "project"
        ? selection.selector.projectName
        : undefined;
  // Every owed removal counts, whether it is an agent link's or a docs mount's.
  const outside = state.data.links.filter((record) => {
    const target = record.target;
    return (
      record.removal !== undefined &&
      (projectName === undefined
        ? target._tag !== "user"
        : target._tag !== "project-root" || target.projectName !== projectName)
    );
  });
  if (outside.length === 0) return outcome;
  const owners = [
    ...new Set(
      outside.map((record) => (record.target._tag === "user" ? "user" : record.target.projectName)),
    ),
  ].sort(compareCodeUnits);
  return {
    ...outcome,
    diagnostics: [
      ...outcome.diagnostics,
      {
        code: "pending-removals-outside-scope",
        details: { count: outside.length, owners },
        message: `${outside.length} pending removal${outside.length === 1 ? "" : "s"} outside this scope (${owners.join(", ")}).`,
        severity: "info",
      },
    ],
  };
};

/** Presents docs search, partial when the setup is empty or any resource or document is unavailable. */
export const docsSearchOutcome = (result: ReaderSearch): PublicOutcome => ({
  ...partialWhen(
    result.complete === true
      ? []
      : result.setup === undefined
        ? [
            {
              code: "reader-incomplete",
              message:
                "Some attached docs resources or documents are unavailable; search covers everything that loaded.",
            },
          ]
        : [setupWarning(result.setup)],
  ),
  result: toJson(payloadAs(ReaderSearchPayloadSchema, result)),
});

/** Presents one script run; a failed run keeps its run-outcome code and its full result. */
export const scriptRunOutcome = (result: OperatorRunResult): PublicOutcome => ({
  classification: result.outcome.classification,
  diagnostics:
    result.outcome.classification === "success"
      ? []
      : [
          {
            code: result.outcome.code,
            message: result.outcome.message,
            severity: "error",
            details: {
              stage: result.outcome.stage,
              ...(result.outcome.details === undefined ? {} : { outcome: result.outcome.details }),
            },
          },
        ],
  result: toJson(kinded("script-run", result)),
});

/** Presents one history page, partial when some retained records could not be read. */
export const historyListOutcome = (list: HistoryList): PublicOutcome => ({
  ...partialWhen(
    list.issues.length > 0
      ? [
          {
            code: "history-partial",
            details: { skipped: list.issues.length },
            message: "Some retained run records could not be read; see the result issues.",
          },
        ]
      : [],
  ),
  result: toJson(payloadAs(HistoryListPayloadSchema, list)),
});

/**
 * Presents the health report. A warning or a skip is a normal finding and succeeds; any failed
 * check is a domain failure that still carries the complete report and one error per failed check.
 */
export const doctorOutcome = (candidate: DoctorReport): PublicOutcome => {
  const report = Schema.decodeUnknownSync(DoctorReportSchema, { onExcessProperty: "error" })(
    candidate,
  );
  const failed = report.checks.filter((check) => check.outcome === "failed");
  return {
    classification: failed.length > 0 ? "domain" : "success",
    diagnostics: failed.map((check) => ({
      code: "doctor-check-failed",
      details: { check: check.id },
      message: check.message,
      severity: "error" as const,
    })),
    result: toJson(report),
  };
};

/** The docs icon lookup: a warning when the word matches nothing. */
export const docsIconsOutcome = (lookup: DocsIconLookup): PublicOutcome => ({
  classification: "success",
  diagnostics:
    lookup.count === 0 && lookup.query !== undefined
      ? [
          {
            code: "docs-icons-none",
            message: `No docs icon matches "${lookup.query}". Names say what an icon draws, so search for that (flask, not research), or run \`${commandLine("docs-icons")}\` without a word to list them all.`,
            severity: "warning",
          },
        ]
      : [],
  result: toJson(payloadAs(DocsIconsPayloadSchema, lookup)),
});
