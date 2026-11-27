import { profileDelivery } from "../../domain/profiles/profile-delivery.ts";
import { Effect } from "effect";
import type { AgentAdapterId, AgentCapability } from "../../domain/agents/agent-adapter-schema.ts";
import { resolveEffectiveAdapters } from "./agent.ts";
import { choiceNamespaceIdentity } from "../../domain/choices/choice-schema.ts";
import { managedLinkTargetNamespace } from "../../domain/links/managed-link-schema.ts";
import { sortAndDedupeBy } from "../../domain/identity/ordering.ts";
import {
  linkTargetsOf,
  selectionEcho,
  selectTargets,
  type SelectionEcho,
} from "../projects/project.ts";
import { type Selector } from "../../domain/projects/project-schema.ts";
import {
  catalogCauses,
  noAdaptersCause,
  reconciliationPlanCauses,
  selectionRootCauses,
  sourceCauses,
  type PartialCause,
} from "./partial-cause.ts";
import {
  planReconciliation,
  plannedManagedLinks,
  plannerInputCore,
  type NamespaceDependencyResolution,
} from "./reconciliation.ts";
import type { ReconciliationPlan } from "../../domain/reconciliation/reconciliation-schema.ts";
import { selectedDependencyAddresses } from "../../domain/choices/dependency-resolution.ts";
import { quarantineIssue } from "../../domain/sources/catalog-report.ts";
import { resolveContextSelection } from "../../domain/profiles/profile-application.ts";
import { allSkillChoices } from "../../domain/state/state-intent.ts";
import type { StateOptions } from "../../services/state-store.ts";
import type { CommandSnapshot } from "../snapshot/command-snapshot.ts";
import { userLinkedExcludes, userLinksOf } from "./linked-for-user.ts";

/** Invocation-scoped inputs for one complete Phase 2 reconciliation command. */
export type ReconcileCommandOptions = {
  readonly adapterOverride?: ReadonlyArray<AgentAdapterId>;
  readonly apply: boolean;
  readonly cwd: string;
  readonly includeOptional: boolean;
  /** A capability every adapter must support; units of adapters that lack it are blocked. */
  readonly requiredCapability?: AgentCapability;
  readonly selector: Selector;
};

export type PreparedReconciliation = {
  readonly causes: ReadonlyArray<PartialCause>;
  readonly plan: ReconciliationPlan;
  readonly projectNames: ReadonlyArray<string>;
  readonly selection: SelectionEcho;
};

export const prepareReconciliation = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  options: ReconcileCommandOptions,
  snapshot: CommandSnapshot,
) {
  const { state } = snapshot;
  const selection = yield* selectTargets(state, stateOptions, {
    cwd: options.cwd,
    selector: options.selector,
  });
  const catalog = yield* snapshot.catalog;
  const targets = linkTargetsOf(selection);
  const namespaces = sortAndDedupeBy(
    targets.map(managedLinkTargetNamespace),
    choiceNamespaceIdentity,
  );
  const selectedNamespaces = namespaces.map((namespace) => ({
    namespace,
    ...resolveContextSelection(
      state,
      catalog,
      namespace,
      options.includeOptional,
      namespace._tag === "project"
        ? (state.data.projects.find((project) => project.name === namespace.projectName)?.roots ??
            [])
        : targets.filter((target) => target._tag === "user").map((target) => target.canonicalPath),
    ),
  }));
  const namespaceResolutions: ReadonlyArray<NamespaceDependencyResolution> = selectedNamespaces;
  const fixedIssues = selectedNamespaces.flatMap((selected): ReadonlyArray<PartialCause> => {
    const application = selected.application;
    if (application === undefined) return [];
    const issues = [...selected.issues];
    return issues.length === 0
      ? []
      : [
          {
            code: "profile-inventory-unresolved",
            subject: { namespace: selected.namespace, issues },
          },
        ];
  });
  const blocked = new Set(
    fixedIssues.flatMap((issue) =>
      issue.code === "profile-inventory-unresolved"
        ? [choiceNamespaceIdentity(issue.subject.namespace)]
        : [],
    ),
  );
  const enabledAdapters = yield* resolveEffectiveAdapters(state.data.enabledAdapters, {
    ...(options.adapterOverride === undefined ? {} : { adapterOverride: options.adapterOverride }),
  });
  const deliveryCauses = selectedNamespaces.flatMap((selected): ReadonlyArray<PartialCause> => {
    if (selected.application === undefined) return [];
    const delivery = profileDelivery(selected.application, enabledAdapters);
    return delivery.incomplete === true
      ? [
          {
            code: "profile-delivery-incomplete",
            subject: { namespace: selected.namespace, issues: delivery.issues },
          },
        ]
      : [];
  });
  const userLinks = userLinksOf(state, catalog, options.includeOptional);
  const plan = yield* planReconciliation({
    ...plannerInputCore({
      adapters: enabledAdapters,
      catalog,
      resolutions: namespaceResolutions.filter(
        (entry) => blocked.has(choiceNamespaceIdentity(entry.namespace)) === false,
      ),
      targets,
    }),
    managedLinks: plannedManagedLinks(state, catalog),
    userLinks,
    ...(options.requiredCapability === undefined
      ? {}
      : { requiredCapability: options.requiredCapability }),
  });
  // Without an explicit `--adapter` or `--no-adapters`, an empty enabled list delivers nothing
  // that the selection asks for.
  const deliversNothing =
    options.adapterOverride === undefined &&
    enabledAdapters.length === 0 &&
    namespaceResolutions.some(({ resolution }) =>
      selectedDependencyAddresses(resolution).some((address) => address.kind !== "context"),
    );

  const projectNames = [
    ...new Set(
      selection.targets.flatMap((target) =>
        target._tag === "project-root" ? [target.projectName] : [],
      ),
    ),
  ];

  return {
    causes: [
      ...fixedIssues,
      ...deliveryCauses,
      ...catalogCauses(catalog.quarantined.map(quarantineIssue)),
      ...sourceCauses(catalog.unhealthySources),
      ...selectionRootCauses(selection),
      ...(deliversNothing ? [noAdaptersCause] : []),
      ...reconciliationPlanCauses(plan),
      ...userLinkedExcludes(
        userLinks,
        allSkillChoices(state).filter(
          (choice) =>
            choice.namespace._tag === "project" &&
            projectNames.includes(choice.namespace.projectName),
        ),
      ).map((subject): PartialCause => ({ code: "project-exclude-linked-for-user", subject })),
    ],
    plan,
    projectNames,
    selection: selectionEcho(selection),
  } satisfies PreparedReconciliation;
});
