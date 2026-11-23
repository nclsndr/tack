import { profileDelivery } from "../../domain/profiles/profile-delivery.ts";
import { resolveContextSelection } from "../../domain/profiles/profile-application.ts";
import { pendingRemovalsOf } from "../../domain/links/link-record-schema.ts";
import { allSkillChoices } from "../../domain/state/state-intent.ts";
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { agentAdapterDescriptor } from "../../domain/agents/agent-adapter.ts";
import { deliversKind, managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import {
  choiceNamespaceIdentity,
  type ChoiceNamespace,
} from "../../domain/choices/choice-schema.ts";
import { selectedDependencyAddresses } from "../../domain/choices/dependency-resolution.ts";
import { Destination } from "../../services/destination.ts";
import {
  catalogCauses,
  noAdaptersCause,
  resolutionCauses,
  sourceCauses,
  type DestinationState,
  type PartialCause,
} from "../reconciliation/partial-cause.ts";
import {
  planDestinations,
  plannedManagedLinks,
  plannerInputCore,
  planRetainedDestination,
  type PlannedDestination,
} from "../reconciliation/reconciliation.ts";
import type {
  ReconciliationAction,
  ReconciliationConflict,
} from "../../domain/reconciliation/reconciliation-schema.ts";
import {
  managedLinkEvidenceEqual,
  type ManagedLinkTarget,
} from "../../domain/links/managed-link-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { docsPendingRemovalsOf } from "../../domain/docs/docs-schema.ts";
import { docsMountDirectory } from "../docs/docs-resource.ts";
import {
  reportPendingRemoval,
  type PendingRemoval,
} from "../../domain/links/pending-removal-schema.ts";
import {
  inspectProjectRoot,
  linkTargetsOf,
  selectionEcho,
  selectTargetsFromState,
  TargetSelectionError,
  type ProjectInspection,
  type ProjectRootInspection,
} from "../projects/project.ts";
import { projectLifecycle, type TargetSelector } from "../../domain/projects/project-schema.ts";
import type { ProjectRecord } from "../../domain/projects/project-schema.ts";
import { observeImportsDisplay, type ImportsDisplay } from "../imports/import-display.ts";
import { readInvocationSnapshot, type CommandSnapshot } from "../snapshot/command-snapshot.ts";
import { catalogReport } from "../../domain/sources/catalog-report.ts";
import { sortAndDedupeBy } from "../../domain/identity/ordering.ts";
import {
  isLinkableAddress,
  resourceAddressIdentity,
  type Catalog,
} from "../../domain/sources/catalog-schema.ts";
import { linkedForUser, userLinksOf, type UserLink } from "../reconciliation/linked-for-user.ts";
import { Source } from "../sources/source.ts";
import { type SourceInspection } from "../../domain/sources/source-inspection.ts";
import {
  resolveStateDirectory,
  StateStore,
  type StateOptions,
} from "../../services/state-store.ts";
import { type State } from "../../domain/state/state-schema.ts";
import {
  statusReportVersion,
  StatusReportSchema,
  type StatusDestination,
  type StatusImports,
  type StatusNamespace,
  type StatusProject,
  type StatusReport,
  type StatusScope,
  type StatusSource,
} from "../../domain/status/status-schema.ts";

/**
 * What status says about imports: the totals, and each problem that needs a look. A missing
 * folder, a folder no skills entry covers, an unreadable imports section and a leftover staging
 * folder are problems; a locally changed folder is information.
 */
const statusImports = (display: ImportsDisplay): StatusImports => ({
  total: display.imports.length,
  locallyChanged: display.imports.filter(({ local }) => local.state === "changed").length,
  problems: [
    ...display.imports.flatMap((summary): StatusImports["problems"] =>
      summary.conditions.flatMap((condition) =>
        condition.code === "import-locally-changed"
          ? []
          : [
              {
                code: condition.code,
                source: summary.source,
                registrationId: summary.registrationId,
                reference: summary.reference,
                path: summary.path,
                message: condition.message,
              },
            ],
      ),
    ),
    ...display.problems.map((problem): StatusImports["problems"][number] => ({
      code: problem.code === "imports-invalid" ? "imports-invalid" : "import-staging-left-over",
      source: problem.source,
      registrationId: problem.registrationId,
      message: problem.message,
    })),
  ],
});

/** Inputs for one scoped, read-only status inspection. */
export type StatusOptions = {
  readonly cwd: string;
  /** Includes optional dependency closure in the desired state, as `reconcile` does. */
  readonly includeOptional?: boolean;
  readonly selector: TargetSelector;
  readonly userTarget?: string;
};

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const statusRoot = (
  root: ProjectRootInspection,
  lifecycle: StatusProject["roots"][number]["lifecycle"],
): StatusProject["roots"][number] =>
  root.status === "active"
    ? { health: "healthy", lifecycle, path: root.root }
    : {
        health: root.status === "stale" ? "missing" : "unhealthy",
        issue: root.issue,
        lifecycle,
        path: root.root,
      };

const statusProject = Effect.fnUntraced(function* (
  inspection: ProjectInspection,
  docs: State["data"]["projects"][number]["docs"],
): Effect.fn.Return<StatusProject, never, FileSystem.FileSystem | Path.Path> {
  const lifecycle = projectLifecycle(inspection.project);
  const activeRoots = inspection.roots.map((root) => statusRoot(root, "active"));
  const removingRoots = yield* Effect.forEach(inspection.project.removingRoots ?? [], (root) =>
    inspectProjectRoot(root).pipe(Effect.map((inspected) => statusRoot(inspected, "removing"))),
  );
  return {
    anchor:
      inspection.anchor.status === "healthy"
        ? { path: inspection.anchor.path, status: "healthy" }
        : {
            issue: inspection.anchor.issue,
            path: inspection.anchor.path,
            status: "unhealthy",
          },
    ...(docs === undefined || docs.attachments.length === 0
      ? {}
      : { docsDestination: docsMountDirectory(docs) }),
    lifecycle,
    name: inspection.project.name,
    roots: [...activeRoots, ...removingRoots].sort((left, right) =>
      compareCodeUnits(left.path, right.path),
    ),
  };
});

const sourceStatuses = (
  inspections: ReadonlyArray<SourceInspection>,
): ReadonlyArray<StatusSource> =>
  inspections
    .map((inspection): StatusSource =>
      inspection.status === "healthy"
        ? {
            registration: inspection.registration,
            status: "healthy",
            ...(inspection.label === undefined ? {} : { label: inspection.label }),
            ...(inspection.labelOrigin === undefined
              ? {}
              : { labelOrigin: inspection.labelOrigin }),
            ...(inspection.warnings === undefined ? {} : { warnings: inspection.warnings }),
          }
        : {
            issue: { code: inspection.issue.code, message: inspection.issue.message },
            registration: inspection.registration,
            status: "unhealthy",
            ...(inspection.label === undefined ? {} : { label: inspection.label }),
            ...(inspection.labelOrigin === undefined
              ? {}
              : { labelOrigin: inspection.labelOrigin }),
          },
    )
    .sort((left, right) =>
      compareCodeUnits(left.registration.canonicalPath, right.registration.canonicalPath),
    );

const scopeFromSelection = Effect.fnUntraced(function* (
  selector: TargetSelector,
  containingRoot: { readonly projectName: string } | undefined,
): Effect.fn.Return<StatusScope, TargetSelectionError> {
  if (selector._tag === "user") {
    return { _tag: "user" };
  }
  if (selector._tag === "project") {
    return { _tag: "project", projectName: selector.projectName };
  }
  if (selector._tag === "all") return { _tag: "all" };
  if (containingRoot === undefined)
    return yield* new TargetSelectionError({
      code: "bare-target-requires-registered-root",
      message:
        "This directory is not inside a registered project. Choose --project NAME, --user or --all.",
    });
  return { _tag: "project", projectName: containingRoot.projectName };
});

const statusNamespace = (
  state: State,
  catalog: Catalog,
  namespace: ChoiceNamespace,
  project: ProjectRecord | undefined,
  includeOptional: boolean,
  actualTargets: ReadonlyArray<string>,
  userLinks: ReadonlyArray<UserLink>,
): StatusNamespace => {
  const choices = allSkillChoices(state)
    .filter(
      (choice) => choiceNamespaceIdentity(choice.namespace) === choiceNamespaceIdentity(namespace),
    )
    .sort((left, right) =>
      compareCodeUnits(
        resourceAddressIdentity(left.address),
        resourceAddressIdentity(right.address),
      ),
    );
  const selected = resolveContextSelection(
    state,
    catalog,
    namespace,
    includeOptional,
    actualTargets,
  );
  const { application, resolution, selection } = selected;
  const retained = application === undefined ? undefined : selected;
  const enabledAdapters = state.data.enabledAdapters;
  const lifecycle =
    project !== undefined && projectLifecycle(project) === "removing"
      ? ("suspended-removing" as const)
      : ("active" as const);
  const desired =
    lifecycle === "active"
      ? [...selectedDependencyAddresses(resolution)].sort((left, right) =>
          compareCodeUnits(resourceAddressIdentity(left), resourceAddressIdentity(right)),
        )
      : [];
  // The planner leaves these out of the project, so status names the user's link that has them.
  const forUser = new Map(
    namespace._tag === "project"
      ? enabledAdapters.map((adapter) => [
          adapter,
          new Set(
            linkedForUser(desired.filter(isLinkableAddress), userLinks, adapter).map(
              resourceAddressIdentity,
            ),
          ),
        ])
      : [],
  );
  return {
    choices,
    ...(application === undefined || retained === undefined
      ? {}
      : {
          profile: {
            application,
            issues: retained.issues,
            delivery: profileDelivery(application, enabledAdapters),
          },
        }),
    desired,
    lifecycle,
    namespace,
    resolution,
    selection,
    undelivered: desired.flatMap((address): StatusNamespace["undelivered"] => {
      if (address.kind === "context") return [{ address, reason: "context-not-delivered" }];
      if (enabledAdapters.length === 0) return [{ address, reason: "no-enabled-adapter" }];
      return enabledAdapters.flatMap((adapter): StatusNamespace["undelivered"] => {
        if (
          deliversKind(
            agentAdapterDescriptor(adapter),
            { _tag: namespace._tag === "project" ? "project-root" : "user" },
            address.kind,
          ) === false
        )
          return [{ address, adapter, reason: "capability-unsupported" }];
        return forUser.get(adapter)?.has(resourceAddressIdentity(address)) === true
          ? [{ address, adapter, reason: "linked-for-user" }]
          : [];
      });
    }),
  };
};

/** Whether a pending removal belongs to the scope; retry can act on any of them in it. */
const scopeIncludesTarget = (scope: StatusScope, target: ManagedLinkTarget) =>
  scope._tag === "all" ||
  (scope._tag === "user"
    ? target._tag === "user"
    : target._tag === "project-root" && target.projectName === scope.projectName);

/**
 * Whether retained evidence belongs to the scope. User evidence counts only for the exact user
 * target that reconcile plans, so evidence left under another home is never reported as drift
 * that no reconcile can repair.
 */
const scopeIncludesEvidence = (
  scope: StatusScope,
  target: ManagedLinkTarget,
  userTarget: string | undefined,
) =>
  target._tag === "user"
    ? scope._tag !== "project" && target.canonicalPath === userTarget
    : scopeIncludesTarget(scope, target);

const hasDecision = (
  planned: PlannedDestination,
  tag: ReconciliationAction["_tag"] | ReconciliationConflict["_tag"],
) =>
  planned.actions.some((action) => action._tag === tag) ||
  planned.conflicts.some((conflict) => conflict._tag === tag);

/**
 * Names the planner's decision for one destination in status terms.
 *
 * @param handMade - Whether the entry in the way is one Tack never linked: it was there first.
 */
const plannedTag = (planned: PlannedDestination, handMade: boolean): StatusDestination["_tag"] => {
  if (planned.desired.length > 1) return "selection-conflict";
  // Another adapter writes this physical link: a link that matches it is shared and healthy.
  if (planned.sharing?.role === "shared") {
    if (planned.observation._tag === "access-failed") return "observation-failed";
    if (planned.sharing.state === "matching") return "matching";
    if (planned.sharing.state === "absent") return "expected-absent";
    return handMade ? "hand-made" : "foreign-entry";
  }
  if (planned.observation._tag === "access-failed") return "observation-failed";
  if (hasDecision(planned, "foreign-destination")) return handMade ? "hand-made" : "foreign-entry";
  if (hasDecision(planned, "managed-link-drift") || hasDecision(planned, "link-remove")) {
    return "drift";
  }
  if (hasDecision(planned, "link-create")) return "expected-absent";
  if (hasDecision(planned, "link-adopt")) return "unrecorded";
  if (
    planned.actions.some(
      (action) => action._tag === "evidence-retire" && action.reason === "released",
    )
  ) {
    return "evidence-changed";
  }
  if (hasDecision(planned, "evidence-retire")) {
    return planned.desired.length === 0 ? "evidence-absent" : "expected-absent";
  }
  // No work planned: either a desired link Tack cannot write, or the converged state.
  if (planned.observation._tag === "absent") return "expected-absent";
  const [selected] = planned.desired;
  return planned.evidence !== undefined &&
    selected !== undefined &&
    managedLinkEvidenceEqual(selected, planned.evidence)
    ? "matching"
    : "drift";
};

const statusDestinations = Effect.fnUntraced(function* (
  state: State,
  catalog: Catalog,
  namespaces: ReadonlyArray<StatusNamespace>,
  scope: StatusScope,
  targets: ReadonlyArray<ManagedLinkTarget>,
  userTarget: string | undefined,
  userLinks: ReadonlyArray<UserLink>,
): Effect.fn.Return<
  ReadonlyArray<StatusDestination>,
  never,
  Destination | FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The links and targets sync plans, so status reports only decisions a sync acts on.
  const managedLinks = plannedManagedLinks(state, catalog);
  const planned = yield* planDestinations({
    ...plannerInputCore({
      adapters: state.data.enabledAdapters,
      catalog,
      resolutions: namespaces.map(({ namespace, resolution }) => ({ namespace, resolution })),
      targets,
    }),
    managedLinks,
    userLinks,
  });
  const decisions = new Map(planned.map((decision) => [decision.destinationPath, decision]));
  const pendingByPath = new Map<string, PendingRemoval>();
  for (const pendingRemoval of pendingRemovalsOf(state.data.links)) {
    if (scopeIncludesTarget(scope, pendingRemoval.evidence.target)) {
      pendingByPath.set(managedLinkDestinationPath(pendingRemoval.evidence), pendingRemoval);
    }
  }
  // An entry in the way that no link record, not even an owed removal, names was there before
  // Tack: it is hand-made. Recorded links an entry replaced are drift or owed removals instead.
  const physicalPath = (decision: PlannedDestination) =>
    path.join(
      decision.sharing?.physicalDirectory ?? path.dirname(decision.destinationPath),
      path.basename(decision.destinationPath),
    );
  const handMadeAt = new Set(
    planned.flatMap((decision) =>
      hasDecision(decision, "foreign-destination") &&
      pendingByPath.has(decision.destinationPath) === false
        ? [physicalPath(decision)]
        : [],
    ),
  );
  const retained = [
    ...managedLinks.filter((evidence) => scopeIncludesEvidence(scope, evidence.target, userTarget)),
    ...[...pendingByPath.values()].map((pendingRemoval) => pendingRemoval.evidence),
  ];
  for (const evidence of retained) {
    const destinationPath = managedLinkDestinationPath(evidence);
    if (!decisions.has(destinationPath)) {
      decisions.set(destinationPath, yield* planRetainedDestination(evidence));
    }
  }

  return yield* Effect.forEach(
    [...decisions.values()].sort((left, right) =>
      compareCodeUnits(left.destinationPath, right.destinationPath),
    ),
    (decision) =>
      fileSystem.stat(decision.target.canonicalPath).pipe(
        Effect.map((info) =>
          info.type === "Directory" ? ("healthy" as const) : ("unhealthy" as const),
        ),
        Effect.catch((error) =>
          Effect.succeed(isNotFound(error) ? ("missing" as const) : ("unhealthy" as const)),
        ),
        Effect.map((targetHealth): StatusDestination => {
          const pendingRemoval = pendingByPath.get(decision.destinationPath);
          const evidence = decision.evidence ?? pendingRemoval?.evidence;
          return {
            _tag:
              targetHealth === "missing"
                ? "target-missing"
                : plannedTag(decision, handMadeAt.has(physicalPath(decision))),
            adapter: decision.adapter,
            desired: [...decision.desired].sort((left, right) =>
              compareCodeUnits(
                resourceAddressIdentity(left.address),
                resourceAddressIdentity(right.address),
              ),
            ),
            destinationPath: decision.destinationPath,
            ...(evidence === undefined ? {} : { evidence }),
            observation: decision.observation,
            ...(decision.sharing === undefined ? {} : { sharing: decision.sharing }),
            ...(pendingRemoval === undefined
              ? {}
              : { pendingRemoval: reportPendingRemoval(pendingRemoval) }),
            target: decision.target,
            targetHealth,
          };
        }),
      ),
  );
});

