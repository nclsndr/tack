import { Match, Schema } from "effect";
import type { AgentAdapterId, AgentCapability } from "../../domain/links/agent-adapter-schema.ts";
import type { ManagedLinkTarget } from "../../domain/links/managed-link-schema.ts";
import { ChoiceNamespaceSchema, type ChoiceNamespace } from "../../domain/choices/choice-schema.ts";
import { RequiredDependencyBlockerSchema } from "../../domain/choices/dependency-resolution.ts";
import { projectLifecycle } from "../../domain/projects/project-schema.ts";
import { type ProjectInspection, type TargetSelection } from "../projects/project.ts";
import type { CatalogIssue } from "../../domain/sources/catalog-report.ts";
import type { ResourceKind } from "../../domain/resources/kinds.ts";
import {
  SelectableAddressSchema,
  type ResourceAddress,
  type SelectableAddress,
} from "../../domain/sources/catalog-schema.ts";
import type { SourceRegistration } from "../../domain/sources/source-schema.ts";
import type { RemovalPlan, RemovalResult } from "../../domain/reconciliation/removal-schema.ts";
import type { ReconciliationApplyResult } from "../../domain/reconciliation/reconciliation-application-schema.ts";
import type {
  NamespaceDependencyResolution,
  ReconciliationConflict,
  ReconciliationPlan,
  ReconciliationUnitPlan,
} from "../../domain/reconciliation/reconciliation-schema.ts";

type Issue = { readonly code: string; readonly message: string };

/**
 * The subject of a `dependency-blocked` cause: the resources one blocked group holds back, what
 * blocks them, and the namespace that requested them.
 */
export const DependencyBlockedSubjectSchema = Schema.Struct({
  blockers: Schema.Array(RequiredDependencyBlockerSchema),
  members: Schema.Array(SelectableAddressSchema),
  namespace: ChoiceNamespaceSchema,
});

/** The target-and-adapter unit a reconciliation cause belongs to. */
type UnitSubject = { readonly adapter: AgentAdapterId; readonly target: ManagedLinkTarget };

/**
 * One reason a command result is partial, with the subject it is about. The code is the specific
 * public diagnostic code; the subject carries the identities an operator needs to act on it.
 */
export type PartialCause =
  | {
      readonly code: "profile-inventory-unresolved" | "profile-delivery-incomplete";
      readonly subject: {
        readonly namespace: ChoiceNamespace;
        readonly issues: ReadonlyArray<string>;
      };
    }
  | {
      readonly code: "catalog-quarantined";
      readonly subject: {
        readonly address?: ResourceAddress;
        readonly candidateKind?: ResourceKind;
        readonly candidatePath: string;
        readonly field?: string;
        readonly issue: Issue;
        readonly sourcePath: string;
        readonly sourceRegistrationId: string;
      };
    }
  | {
      readonly code: "source-unhealthy";
      readonly subject: { readonly issue: Issue; readonly registration: SourceRegistration };
    }
  | {
      readonly code:
        | "import-folder-missing"
        | "import-folder-not-cataloged"
        | "import-staging-left-over"
        | "imports-invalid";
      readonly subject: {
        readonly message: string;
        readonly path?: string;
        readonly reference?: string;
        readonly registrationId: string;
        readonly source: string;
      };
    }
  | {
      readonly code: "root-missing" | "root-removing";
      readonly subject: { readonly projectName: string; readonly root: string };
    }
  | {
      readonly code: "root-unhealthy";
      readonly subject: {
        readonly issue: Issue;
        readonly projectName: string;
        readonly root: string;
      };
    }
  | {
      readonly code: "project-anchor-unhealthy";
      readonly subject: {
        readonly issue: Issue;
        readonly path: string;
        readonly projectName: string;
      };
    }
  | { readonly code: "project-removing"; readonly subject: { readonly projectName: string } }
  | {
      readonly code: "dependency-blocked";
      readonly subject: typeof DependencyBlockedSubjectSchema.Type;
    }
  | {
      readonly code: "unresolved-choice";
      readonly subject: {
        readonly address: SelectableAddress;
        readonly namespace: ChoiceNamespace;
        readonly reason: "missing" | "quarantined";
      };
    }
  | {
      readonly code: "no-adapters-enabled";
      readonly subject: { readonly enabledAdapters: ReadonlyArray<AgentAdapterId> };
    }
  | {
      readonly code: "selection-collision";
      readonly subject: UnitSubject & {
        readonly addresses: ReadonlyArray<ResourceAddress>;
        readonly name: string;
      };
    }
  | {
      readonly code: ReconciliationConflict["_tag"];
      readonly subject: UnitSubject & {
        readonly address?: ResourceAddress;
        readonly addresses?: ReadonlyArray<ResourceAddress>;
        readonly destinationPath?: string;
      };
    }
  | {
      readonly code: "capability-blocked";
      readonly subject: UnitSubject & { readonly capability: AgentCapability };
    }
  | {
      readonly code: "link-action-failed";
      readonly subject: UnitSubject & { readonly failure: string; readonly path: string };
    }
  | {
      readonly code: "pending-removal";
      readonly subject: { readonly cause: string; readonly destinationPath: string };
    }
  | {
      readonly code: `destination-${DestinationState}`;
      readonly subject: { readonly destinationPaths: ReadonlyArray<string> };
    }
  | {
      readonly code: "removal-blocked" | "removal-failed" | "removal-skipped";
      readonly subject: { readonly destinationPath: string; readonly reason: string };
    };

