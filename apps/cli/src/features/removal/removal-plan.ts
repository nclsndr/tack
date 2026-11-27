import { Effect, FileSystem, Path } from "effect";
import type { AgentAdapterId } from "../../domain/agents/agent-adapter-schema.ts";
import { agentAdapterDescriptors } from "../../domain/agents/agent-adapter.ts";
import { managedLinkDestinationPath, resourceDirectory } from "../../domain/agents/agent-layout.ts";
import {
  agentLink,
  managedAgentEvidence,
  managedLinksOf,
  pendingRemovalsOf,
  type LinkRecord,
} from "../../domain/links/link-record-schema.ts";
import {
  managedLinkDestinationIdentity,
  managedLinkTargetIdentity,
  type ManagedLinkEvidence,
} from "../../domain/links/managed-link-schema.ts";
import { compareCodeUnits, sortAndDedupeBy } from "../../domain/identity/ordering.ts";
import {
  reportPendingRemoval,
  type PendingRemoval,
  type PendingRemovalCause,
} from "../../domain/links/pending-removal-schema.ts";
import { managedDocsEvidence, type DocsManagedLink } from "../../domain/docs/docs-schema.ts";
import { reportProjectRecord, type ProjectRecord } from "../../domain/projects/project-schema.ts";
import { projectLifecycle } from "../../domain/projects/project-schema.ts";
import {
  Destination,
  observeDestination,
  resolveLinkDirectory,
} from "../../services/destination.ts";
import { type DestinationObservation } from "../../domain/reconciliation/destination-observation-schema.ts";
import { destinationObservationMessage } from "../links/managed-link-ownership.ts";
import { classifyDestination, isOwnedClaim } from "../links/link-delivery.ts";
import { planDocsRemoval } from "../docs/docs-links.ts";
import {
  RemovalProjectNotFoundError,
  RemovalRootNotFoundError,
  type RemovalAction,
  type RemovalPlan,
  type RemovalRequest,
  type RemovalScope,
} from "../../domain/reconciliation/removal-schema.ts";

/** A registered project as state holds it: its handoff roots are always listed, possibly none. */
type RemovalProject = ProjectRecord & { readonly removingRoots: ReadonlyArray<string> };

/**
 * The persisted facts that removal scopes and plans read. A state snapshot satisfies it, which
 * keeps this policy independent of the state store.
 */
export type RemovalFacts = {
  readonly data: {
    readonly links: ReadonlyArray<LinkRecord>;
    readonly projects: ReadonlyArray<RemovalProject>;
  };
};

/** Returns the registered projects from a state snapshot. */
export const stateProjects = (state: RemovalFacts) => state.data.projects;

/** Returns exact managed-link evidence from a state snapshot. */
export const stateManagedLinks = (state: RemovalFacts) => managedLinksOf(state.data.links);

/** Returns retained cleanup obligations from a state snapshot. */
export const statePendingRemovals = (state: RemovalFacts) => pendingRemovalsOf(state.data.links);

const targetMatches = (
  evidence: ManagedLinkEvidence,
  targets: ReadonlyArray<ManagedLinkEvidence["target"]>,
) => {
  const evidenceTargetIdentity = managedLinkTargetIdentity(evidence.target);
  return targets.some((target) => managedLinkTargetIdentity(target) === evidenceTargetIdentity);
};

/** Decides whether managed evidence belongs to a removal scope. */
const targetInRemovalScope = (
  state: RemovalFacts,
  evidence: ManagedLinkEvidence,
  scope: RemovalScope,
) => {
  if (scope._tag === "retry-targets") {
    return false;
  }
  if (scope._tag === "reset") return true;
  if (scope._tag === "adapter") {
    return evidence.adapter === scope.adapter;
  }
  if (scope._tag === "source") {
    return evidence.address.sourceRegistrationId === scope.sourceRegistrationId;
  }
  if (scope._tag === "selected-targets") {
    return targetMatches(evidence, scope.targets);
  }
  const target = evidence.target;
  if (target._tag === "user") {
    return false;
  }
  if (scope._tag === "maintenance") {
    const project = stateProjects(state).find((candidate) => candidate.name === target.projectName);
    return (
      (project !== undefined && projectLifecycle(project) === "removing") ||
      (project?.removingRoots ?? []).includes(target.canonicalPath)
    );
  }
  return scope._tag === "project"
    ? target.projectName === scope.projectName
    : target.projectName === scope.projectName && target.canonicalPath === scope.canonicalRoot;
};