const projectCauses = (project: StatusProject): ReadonlyArray<PartialCause> => [
  ...(project.lifecycle === "removing"
    ? [{ code: "project-removing", subject: { projectName: project.name } } as const]
    : []),
  ...(project.anchor.status === "unhealthy"
    ? [
        {
          code: "project-anchor-unhealthy",
          subject: {
            issue: project.anchor.issue,
            path: project.anchor.path,
            projectName: project.name,
          },
        } as const,
      ]
    : []),
  ...project.roots.flatMap((root): ReadonlyArray<PartialCause> => {
    const subject = { projectName: project.name, root: root.path };
    return [
      ...(root.lifecycle === "removing" ? [{ code: "root-removing", subject } as const] : []),
      ...(root.health === "missing" ? [{ code: "root-missing", subject } as const] : []),
      ...(root.health === "unhealthy" && root.issue !== undefined
        ? [{ code: "root-unhealthy", subject: { ...subject, issue: root.issue } } as const]
        : []),
    ];
  }),
];

/**
 * One cause per non-matching destination classification, naming its destinations. A destination
 * that several selected resources need is the same fact the sync preview reports as a selection
 * collision, so it becomes that cause, with the candidates that its fix names.
 */
const destinationCauses = (
  destinations: ReadonlyArray<StatusDestination>,
): ReadonlyArray<PartialCause> => {
  const byState = destinations.reduce((states, destination) => {
    if (destination._tag === "matching" || destination._tag === "selection-conflict") return states;
    return states.set(destination._tag, [
      ...(states.get(destination._tag) ?? []),
      destination.destinationPath,
    ]);
  }, new Map<DestinationState, ReadonlyArray<string>>());
  return [
    ...[...byState].map(([state, destinationPaths]) => ({
      code: `destination-${state}` as const,
      subject: { destinationPaths },
    })),
    ...destinations.flatMap((destination): ReadonlyArray<PartialCause> => {
      if (destination._tag !== "selection-conflict") return [];
      const addresses = sortAndDedupeBy(
        destination.desired.map(({ address }) => address),
        resourceAddressIdentity,
      );
      return [
        {
          code: "selection-collision",
          subject: {
            adapter: destination.adapter,
            addresses,
            name: addresses[0]?.name ?? "",
            target: destination.target,
          },
        },
      ];
    }),
  ];
};

