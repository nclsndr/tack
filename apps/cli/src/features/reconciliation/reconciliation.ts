import { Effect, Path } from "effect";
import { isStrictlyInside } from "../../domain/identity/path-containment.ts";
import type {
  AgentAdapterDescriptor,
  AgentAdapterId,
  AgentCapability,
} from "../../domain/links/agent-adapter-schema.ts";
import {
  agentAdapterDescriptor,
  resolveAdapterCapability,
} from "../../domain/agents/agent-adapter.ts";
import {
  deliversKind,
  managedLinkDestinationPath,
  managedLinkRelativeTarget,
  resourceDirectory as agentResourceDirectory,
} from "../../domain/agents/agent-layout.ts";
import { choiceNamespaceIdentity } from "../../domain/choices/choice-schema.ts";
import {
  selectedDependencyAddresses,
  type DependencyResolution,
  type RequiredDependencyBlocker,
} from "../../domain/choices/dependency-resolution.ts";
import {
  Destination,
  observeDestination,
  resolveLinkDirectory,
} from "../../services/destination.ts";
import { type DestinationObservation } from "../../domain/reconciliation/destination-observation-schema.ts";
import {
  managedLinkEvidenceEqual,
  managedLinkTargetIdentity,
  managedLinkTargetNamespace,
  type ManagedLinkEvidence,
  type ManagedLinkTarget,
} from "../../domain/links/managed-link-schema.ts";
import { agentLink } from "../../domain/links/link-record-schema.ts";
import {
  classifyDestination,
  isOwnedClaim,
  type DestinationClaim,
} from "../links/link-delivery.ts";
import { compareCodeUnits, sortAndDedupeBy } from "../../domain/identity/ordering.ts";
import {
  reconciliationPlanVersion,
  type NamespaceDependencyResolution,
  type ReconciliationAction,
  type ReconciliationConflict,
  type DestinationSharing,
  type ReconciliationDirectoryAlias,
  type ReconciliationPlan,
  type ReconciliationUnitDelivery,
  type ReconciliationUnitPlan,
  type ReconciliationUnitSummary,
} from "../../domain/reconciliation/reconciliation-schema.ts";
import {
  catalogLinkableEntries,
  resourceAddressIdentity,
  type Catalog,
  type LinkableCatalogEntry,
  type LinkableAddress,
  type ResourceAddress,
  entryRootPath,
} from "../../domain/sources/catalog-schema.ts";

import { managedLinksOf } from "../../domain/links/link-record-schema.ts";
import { profileApplicationFor } from "../../domain/profiles/profile-application.ts";
import type { State } from "../../domain/state/state-schema.ts";
import { linkedForUser, type UserLink } from "./linked-for-user.ts";

export { ReconciliationPlanSchema } from "../../domain/reconciliation/reconciliation-schema.ts";
export type { NamespaceDependencyResolution } from "../../domain/reconciliation/reconciliation-schema.ts";

/** One namespace's dependency resolution with the targets that receive its selection. */
export type ReconciliationNamespace = NamespaceDependencyResolution & {
  readonly targets: ReadonlyArray<ManagedLinkTarget>;
};

/** Gives each namespace resolution the targets that belong to its namespace. */
export const reconciliationNamespaces = (
  resolutions: ReadonlyArray<NamespaceDependencyResolution>,
  targets: ReadonlyArray<ManagedLinkTarget>,
): ReadonlyArray<ReconciliationNamespace> =>
  resolutions.map((resolution) => ({
    ...resolution,
    targets: targets.filter(
      (target) =>
        choiceNamespaceIdentity(managedLinkTargetNamespace(target)) ===
        choiceNamespaceIdentity(resolution.namespace),
    ),
  }));

/**
 * Inputs to deterministic read-only reconciliation planning. Every target arrives with the
 * resolution of its own namespace, and that resolution was decided from `catalogEntries`, so each
 * selected address has its catalog resource.
 */