/** Decides whether a retained obligation belongs to a removal scope. */
export const pendingInRemovalScope = (
  state: RemovalFacts,
  pending: PendingRemoval,
  scope: RemovalScope,
) => {
  if (scope._tag === "maintenance" || scope._tag === "reset") {
    return true;
  }
  if (scope._tag === "retry-targets") return targetMatches(pending.evidence, scope.targets);
  return targetInRemovalScope(state, pending.evidence, scope);
};

/** Sorts and de-duplicates evidence by physical destination identity. */
const sortRemovalEvidence = (evidence: ReadonlyArray<ManagedLinkEvidence>) =>
  sortAndDedupeBy(evidence, managedLinkDestinationIdentity);

/** Selects the evidence of every link record that one scope covers, managed or owed. */
const evidenceForRemovalScope = (state: RemovalFacts, scope: RemovalScope) =>
  sortRemovalEvidence(
    state.data.links.flatMap((record) => {
      const evidence = managedAgentEvidence(record);
      return evidence !== undefined &&
        ((record.pendingOnly !== true && targetInRemovalScope(state, evidence, scope)) ||
          (record.removal !== undefined &&
            pendingInRemovalScope(state, { ...record.removal, evidence }, scope)))
        ? [evidence]
        : [];
    }),
  );

/** Selects the retained obligations covered by one scope. */
const pendingEvidenceForRemovalScope = (state: RemovalFacts, scope: RemovalScope) =>
  statePendingRemovals(state).filter((item) => pendingInRemovalScope(state, item, scope));

/** Derives the canonical cause for a removal request. */
const causeForRemovalRequest = (
  scope: RemovalScope,
  requested: PendingRemovalCause | undefined,
) => {
  if (requested !== undefined) return requested;
  if (scope._tag === "project-root") return "root-removal" as const;
  if (scope._tag === "project") return "project-removal" as const;
  if (scope._tag === "adapter") return "adapter-disable" as const;
  if (scope._tag === "reset") return "reset" as const;
  return "clean" as const;
};

/** Preserves lifecycle-specific causes when one plan seeds pending evidence. */
export const causeForRemovalEvidence = (
  state: RemovalFacts,
  target: ManagedLinkEvidence["target"],
  fallback: PendingRemovalCause,
) => {
  if (target._tag === "project-root") {
    const project = stateProjects(state).find((candidate) => candidate.name === target.projectName);
    if (project !== undefined && projectLifecycle(project) === "removing")
      return "project-removal" as const;
    if (project?.removingRoots.includes(target.canonicalPath) === true) {
      return "root-removal" as const;
    }
  }
  return fallback;
};

/**
 * Classifies one filesystem observation as a deterministic removal action.
 *
 * @param owned - Whether the observation proves Tack owns the destination for this evidence.
 */
const removalActionFromObservation = (
  evidence: ManagedLinkEvidence,
  destinationPath: string,
  observation: DestinationObservation,
  owned: boolean,
  alsoReachedBy: ReadonlyArray<AgentAdapterId>,
): RemovalAction => {
  if (observation._tag === "absent") {
    return { _tag: "retire", destinationPath, evidence };
  }
  if (owned === true) {
    const [first, ...rest] = alsoReachedBy;
    return {
      _tag: "remove",
      ...(first === undefined ? {} : { alsoReachedBy: [first, ...rest] as const }),
      destinationPath,
      evidence,
    };
  }
  return {
    _tag: "blocked",
    destinationPath,
    evidence,
    message: destinationObservationMessage(observation),
    observation,
  };
};

/**
 * The other adapters whose resource directory resolves to the same physical directory as one
 * link's, which happens when an operator aliases agent directories. Authority to remove the link
 * still comes only from the evidence; this names who else sees the removal.
 */