/**
 * Every unhealthy, unresolved, or unreconciled observation in a status snapshot, each with its
 * subject. Any cause makes the inspection partial.
 */
export const statusPartialCauses = (report: StatusReport): ReadonlyArray<PartialCause> => [
  ...report.namespaces.flatMap((entry): ReadonlyArray<PartialCause> =>
    entry.profile === undefined || entry.profile.issues.length === 0
      ? []
      : [
          {
            code: "profile-inventory-unresolved",
            subject: { namespace: entry.namespace, issues: entry.profile.issues },
          },
        ],
  ),
  ...report.namespaces.flatMap((entry): ReadonlyArray<PartialCause> =>
    entry.profile?.delivery.incomplete === true
      ? [
          {
            code: "profile-delivery-incomplete",
            subject: { namespace: entry.namespace, issues: entry.profile.delivery.issues },
          },
        ]
      : [],
  ),
  ...catalogCauses(report.catalog.issues),
  ...sourceCauses(
    report.sources.flatMap((source) => (source.status === "unhealthy" ? [source] : [])),
  ),
  ...report.projects.flatMap(projectCauses),
  ...report.namespaces.flatMap((namespace): ReadonlyArray<PartialCause> =>
    namespace.lifecycle === "suspended-removing" && namespace.namespace._tag === "project"
      ? [{ code: "project-removing", subject: { projectName: namespace.namespace.projectName } }]
      : [],
  ),
  ...resolutionCauses(report.namespaces),
  ...(report.namespaces.some((namespace) =>
    namespace.undelivered.some((item) => item.reason === "no-enabled-adapter"),
  )
    ? [noAdaptersCause]
    : []),
  ...report.pendingRemovals.map((pending): PartialCause => ({
    code: "pending-removal",
    subject: {
      cause: pending.cause,
      destinationPath: managedLinkDestinationPath(pending.evidence),
    },
  })),
  ...(report.docsPendingRemovals ?? []).map((pending): PartialCause => ({
    code: "pending-removal",
    subject: { cause: pending.cause, destinationPath: pending.evidence.destinationPath },
  })),
  ...destinationCauses(report.destinations),
  ...report.imports.problems.map(({ code, ...subject }): PartialCause => ({ code, subject })),
];