export type PlanReconciliationInput = {
  readonly adapters: ReadonlyArray<AgentAdapterDescriptor>;
  readonly catalogEntries: ReadonlyArray<LinkableCatalogEntry>;
  readonly managedLinks: ReadonlyArray<ManagedLinkEvidence>;
  readonly namespaces: ReadonlyArray<ReconciliationNamespace>;
  /** A capability every planned adapter must support; a unit whose adapter lacks it is blocked. */
  readonly requiredCapability?: AgentCapability;
  /**
   * The registrations of the sources Tack cannot read. A link from one of them is removed because
   * its source is unhealthy, not because it was deselected. Absent, every source is healthy.
   */
  readonly unhealthySourceIds?: ReadonlyArray<string>;
  /**
   * The resources the catalog quarantined, such as a skill whose `SKILL.md` no longer validates. A
   * link to one of them is removed because it is quarantined, not because it was deselected.
   * Absent, nothing is quarantined.
   */
  readonly quarantinedAddresses?: ReadonlyArray<ResourceAddress>;
  /**
   * What a user sync links. A project unit does not link a selected resource that its adapter
   * already links for the user. Absent, nothing is linked for the user.
   */
  readonly userLinks?: ReadonlyArray<UserLink>;
};

/**
 * Builds the part of the planner input that sync and status assemble the same way: the adapter
 * descriptors, the linkable catalog entries and each namespace with its own targets. Each caller
 * adds the managed links it plans against, and sync adds its required capability.
 */
export const plannerInputCore = (input: {
  readonly adapters: ReadonlyArray<AgentAdapterId>;
  readonly catalog: Pick<Catalog, "entries" | "quarantined" | "unhealthySources">;
  readonly resolutions: ReadonlyArray<NamespaceDependencyResolution>;
  readonly targets: ReadonlyArray<ManagedLinkTarget>;
}): Pick<
  PlanReconciliationInput,
  "adapters" | "catalogEntries" | "namespaces" | "quarantinedAddresses" | "unhealthySourceIds"
> => ({
  adapters: input.adapters.map(agentAdapterDescriptor),
  catalogEntries: catalogLinkableEntries(input.catalog),
  namespaces: reconciliationNamespaces(input.resolutions, input.targets),
  quarantinedAddresses: input.catalog.quarantined.flatMap((item) =>
    item.address === undefined ? [] : [item.address],
  ),
  unhealthySourceIds: input.catalog.unhealthySources.map((source) => source.registration.id),
});

/**
 * The managed links sync and status plan against. A fixed user profile names its whole inventory,
 * which never holds the release-owned built-in skills, so their links under the user target are
 * left as they are: neither plans them.
 */
export const plannedManagedLinks = (
  state: State,
  catalog: Pick<Catalog, "entries">,
): ReadonlyArray<ManagedLinkEvidence> => {
  const managedLinks = managedLinksOf(state.data.links);
  if (profileApplicationFor(state, { _tag: "user" }) === undefined) return managedLinks;
  const builtinRegistrations = new Set(
    catalog.entries.flatMap((entry) =>
      entry.origin === "builtin" ? [entry.address.sourceRegistrationId] : [],
    ),
  );
  return managedLinks.filter(
    (link) =>
      link.target._tag !== "user" || !builtinRegistrations.has(link.address.sourceRegistrationId),
  );
};

/**
 * The planner's decision for one destination name, with the facts it decided from. Status reports
 * these decisions instead of classifying destinations on its own.
 */
export type PlannedDestination = {
  readonly actions: ReadonlyArray<ReconciliationAction>;
  readonly adapter: AgentAdapterId;
  readonly conflicts: ReadonlyArray<ReconciliationConflict>;
  readonly desired: ReadonlyArray<ManagedLinkEvidence>;
  readonly destinationPath: string;
  readonly evidence?: ManagedLinkEvidence;
  readonly observation: DestinationObservation;
  /** Present when another adapter's directory resolves to this destination's physical directory. */
  readonly sharing?: DestinationSharing;
  readonly target: ManagedLinkTarget;
};

type DesiredLink = {
  readonly destinationPath: string;
  readonly entry: LinkableCatalogEntry;
  readonly evidence: ManagedLinkEvidence;
  readonly relativeTarget?: string;
};

const sameTarget = (left: ManagedLinkTarget, right: ManagedLinkTarget) =>
  managedLinkTargetIdentity(left) === managedLinkTargetIdentity(right);

