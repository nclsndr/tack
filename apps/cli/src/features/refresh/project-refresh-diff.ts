import { managedAgentEvidence, managedLinksOf } from "../../domain/links/link-record-schema.ts";
import {
  managedLinkDestinationIdentity,
  type ManagedLinkEvidence,
} from "../../domain/links/managed-link-schema.ts";
import { sortAndDedupeBy, sortAndDedupeStrings } from "../../domain/identity/ordering.ts";
import type { ProjectRefreshRemoval } from "./project-refresh-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";

/** Canonical root facts needed to compute a refresh without filesystem effects. */
export type ProjectRootDiffInput = {
  readonly allowHandoffReactivation?: boolean;
  readonly allowNewRoots?: boolean;
  readonly handoffRoots?: ReadonlyArray<string>;
  readonly managedEvidenceRoots: ReadonlyArray<string>;
  readonly observedRoots: ReadonlyArray<string>;
  readonly reachableStaleRoots: ReadonlyArray<string>;
  readonly registeredRoots: ReadonlyArray<string>;
};

/** The deterministic root membership changes proposed by a refresh. */
export type ProjectRootDiff = {
  readonly additions: ReadonlyArray<string>;
  readonly observedRoots: ReadonlyArray<string>;
  readonly reactivations: ReadonlyArray<string>;
  readonly removals: ReadonlyArray<ProjectRefreshRemoval>;
};

/** Computes canonical root additions and safe stale-root handoffs without mutation. */
export const diffProjectRoots = (input: ProjectRootDiffInput): ProjectRootDiff => {
  const observedRoots = sortAndDedupeStrings(input.observedRoots);
  const registeredRoots = sortAndDedupeStrings(input.registeredRoots);
  const handoffRoots = sortAndDedupeStrings(input.handoffRoots ?? []);
  const managedEvidenceRoots = new Set(input.managedEvidenceRoots);
  const reachableStaleRoots = new Set(input.reachableStaleRoots);
  const staleRoots = registeredRoots.filter((root) => observedRoots.includes(root) === false);
  const additions = observedRoots.filter(
    (root) =>
      input.allowNewRoots !== false &&
      registeredRoots.includes(root) === false &&
      handoffRoots.includes(root) === false,
  );
  const reactivations = observedRoots.filter(
    (root) =>
      input.allowHandoffReactivation !== false &&
      registeredRoots.includes(root) === false &&
      handoffRoots.includes(root),
  );
  const finalRoot =
    registeredRoots.length > 0 &&
    staleRoots.length === registeredRoots.length &&
    additions.length === 0 &&
    reactivations.length === 0;
  const removals = registeredRoots
    .filter((root) => observedRoots.includes(root) === false)
    .map((canonicalRoot) => {
      const hasManagedEvidence = managedEvidenceRoots.has(canonicalRoot);
      const reachable = reachableStaleRoots.has(canonicalRoot);
      return {
        action: reachable ? "handoff" : "deregister",
        canonicalRoot,
        finalProject: finalRoot,
        hasManagedEvidence,
        rootReachable: reachable,
      } satisfies ProjectRefreshRemoval;
    });

  return { additions, observedRoots, reactivations, removals };
};

/** Selects managed-link evidence owned by the named project roots. @internal */
export const projectManagedLinks = (
  state: State,
  projectName: string,
  roots: ReadonlyArray<string>,
): ReadonlyArray<ManagedLinkEvidence> => {
  const rootSet = new Set(roots);
  return sortAndDedupeBy(
    managedLinksOf(state.data.links).filter((evidence) => {
      return (
        evidence.target._tag === "project-root" &&
        evidence.target.projectName === projectName &&
        rootSet.has(evidence.target.canonicalPath)
      );
      /* oxlint-enable eslint/no-underscore-dangle */
    }),
    managedLinkDestinationIdentity,
  );
};

const allProjectEvidence = (state: State, projectName: string) =>
  sortAndDedupeBy(
    state.data.links.flatMap((record) => {
      const evidence = managedAgentEvidence(record);
      return evidence !== undefined &&
        evidence.target._tag === "project-root" &&
        evidence.target.projectName === projectName
        ? [evidence]
        : [];
    }),
    managedLinkDestinationIdentity,
  );

/** Tests whether every proposed removal completes direct project deregistration. @internal */
export const finalDirectRemoval = (removals: ReadonlyArray<ProjectRefreshRemoval>): boolean =>
  removals.length > 0 &&
  removals.every((removal) => removal.finalProject === true && removal.action === "deregister");

/** Finds project evidence that a final refresh plan does not account for. @internal */
export const unaccountedProjectEvidenceRoots = (
  state: State,
  projectName: string,
  accountedRoots: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const accounted = new Set(accountedRoots);
  return sortAndDedupeStrings(
    allProjectEvidence(state, projectName).flatMap((evidence) =>
      evidence.target._tag === "project-root" &&
      accounted.has(evidence.target.canonicalPath) === false
        ? [evidence.target.canonicalPath]
        : [],
    ),
  );
};