/** Status destination classifications other than `matching`, each a partial cause. */
export type DestinationState =
  | "drift"
  | "evidence-absent"
  | "evidence-changed"
  | "expected-absent"
  | "foreign-entry"
  | "hand-made"
  | "observation-failed"
  | "target-missing"
  | "unrecorded";

/** Every code a partial cause can carry. */
export type PartialCauseCode = PartialCause["code"];

/**
 * One cause per catalog candidate an issue kept out. Source issues are not repeated here: each
 * unhealthy source is its own `source-unhealthy` cause.
 */
export const catalogCauses = (issues: ReadonlyArray<CatalogIssue>): ReadonlyArray<PartialCause> =>
  issues.flatMap(({ code, message, subject }): ReadonlyArray<PartialCause> => {
    if (subject._tag !== "resource") return [];
    const { _tag, ...candidate } = subject;
    return [{ code: "catalog-quarantined", subject: { ...candidate, issue: { code, message } } }];
  });

/** One cause per unhealthy source registration. */
export const sourceCauses = (
  sources: ReadonlyArray<{ readonly issue: Issue; readonly registration: SourceRegistration }>,
): ReadonlyArray<PartialCause> =>
  sources.map((source) => ({
    code: "source-unhealthy",
    subject: {
      issue: { code: source.issue.code, message: source.issue.message },
      registration: source.registration,
    },
  }));

/**
 * Every unhealthy, stale or unresolved observation of one project inspection: a removal in
 * progress, an anchor that cannot be observed, and each missing, unhealthy or removing root.
 */
export const projectInspectionCauses = (
  inspection: ProjectInspection,
): ReadonlyArray<PartialCause> => {
  const projectName = inspection.project.name;
  return [
    ...(projectLifecycle(inspection.project) === "removing"
      ? [{ code: "project-removing", subject: { projectName } } as const]
      : []),
    ...(inspection.anchor.status === "unhealthy"
      ? [
          {
            code: "project-anchor-unhealthy",
            subject: { issue: inspection.anchor.issue, path: inspection.anchor.path, projectName },
          } as const,
        ]
      : []),
    ...inspection.roots.flatMap((root): ReadonlyArray<PartialCause> => {
      const subject = { projectName, root: root.root };
      if (root.status === "stale") return [{ code: "root-missing", subject }];
      if (root.status === "unhealthy")
        return [{ code: "root-unhealthy", subject: { ...subject, issue: root.issue } }];
      return [];
    }),
    ...(inspection.project.removingRoots ?? []).map((root): PartialCause => ({
      code: "root-removing",
      subject: { projectName, root },
    })),
  ];
};

/** One cause per missing or unhealthy root of a target selection. */
export const selectionRootCauses = (
  selection: Pick<TargetSelection, "staleRoots" | "unhealthyRoots">,
): ReadonlyArray<PartialCause> => [
  ...selection.staleRoots.map((root): PartialCause => ({
    code: "root-missing",
    subject: { projectName: root.projectName, root: root.canonicalPath },
  })),
  ...selection.unhealthyRoots.map((root): PartialCause => ({
    code: "root-unhealthy",
    subject: {
      issue: { code: root.code, message: root.message },
      projectName: root.projectName,
      root: root.canonicalPath,
    },
  })),
];