const actionRank = (action: ReconciliationAction) => {
  if (action._tag === "directory-create") {
    return 0;
  }
  if (action._tag === "link-create") {
    return 2;
  }
  return 1;
};

const actionPath = (action: ReconciliationAction) =>
  action._tag === "directory-create" ? action.directoryPath : action.destinationPath;

const actionIdentity = (action: ReconciliationAction) =>
  `${actionRank(action)}\u0000${actionPath(action)}\u0000${action._tag}`;

const conflictIdentity = (conflict: ReconciliationConflict) => {
  if (conflict._tag === "destination-directory-conflict") {
    return `${conflict.observation.destinationPath}\u0000${conflict._tag}`;
  }
  return `${conflict.destinationPath}\u0000${conflict._tag}`;
};

const desiredLink = (
  descriptor: AgentAdapterDescriptor,
  target: ManagedLinkTarget,
  linkDirectory: string,
  entry: LinkableCatalogEntry,
  path: Path.Path,
): DesiredLink => {
  const evidence = {
    adapter: descriptor.id,
    address: entry.address,
    sourceDirectoryPath: entryRootPath(entry),
    sourceRegistrationId: entry.sourceRegistrationId,
    target,
  } satisfies ManagedLinkEvidence;
  const relativeTarget = managedLinkRelativeTarget(
    linkDirectory,
    evidence.sourceDirectoryPath,
    path,
  );
  return {
    destinationPath: managedLinkDestinationPath(evidence),
    entry,
    evidence,
    ...(relativeTarget === undefined ? {} : { relativeTarget }),
  };
};

/** Evidence Tack holds for a destination name, and what its observation is to that evidence. */
type RetainedEvidence = {
  readonly evidence: ManagedLinkEvidence;
  readonly claim: DestinationClaim;
};

/** Asks the agent delivery kind what an observed destination is to retained evidence. */
const retain = (observation: DestinationObservation, evidence: ManagedLinkEvidence) =>
  classifyDestination(observation, agentLink(evidence)).pipe(
    Effect.map((claim): RetainedEvidence => ({ claim, evidence })),
  );

type Blockers = readonly [RequiredDependencyBlocker, ...Array<RequiredDependencyBlocker>];

/**
 * Why retained evidence's resource is not linked although the operator did not deselect it: its
 * source is unhealthy, the catalog quarantined it, a required dependency of it is blocked, or the
 * same adapter links it for the user.
 */
type HeldBack =
  | { readonly _tag: "source-unhealthy" }
  | { readonly _tag: "quarantined" }
  | { readonly _tag: "linked-for-user" }
  | { readonly _tag: "blocked"; readonly blockers: Blockers };

/**
 * Names why an owned link is removed, preferring a recorded source that no longer resolves, then
 * a collision, then what held the resource back: an unhealthy source, a quarantine, the user's
 * link, or a blocked required dependency, which the removal names.
 */
const removalReason = (
  resolves: boolean,
  collision: boolean,
  heldBack: HeldBack | undefined,
): Pick<Extract<ReconciliationAction, { readonly _tag: "link-remove" }>, "blockers" | "reason"> => {
  if (resolves === false) return { reason: "source-missing" };
  if (collision === true) return { reason: "collision" };
  if (heldBack === undefined) return { reason: "deselected" };
  return heldBack._tag === "blocked"
    ? { blockers: heldBack.blockers, reason: "blocked" }
    : { reason: heldBack._tag };
};

/**
 * Decides one destination name from its observation, desired links, and retained evidence.
 *
 * @param retained - The evidence Tack holds for this name, with what the delivery kind says the
 *   observation is to it; absence means Tack holds nothing here.
 * @param unwantedChange - What becomes of retained evidence whose link changed outside Tack and that
 *   nothing desires: a sync `release`s it, while a destination no sync plans keeps it as `drift`.
 * @param heldBack - What keeps the retained evidence's resource from being selected, if anything
 *   other than the operator does: its unhealthy source, a quarantine or a blocked dependency group.
 */