const adaptersReachingLink = Effect.fnUntraced(function* (evidence: ManagedLinkEvidence) {
  const path = yield* Path.Path;
  const physical = yield* resolveLinkDirectory(path.dirname(managedLinkDestinationPath(evidence)));
  const others = yield* Effect.forEach(
    agentAdapterDescriptors.filter((descriptor) => descriptor.id !== evidence.adapter),
    (descriptor) => {
      const directory = resourceDirectory(descriptor.id, evidence.target, evidence.address.kind);
      return directory === undefined
        ? Effect.succeed(undefined)
        : resolveLinkDirectory(directory).pipe(
            Effect.map((real) => (real === physical ? descriptor.id : undefined)),
          );
    },
  );
  return others.filter((adapter): adapter is AgentAdapterId => adapter !== undefined);
});

const docsEntryOnTarget = (
  entry: DocsManagedLink,
  targets: ReadonlyArray<ManagedLinkEvidence["target"]>,
) =>
  targets.some(
    (target) =>
      target._tag === "project-root" &&
      target.projectName === entry.projectName &&
      target.canonicalPath === entry.root,
  );

/**
 * Whether a docs mount sits on an active root of a project that is not being removed. Such a mount
 * is healthy desired state, so only a removal that names it, never a retry, may delete it.
 */
const docsEntryOnActiveRoot = (state: RemovalFacts, entry: DocsManagedLink) => {
  const project = stateProjects(state).find((candidate) => candidate.name === entry.projectName);
  return (
    project !== undefined &&
    projectLifecycle(project) !== "removing" &&
    project.roots.includes(entry.root) &&
    !project.removingRoots.includes(entry.root)
  );
};

/** Whether a mount is managed on a target the scope removes, which the scope's retry spares on an active root. */
const docsMountInScope = (state: RemovalFacts, entry: DocsManagedLink, scope: RemovalScope) => {
  if (scope._tag === "reset") return true;
  if (scope._tag === "source")
    return entry.resource.sourceRegistrationId === scope.sourceRegistrationId;
  if (scope._tag === "project") return entry.projectName === scope.projectName;
  if (scope._tag === "project-root")
    return entry.projectName === scope.projectName && entry.root === scope.canonicalRoot;
  if (scope._tag === "selected-targets") return docsEntryOnTarget(entry, scope.targets);
  // Retry settles obligations only: a mount on an active root has none, so it stays.
  if (scope._tag === "retry-targets")
    return docsEntryOnTarget(entry, scope.targets) && !docsEntryOnActiveRoot(state, entry);
  if (scope._tag === "maintenance")
    return state.data.projects.some(
      (project) => project.name === entry.projectName && project.removingRoots.includes(entry.root),
    );
  return false;
};

/** Whether a docs mount that owes its removal belongs to the scope, whether or not it is still managed. */
const docsObligationInScope = (entry: DocsManagedLink, scope: RemovalScope) => {
  if (scope._tag === "maintenance" || scope._tag === "reset") return true;
  if (scope._tag === "source")
    return entry.resource.sourceRegistrationId === scope.sourceRegistrationId;
  if (scope._tag === "retry-targets" || scope._tag === "selected-targets")
    return docsEntryOnTarget(entry, scope.targets);
  if (scope._tag === "project") return entry.projectName === scope.projectName;
  if (scope._tag === "project-root")
    return entry.projectName === scope.projectName && entry.root === scope.canonicalRoot;
  return false;
};

/**
 * Selects the docs mounts a removal plan removes: the managed ones the scope covers, and every
 * mount that owes its removal inside the scope, so an obligation that outlived its project can be
 * retried like an agent link's.
 */
const docsEvidenceForRemoval = (state: RemovalFacts, scope: RemovalScope) =>
  state.data.links
    .flatMap((record) => {
      const entry = managedDocsEvidence(record);
      return entry !== undefined &&
        ((record.pendingOnly !== true && docsMountInScope(state, entry, scope)) ||
          (record.removal !== undefined && docsObligationInScope(entry, scope)))
        ? [entry]
        : [];
    })
    .sort((left, right) => compareCodeUnits(left.destinationPath, right.destinationPath));