/** One cause per blocked dependency group and per requested resource that cannot resolve. */
export const resolutionCauses = (
  resolutions: ReadonlyArray<NamespaceDependencyResolution>,
): ReadonlyArray<PartialCause> =>
  resolutions.flatMap(({ namespace, resolution }) => [
    ...resolution.groups.flatMap((group): ReadonlyArray<PartialCause> =>
      group._tag === "blocked"
        ? [
            {
              code: "dependency-blocked",
              subject: { blockers: group.blockers, members: group.members, namespace },
            },
          ]
        : [],
    ),
    ...resolution.requestBlockers.map((blocker): PartialCause => ({
      code: "unresolved-choice",
      subject: {
        address: blocker.address,
        namespace,
        reason: Match.value(blocker).pipe(
          Match.tag("requested-missing", () => "missing" as const),
          Match.tag("requested-quarantined", () => "quarantined" as const),
          Match.exhaustive,
        ),
      },
    })),
  ]);

/** The cause reported when no adapter is enabled, so nothing can be delivered. */
export const noAdaptersCause: PartialCause = {
  code: "no-adapters-enabled",
  subject: { enabledAdapters: [] },
};

const conflictSubject = (conflict: ReconciliationConflict) => {
  if (conflict._tag === "destination-directory-conflict") {
    return { destinationPath: conflict.observation.destinationPath };
  }
  if (conflict._tag === "foreign-destination") {
    return { addresses: conflict.addresses, destinationPath: conflict.destinationPath };
  }
  if (conflict._tag === "managed-link-drift") {
    return { destinationPath: conflict.destinationPath };
  }
  return { address: conflict.address, destinationPath: conflict.destinationPath };
};

const unitCauses = (unit: ReconciliationUnitPlan): ReadonlyArray<PartialCause> => {
  const subject = { adapter: unit.adapter, target: unit.target };
  return [
    ...(unit.capability?._tag === "blocked"
      ? [
          {
            code: "capability-blocked",
            subject: { ...subject, capability: unit.capability.capability },
          } as const,
        ]
      : []),
    ...unit.collisions.map((collision): PartialCause => ({
      code: "selection-collision",
      subject: { ...subject, addresses: collision.addresses, name: collision.name },
    })),
    ...unit.conflicts.map((conflict): PartialCause => ({
      code: conflict._tag,
      subject: { ...subject, ...conflictSubject(conflict) },
    })),
  ];
};

/** Every unresolved decision of a reconciliation plan, one cause per subject. */
export const reconciliationPlanCauses = (plan: ReconciliationPlan): ReadonlyArray<PartialCause> => [
  ...resolutionCauses(plan.namespaceResolutions),
  ...plan.units.flatMap(unitCauses),
];

/**
 * Every action that failed while applying a plan. Other unsuccessful units are already explained
 * by the plan's own causes: a blocked capability, a conflict or a collision.
 */
export const reconciliationApplicationCauses = (
  application: ReconciliationApplyResult,
): ReadonlyArray<PartialCause> =>
  application.units.flatMap((unit) =>
    unit.actions.flatMap((outcome): ReadonlyArray<PartialCause> =>
      outcome._tag === "failed"
        ? [
            {
              code: "link-action-failed",
              subject: {
                adapter: unit.adapter,
                failure: outcome.code,
                path: outcome.path,
                target: unit.target,
              },
            },
          ]
        : [],
    ),
  );

/**
 * Every removal that retains its obligation: a blocked action in a preview, or an action that was
 * not applied in an application.
 */
export const removalCauses = (
  planned: ReadonlyArray<Pick<RemovalPlan, "actions">>,
  applied: ReadonlyArray<Pick<RemovalResult, "actions" | "docsActions">> | undefined,
): ReadonlyArray<PartialCause> =>
  applied === undefined
    ? planned.flatMap((removal) =>
        removal.actions.flatMap((action): ReadonlyArray<PartialCause> =>
          action._tag === "blocked"
            ? [
                {
                  code: "removal-blocked",
                  subject: { destinationPath: action.destinationPath, reason: action.message },
                },
              ]
            : [],
        ),
      )
    : applied.flatMap((removal) => [
        ...removal.actions.flatMap((outcome): ReadonlyArray<PartialCause> => {
          if (outcome._tag === "applied") return [];
          return [
            {
              code: outcome._tag === "failed" ? "removal-failed" : "removal-skipped",
              subject: {
                destinationPath: outcome.action.destinationPath,
                reason: outcome._tag === "failed" ? outcome.message : outcome.reason,
              },
            },
          ];
        }),
        // A docs mount that stays owed is reported like an agent link that stays owed.
        ...(removal.docsActions ?? []).flatMap((outcome): ReadonlyArray<PartialCause> => {
          if (outcome._tag === "applied") return [];
          return [
            {
              code: outcome._tag === "failed" ? "removal-failed" : "removal-skipped",
              subject: {
                destinationPath: outcome.action.evidence.destinationPath,
                reason: outcome._tag === "skipped" ? "recovery-pending" : outcome.message,
              },
            },
          ];
        }),
      ]);