const planDestination = (
  observation: DestinationObservation,
  destinationPath: string,
  desired: ReadonlyArray<DesiredLink>,
  retained: RetainedEvidence | undefined,
  unwantedChange: "drift" | "release",
  heldBack?: HeldBack,
): {
  readonly actions: ReadonlyArray<ReconciliationAction>;
  readonly conflicts: ReadonlyArray<ReconciliationConflict>;
} => {
  const collision = desired.length > 1;
  const selected = desired.length === 1 ? desired[0] : undefined;
  const desiredAddresses = desired.map((link) => link.entry.address);

  if (retained === undefined) {
    if (observation._tag !== "absent") {
      return desired.length === 0
        ? { actions: [], conflicts: [] }
        : {
            actions: [],
            conflicts: [
              {
                _tag: "foreign-destination",
                addresses: desiredAddresses,
                destinationPath,
                observation,
              },
            ],
          };
    }
    if (selected?.relativeTarget !== undefined) {
      return {
        actions: [
          {
            _tag: "link-create",
            destinationPath,
            evidence: selected.evidence,
            relativeTarget: selected.relativeTarget,
          },
        ],
        conflicts: [],
      };
    }
    return { actions: [], conflicts: [] };
  }

  const { claim, evidence: existingEvidence } = retained;
  if (claim === "absent") {
    if (selected?.relativeTarget !== undefined) {
      return {
        actions: [
          {
            _tag: "link-create",
            destinationPath,
            evidence: selected.evidence,
            relativeTarget: selected.relativeTarget,
            previousEvidence: existingEvidence,
          },
        ],
        conflicts: [],
      };
    }
    return {
      actions: [
        { _tag: "evidence-retire", destinationPath, evidence: existingEvidence, reason: "absent" },
      ],
      conflicts: [],
    };
  }

  const drift = {
    actions: [],
    conflicts: [
      {
        _tag: "managed-link-drift",
        destinationPath,
        evidence: existingEvidence,
        observation,
      },
    ],
  } as const;
  if (isOwnedClaim(claim) === false) {
    // Nothing wants this name any more, so the record is all that ties Tack to a link it cannot
    // prove it made: forget the record and leave the link. A collision still wants the name, so the
    // drift stays reported until the operator decides which resource keeps it.
    return desired.length === 0 && unwantedChange === "release"
      ? {
          actions: [
            {
              _tag: "evidence-retire",
              destinationPath,
              evidence: existingEvidence,
              reason: "released",
            },
          ],
          conflicts: [],
        }
      : drift;
  }
  const resolves = claim === "linked";

  if (collision === true || selected === undefined) {
    return {
      actions: [
        {
          _tag: "link-remove",
          destinationPath,
          evidence: existingEvidence,
          ...removalReason(resolves, collision, heldBack),
        },
      ],
      conflicts: [],
    };
  }

  if (managedLinkEvidenceEqual(existingEvidence, selected.evidence) === true) {
    // A dangling link that already has the exact desired text cannot be repaired by rewriting it.
    return resolves === true ? { actions: [], conflicts: [] } : drift;
  }

  return selected.relativeTarget === undefined
    ? { actions: [], conflicts: [] }
    : {
        actions: [
          {
            _tag: "link-remove",
            destinationPath,
            evidence: existingEvidence,
            reason: "replace",
          },
          {
            _tag: "link-create",
            destinationPath,
            evidence: selected.evidence,
            relativeTarget: selected.relativeTarget,
            previousEvidence: existingEvidence,
          },
        ],
        conflicts: [],
      };
};

type KindPlan = Pick<ReconciliationUnitPlan, "actions" | "collisions" | "conflicts"> & {
  /** Selected resources of this kind that a blocked required dependency keeps from delivery. */
  readonly blocked: number;
  readonly destinations: ReadonlyArray<PlannedDestination>;
  readonly directoryAliases: ReadonlyArray<ReconciliationDirectoryAlias>;
  /** Selected resources of this kind that the adapter links for the user instead. */
  readonly linkedForUser: ReadonlyArray<LinkableAddress>;
};

const emptyKindPlan = {
  actions: [],
  blocked: 0,
  collisions: [],
  conflicts: [],
  destinations: [],
  directoryAliases: [],
  linkedForUser: [],
};

/**
 * One adapter's resource directory as the physical-directory classification sees it. `status`,
 * `plan`, and apply all derive their view of a directory from this one decision.
 */