/**
 * Produces a deterministic status report from one snapshot without acquiring a writer or
 * repairing any state.
 */
export const statusFromSnapshot = Effect.fnUntraced(function* (
  snapshot: CommandSnapshot,
  stateOptions: StateOptions,
  options: StatusOptions,
): Effect.fn.Return<
  StatusReport,
  | import("../projects/project.ts").ProjectNotFoundError
  | import("../projects/project.ts").ProjectStorageError
  | import("../projects/project.ts").ProjectValidationError
  | TargetSelectionError
  | import("../../services/state-store.ts").StateConfigurationError
  | import("../../services/state-store.ts").StateCorruptError
  | import("../../services/state-store.ts").StateFormatUnsupportedError
  | import("../../services/state-store.ts").StateNotInitializedError
  | import("../../services/state-store.ts").StateStorageError,
  Destination | FileSystem.FileSystem | Path.Path | Source | StateStore
> {
  const { state } = snapshot;
  const selected = yield* selectTargetsFromState(state, stateOptions, {
    cwd: options.cwd,
    selector: options.selector,
    ...(options.userTarget === undefined ? {} : { userTarget: options.userTarget }),
  });
  const scope = yield* scopeFromSelection(options.selector, selected.containingRoot);
  const sourceInspections = yield* snapshot.sourceInspections;
  const catalog = yield* snapshot.catalog;
  const importsDisplay = yield* observeImportsDisplay(sourceInspections, catalog);
  const projectInspections = yield* snapshot.projectInspections;
  const scopedInspections = projectInspections
    .filter(
      (inspection) =>
        scope._tag === "all" ||
        (scope._tag === "project" && inspection.project.name === scope.projectName),
    )
    .sort((left, right) => compareCodeUnits(left.project.name, right.project.name));
  const projects = yield* Effect.forEach(scopedInspections, (inspection) =>
    statusProject(
      inspection,
      state.data.projects.find((project) => project.name === inspection.project.name)?.docs,
    ),
  );
  const scopedProjectRecords = state.data.projects
    .filter(
      (candidate) =>
        scope._tag === "all" || (scope._tag === "project" && candidate.name === scope.projectName),
    )
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  const namespaceInputs: ReadonlyArray<{
    readonly namespace: ChoiceNamespace;
    readonly project?: ProjectRecord;
  }> =
    scope._tag === "user"
      ? [{ namespace: { _tag: "user" } }]
      : scope._tag === "project"
        ? scopedProjectRecords.map((candidate) => ({
            namespace: { _tag: "project" as const, projectName: candidate.name },
            project: candidate,
          }))
        : [
            ...scopedProjectRecords.map((candidate) => ({
              namespace: { _tag: "project" as const, projectName: candidate.name },
              project: candidate,
            })),
            { namespace: { _tag: "user" as const } },
          ];
  const userTarget = selected.targets.find((target) => target._tag === "user")?.canonicalPath;
  const userLinks = userLinksOf(state, catalog, options.includeOptional ?? false);
  const namespaces = namespaceInputs
    .map(({ namespace, project }) =>
      statusNamespace(
        state,
        catalog,
        namespace,
        project,
        options.includeOptional ?? false,
        project?.roots ?? (userTarget === undefined ? [] : [userTarget]),
        userLinks,
      ),
    )
    .sort((left, right) =>
      compareCodeUnits(
        choiceNamespaceIdentity(left.namespace),
        choiceNamespaceIdentity(right.namespace),
      ),
    );
  const pendingRemovals = pendingRemovalsOf(state.data.links).filter((pending) =>
    scopeIncludesTarget(scope, pending.evidence.target),
  );
  const destinations = yield* statusDestinations(
    state,
    catalog,
    namespaces,
    scope,
    linkTargetsOf(selected),
    userTarget,
    userLinks,
  );
  const stateDirectory = yield* resolveStateDirectory(stateOptions);
  const docsPendingRemovals = docsPendingRemovalsOf(state.data.links).filter((pending) =>
    scopeIncludesTarget(scope, {
      _tag: "project-root",
      canonicalPath: pending.evidence.root,
      projectName: pending.evidence.projectName,
    }),
  );

  return yield* Schema.decodeUnknownEffect(StatusReportSchema, {
    onExcessProperty: "error",
  })({
    catalog: catalogReport(catalog, {
      includeSources: false,
      imported: importsDisplay.byDirectory,
    }),
    destinations,
    enabledAdapters: state.data.enabledAdapters,
    imports: statusImports(importsDisplay),
    kind: "skill-status",
    namespaces,
    pendingRemovals: pendingRemovals.map((pending) => reportPendingRemoval(pending)),
    ...(docsPendingRemovals.length === 0 ? {} : { docsPendingRemovals }),
    projects,
    selection: selectionEcho(selected),
    scope,
    sources: sourceStatuses(sourceInspections),
    stateDirectory,
    version: statusReportVersion,
  }).pipe(Effect.orDie);
});

/** Reads the invocation's snapshot, then reports its status. */
export const runStatus = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  options: StatusOptions,
) {
  return yield* statusFromSnapshot(
    yield* readInvocationSnapshot(stateOptions),
    stateOptions,
    options,
  );
});