const projectForScope = (state: RemovalFacts, scope: RemovalScope) => {
  if (scope._tag !== "project" && scope._tag !== "project-root") {
    return undefined;
  }
  return stateProjects(state).find((candidate) => candidate.name === scope.projectName);
};

const findProject = (state: RemovalFacts, scope: RemovalScope) => {
  const project = projectForScope(state, scope);
  if ((scope._tag === "project" || scope._tag === "project-root") && project === undefined) {
    return Effect.fail(new RemovalProjectNotFoundError({ projectName: scope.projectName }));
  }
  return Effect.succeed(project);
};

/** Builds a deterministic removal plan from one validated state snapshot. */
export const planRemoval = Effect.fnUntraced(function* (
  state: RemovalFacts,
  request: RemovalRequest,
): Effect.fn.Return<
  RemovalPlan,
  RemovalProjectNotFoundError | RemovalRootNotFoundError,
  Destination | FileSystem.FileSystem | Path.Path
> {
  const scope = request.scope;
  const project = yield* findProject(state, scope);
  if (scope._tag === "project-root" && project !== undefined) {
    const retainedRoots = [...project.roots, ...project.removingRoots];
    if (retainedRoots.includes(scope.canonicalRoot) === false) {
      return yield* new RemovalRootNotFoundError({
        canonicalRoot: scope.canonicalRoot,
        projectName: scope.projectName,
      });
    }
  }

  const finalizeProject =
    scope._tag === "project" ||
    scope._tag === "maintenance" ||
    (scope._tag === "project-root" &&
      project !== undefined &&
      project.roots.filter((root) => root !== scope.canonicalRoot).length === 0 &&
      project.removingRoots.filter((root) => root !== scope.canonicalRoot).length === 0);
  // A final root removal is also the final project cleanup boundary. Include every
  // recorded destination for that namespace so project deletion cannot orphan
  // evidence attached to an unregistered or otherwise stale root.
  const evidenceScope: RemovalScope =
    finalizeProject && scope._tag === "project-root"
      ? { _tag: "project", projectName: scope.projectName }
      : scope;

  const evidence = evidenceForRemovalScope(state, evidenceScope);
  const actions = yield* Effect.forEach(evidence, (item) =>
    Effect.gen(function* () {
      const destinationPath = managedLinkDestinationPath(item);
      const observation = yield* observeDestination(destinationPath);
      // Agent links and docs mounts are both asked of their delivery kind whether Tack owns them.
      const owned = isOwnedClaim(yield* classifyDestination(observation, agentLink(item)));
      // Sharing is reported only for a removal Tack is authorized to make.
      const alsoReachedBy = owned === true ? yield* adaptersReachingLink(item) : [];
      return removalActionFromObservation(item, destinationPath, observation, owned, alsoReachedBy);
    }),
  );
  const cause = causeForRemovalRequest(scope, request.cause);
  const docsActions = yield* Effect.forEach(
    docsEvidenceForRemoval(state, evidenceScope),
    planDocsRemoval,
  );
  return {
    actions: [...actions].sort((left, right) =>
      compareCodeUnits(left.destinationPath, right.destinationPath),
    ),
    cause,
    expectedManagedLinks: sortRemovalEvidence(
      stateManagedLinks(state).filter((item) => targetInRemovalScope(state, item, evidenceScope)),
    ),
    expectedPendingRemovals: pendingEvidenceForRemovalScope(state, evidenceScope).map((pending) =>
      reportPendingRemoval(pending),
    ),
    ...(docsActions.length === 0 ? {} : { docsActions }),
    ...(project === undefined ? {} : { expectedProject: reportProjectRecord(project) }),
    ...(scope._tag === "maintenance"
      ? {
          expectedProjects: stateProjects(state)
            .filter((candidate) => candidate.removingRoots.length > 0)
            .map((candidate) => reportProjectRecord(candidate)),
        }
      : {}),
    finalizeProject,
    kind: "managed-removal-plan",
    scope,
    version: 1,
  } satisfies RemovalPlan;
});