type ClassifiedDirectory = {
  readonly adapter: AgentAdapterId;
  readonly directory: string;
  /** An operator's relative leaf symbolic link to a directory inside the same target. */
  readonly alias: boolean;
  /** The real directory in which the OS resolves links created here. */
  readonly linkDirectory: string;
  readonly observation: DestinationObservation;
};

/**
 * Observes one adapter directory and decides whether it is a recognized leaf alias. Only a
 * relative link that resolves to a real directory inside the authorized target qualifies; a
 * dangling link, a link to a file, an absolute link, and a link that leaves the target stay
 * ordinary observations, which the planner reports as conflicts.
 */
const classifyDirectory = Effect.fnUntraced(function* (
  adapter: AgentAdapterId,
  target: ManagedLinkTarget,
  kind: LinkableAddress["kind"],
): Effect.fn.Return<ClassifiedDirectory | undefined, never, Destination | Path.Path> {
  const directory = agentResourceDirectory(adapter, target, kind);
  if (directory === undefined) return undefined;
  const observation = yield* observeDestination(directory);
  const linkDirectory = yield* resolveLinkDirectory(directory);
  const alias =
    observation._tag === "relative-link" &&
    isStrictlyInside(target.canonicalPath, observation.canonicalTarget) &&
    (yield* observeDestination(observation.canonicalTarget).pipe(
      Effect.map((resolved) => resolved._tag === "entry" && resolved.entryType === "directory"),
    ));
  return { adapter, alias, directory, linkDirectory, observation };
});

const isDirectory = (classified: ClassifiedDirectory) =>
  classified.alias ||
  (classified.observation._tag === "entry" && classified.observation.entryType === "directory");

const planKind = Effect.fnUntraced(function* (
  descriptor: AgentAdapterDescriptor,
  target: ManagedLinkTarget,
  resolution: DependencyResolution,
  input: PlanReconciliationInput,
  kind: LinkableAddress["kind"],
): Effect.fn.Return<KindPlan, never, Destination | Path.Path> {
  const path = yield* Path.Path;
  const resourceDirectory = agentResourceDirectory(descriptor.id, target, kind);
  if (resourceDirectory === undefined) {
    return emptyKindPlan;
  }

  // Link text is relative to the real directory that will contain the link, where the OS resolves
  // it, so an agent directory or home reached through a symbolic link still reaches the source.
  const linkDirectory = yield* resolveLinkDirectory(resourceDirectory);
  const own = yield* classifyDirectory(descriptor.id, target, kind);
  // Adapters whose directories resolve to one physical directory share it only through an
  // operator's leaf alias; ordinary symbolic ancestors keep their independent planning.
  const siblings =
    own === undefined || !isDirectory(own)
      ? []
      : (yield* Effect.forEach(
          input.adapters.filter(
            (other) =>
              other.id !== descriptor.id &&
              (input.requiredCapability === undefined ||
                resolveAdapterCapability(other, input.requiredCapability)._tag !== "blocked"),
          ),
          (other) => classifyDirectory(other.id, target, kind),
        )).filter(
          (other): other is ClassifiedDirectory =>
            other !== undefined && isDirectory(other) && other.linkDirectory === own.linkDirectory,
        );
  const sharers = [...(own === undefined ? [] : [own]), ...siblings].sort((left, right) =>
    compareCodeUnits(left.adapter, right.adapter),
  );
  const shared = sharers.length > 1 && sharers.some((member) => member.alias);
  const selected = new Set(selectedDependencyAddresses(resolution).map(resourceAddressIdentity));
  const blockersByAddress = new Map<string, Blockers>(
    resolution.groups.flatMap((group) =>
      group._tag === "blocked"
        ? group.members
            .filter((member) => member.kind === kind)
            .map((member) => [resourceAddressIdentity(member), group.blockers] as const)
        : [],
    ),
  );
  const unhealthySources = new Set(input.unhealthySourceIds);
  const quarantined = new Set(input.quarantinedAddresses?.map(resourceAddressIdentity));
  const selectedEntries = sortAndDedupeBy(
    input.catalogEntries.filter(
      (entry) =>
        entry.address.kind === kind && selected.has(resourceAddressIdentity(entry.address)),
    ),
    (entry) => resourceAddressIdentity(entry.address),
  );
  const forUser =
    target._tag === "project-root"
      ? linkedForUser(
          selectedEntries.map((entry) => entry.address),
          input.userLinks ?? [],
          descriptor.id,
        )
      : [];
  const forUserIdentities = new Set(forUser.map(resourceAddressIdentity));
  const heldBackFor = (evidence: ManagedLinkEvidence): HeldBack | undefined => {
    if (unhealthySources.has(evidence.sourceRegistrationId)) return { _tag: "source-unhealthy" };
    if (quarantined.has(resourceAddressIdentity(evidence.address))) return { _tag: "quarantined" };
    if (forUserIdentities.has(resourceAddressIdentity(evidence.address)))
      return { _tag: "linked-for-user" };
    const blockers = blockersByAddress.get(resourceAddressIdentity(evidence.address));
    return blockers === undefined ? undefined : { _tag: "blocked", blockers };
  };
  const desired = selectedEntries
    .filter((entry) => forUserIdentities.has(resourceAddressIdentity(entry.address)) === false)
    .map((entry) => desiredLink(descriptor, target, linkDirectory, entry, path));
  const desiredByName = new Map<string, Array<DesiredLink>>();
  for (const link of desired) {
    const group = desiredByName.get(link.entry.address.name);
    if (group === undefined) {
      desiredByName.set(link.entry.address.name, [link]);
    } else {
      group.push(link);
    }
  }
  const collisions = [...desiredByName]
    .filter(([, links]) => links.length > 1)
    .map(([name, links]) => ({
      addresses: links
        .map((link) => link.entry.address)
        .sort((left, right) =>
          compareCodeUnits(resourceAddressIdentity(left), resourceAddressIdentity(right)),
        ),
      name,
    }))
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  const unitEvidence = input.managedLinks.filter(
    (item) =>
      item.adapter === descriptor.id &&
      item.address.kind === kind &&
      sameTarget(item.target, target),
  );
  const evidenceByName = new Map(unitEvidence.map((item) => [item.address.name, item]));
  const names = [...new Set([...desiredByName.keys(), ...evidenceByName.keys()])].sort(
    compareCodeUnits,
  );
  const conflicts: Array<ReconciliationConflict> = [];

  for (const link of desired) {
    if (link.relativeTarget === undefined) {
      conflicts.push({
        _tag: "relative-target-unavailable",
        address: link.entry.address,
        destinationPath: link.destinationPath,
        sourceDirectoryPath: entryRootPath(link.entry),
      });
    }
  }

  if (names.length === 0) {
    return {
      ...emptyKindPlan,
      blocked: blockersByAddress.size,
      collisions,
      conflicts,
      linkedForUser: forUser,
    };
  }

  const directoryObservation = own?.observation ?? (yield* observeDestination(resourceDirectory));
  const directoryConflict =
    directoryObservation._tag !== "absent" && (own === undefined || !isDirectory(own));
  if (directoryConflict) {
    conflicts.push({ _tag: "destination-directory-conflict", observation: directoryObservation });
  }

  /** The one adapter that writes and owns the physical link of a name in a shared directory. */
  const writerFor = (name: string): AgentAdapterId => {
    const holder = sharers.find((member) =>
      input.managedLinks.some(
        (item) =>
          item.adapter === member.adapter &&
          item.address.kind === kind &&
          item.address.name === name &&
          sameTarget(item.target, target),
      ),
    );
    const canonical = sharers.find((member) => member.directory === member.linkDirectory);
    return (holder ?? canonical ?? sharers[0])?.adapter ?? descriptor.id;
  };
  const sharingOf = (writer: AgentAdapterId, role: "shared" | "writer") =>
    ({
      adapters: sharers.map((member) => member.adapter),
      directory: resourceDirectory,
      physicalDirectory: linkDirectory,
      role,
      writer,
    }) satisfies DestinationSharing;

  const actions: Array<ReconciliationAction> = [];
  const destinations: Array<PlannedDestination> = [];
  for (const name of names) {
    const destinationPath = managedLinkDestinationPath({
      adapter: descriptor.id,
      address: { kind, name },
      target,
    });
    const observation =
      directoryObservation._tag === "absent"
        ? ({ _tag: "absent", destinationPath } as const)
        : yield* observeDestination(destinationPath);
    const existingEvidence = evidenceByName.get(name);
    const desiredLinks = desiredByName.get(name) ?? [];
    const writer = shared ? writerFor(name) : descriptor.id;
    if (writer !== descriptor.id) {
      // Another adapter writes this physical link. This one only observes it, and reports it as
      // shared when it is exactly the link the writer is expected to hold.
      const [only] = desiredLinks;
      const state =
        observation._tag === "absent"
          ? ("absent" as const)
          : only !== undefined &&
              desiredLinks.length === 1 &&
              observation._tag === "relative-link" &&
              observation.canonicalTarget === only.evidence.sourceDirectoryPath &&
              observation.rawTarget === only.relativeTarget
            ? ("matching" as const)
            : ("other" as const);
      destinations.push({
        actions: [],
        adapter: descriptor.id,
        conflicts: [],
        desired: desiredLinks.map((link) => link.evidence),
        destinationPath,
        ...(existingEvidence === undefined ? {} : { evidence: existingEvidence }),
        observation,
        sharing: { ...sharingOf(writer, "shared"), state },
        target,
      });
      continue;
    }
    const planned = planDestination(
      observation,
      destinationPath,
      desiredLinks,
      existingEvidence === undefined ? undefined : yield* retain(observation, existingEvidence),
      "release",
      existingEvidence === undefined ? undefined : heldBackFor(existingEvidence),
    );
    destinations.push({
      ...planned,
      adapter: descriptor.id,
      desired: desiredLinks.map((link) => link.evidence),
      destinationPath,
      ...(existingEvidence === undefined ? {} : { evidence: existingEvidence }),
      observation,
      ...(shared ? { sharing: sharingOf(writer, "writer") } : {}),
      target,
    });
    // A conflicting resource directory blocks every change below it; the per-name decisions remain
    // so read-only status can still report each destination.
    if (!directoryConflict) {
      actions.push(...planned.actions);
      conflicts.push(...planned.conflicts);
    }
  }

  if (
    directoryObservation._tag === "absent" &&
    actions.some((action) => action._tag === "link-create") === true
  ) {
    actions.push({ _tag: "directory-create", directoryPath: resourceDirectory });
  }

  return {
    actions: sortAndDedupeBy(actions, actionIdentity),
    blocked: blockersByAddress.size,
    collisions,
    conflicts: sortAndDedupeBy(conflicts, conflictIdentity),
    destinations,
    directoryAliases: shared
      ? [
          {
            alsoReachedBy: sharers
              .filter((member) => member.adapter !== descriptor.id)
              .map((member) => member.adapter),
            directory: resourceDirectory,
            kind,
            physicalDirectory: linkDirectory,
          },
        ]
      : [],
    linkedForUser: forUser,
  };
});

const unitSummary = (
  unit: Pick<ReconciliationUnitPlan, "actions" | "collisions" | "conflicts">,
  blocked: number,
): ReconciliationUnitSummary => {
  const count = (tag: ReconciliationAction["_tag"]) =>
    unit.actions.filter((action) => action._tag === tag).length;
  const retirements = (
    reason: Extract<ReconciliationAction, { _tag: "evidence-retire" }>["reason"],
  ) =>
    unit.actions.filter((action) => action._tag === "evidence-retire" && action.reason === reason)
      .length;
  return {
    blocked,
    collision: unit.collisions.length,
    conflict: unit.conflicts.length,
    create: count("link-create"),
    release: retirements("released"),
    remove: count("link-remove"),
    retire: retirements("absent"),
  };
};

const kindDelivery = (
  descriptor: AgentAdapterDescriptor,
  target: ManagedLinkTarget,
  kind: LinkableAddress["kind"],
) => (deliversKind(descriptor, target, kind) ? ("delivered" as const) : ("unsupported" as const));

const planUnit = Effect.fnUntraced(function* (
  descriptor: AgentAdapterDescriptor,
  target: ManagedLinkTarget,
  resolution: DependencyResolution,
  input: PlanReconciliationInput,
) {
  const capability =
    input.requiredCapability === undefined
      ? undefined
      : resolveAdapterCapability(descriptor, input.requiredCapability);
  const base = {
    adapter: descriptor.id,
    ...(capability === undefined ? {} : { capability }),
    delivery: {
      command: kindDelivery(descriptor, target, "command"),
      skill: kindDelivery(descriptor, target, "skill"),
    } satisfies ReconciliationUnitDelivery,
    target,
  };
  if (capability?._tag === "blocked") {
    const empty = { actions: [], collisions: [], conflicts: [] };
    return { unit: { ...base, ...empty, summary: unitSummary(empty, 0) }, destinations: [] };
  }
  const skills = yield* planKind(descriptor, target, resolution, input, "skill");
  const commands = yield* planKind(descriptor, target, resolution, input, "command");
  const work = {
    actions: sortAndDedupeBy([...skills.actions, ...commands.actions], actionIdentity),
    collisions: [...skills.collisions, ...commands.collisions],
    conflicts: sortAndDedupeBy([...skills.conflicts, ...commands.conflicts], conflictIdentity),
  };
  const directoryAliases = [...skills.directoryAliases, ...commands.directoryAliases];
  const forUser = [...skills.linkedForUser, ...commands.linkedForUser];
  return {
    destinations: [...skills.destinations, ...commands.destinations],
    unit: {
      ...base,
      ...work,
      ...(directoryAliases.length === 0 ? {} : { directoryAliases }),
      ...(forUser.length === 0 ? {} : { linkedForUser: forUser }),
      summary: unitSummary(work, skills.blocked + commands.blocked),
    },
  };
});

const planUnits = Effect.fnUntraced(function* (input: PlanReconciliationInput) {
  const targets = sortAndDedupeBy(
    input.namespaces.flatMap(({ resolution, targets: namespaceTargets }) =>
      namespaceTargets.map((target) => ({ resolution, target })),
    ),
    ({ target }) => managedLinkTargetIdentity(target),
  );
  const normalizedAdapters = sortAndDedupeBy(input.adapters, (descriptor) => descriptor.id);
  const units = yield* Effect.forEach(targets, ({ resolution, target }) =>
    Effect.forEach(normalizedAdapters, (descriptor) =>
      planUnit(descriptor, target, resolution, input),
    ),
  );
  return units.flat();
});

/** Produces one deterministic, independent plan per exact target and effective adapter. */
export const planReconciliation = Effect.fnUntraced(function* (
  input: PlanReconciliationInput,
): Effect.fn.Return<ReconciliationPlan, never, Destination | Path.Path> {
  const normalizedResolutions = sortAndDedupeBy(
    input.namespaces.map(({ namespace, resolution }) => ({ namespace, resolution })),
    (selection) => choiceNamespaceIdentity(selection.namespace),
  );
  const units = yield* planUnits(input);

  return {
    kind: "skill-reconciliation-plan",
    namespaceResolutions: normalizedResolutions,
    units: units.map(({ unit }) => unit),
    version: reconciliationPlanVersion,
  };
});

/** Returns the planner's per-destination decisions for the same input `planReconciliation` takes. */
export const planDestinations = Effect.fnUntraced(function* (
  input: PlanReconciliationInput,
): Effect.fn.Return<ReadonlyArray<PlannedDestination>, never, Destination | Path.Path> {
  const units = yield* planUnits(input);
  return units.flatMap(({ destinations }) => destinations);
});

/**
 * Decides a retained destination that no planned unit covers, such as evidence for a disabled
 * adapter or a removing project, or a pending removal: the planner's decision with nothing desired.
 */
export const planRetainedDestination = Effect.fnUntraced(function* (
  evidence: ManagedLinkEvidence,
): Effect.fn.Return<PlannedDestination, never, Destination | Path.Path> {
  const destinationPath = managedLinkDestinationPath(evidence);
  const observation = yield* observeDestination(destinationPath);
  const planned = planDestination(
    observation,
    destinationPath,
    [],
    yield* retain(observation, evidence),
    // No sync plans this destination, so nothing would release a changed link here.
    "drift",
  );
  return {
    ...planned,
    adapter: evidence.adapter,
    desired: [],
    destinationPath,
    evidence,
    observation,
    target: evidence.target,
  };
});
