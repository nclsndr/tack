import { Effect, Path } from "effect";
import { managedLinkRelativeTarget } from "../../domain/agents/agent-layout.ts";
import { resolveLinkDirectory } from "../../services/destination.ts";
import { type DestinationObservation } from "../../domain/reconciliation/destination-observation-schema.ts";
import type { ManagedLinkEvidence } from "../../domain/links/managed-link-schema.ts";

/** Proves that an observed relative link currently resolves to the source its evidence records. */
export const linkResolvesToEvidence = (
  observation: DestinationObservation,
  evidence: ManagedLinkEvidence,
) =>
  observation._tag === "relative-link" &&
  observation.canonicalTarget === evidence.sourceDirectoryPath;

/**
 * Proves that Tack owns an observed destination, which authorizes replacing or unlinking it.
 *
 * A link that resolves to its recorded source is owned. A dangling link is owned only when its raw
 * text is exactly the text Tack writes for that evidence, so deleting a source cannot strand its
 * link while every other dangling link stays protected. The text is derived, never read from disk.
 *
 * @param ownedRawTarget - The link text Tack derives for the evidence from the real directory that
 *   contains the link; absence means no relative text can reach the source.
 */
export const isOwnedLink = (
  observation: DestinationObservation,
  evidence: ManagedLinkEvidence,
  ownedRawTarget: string | undefined,
) =>
  linkResolvesToEvidence(observation, evidence) ||
  (observation._tag === "unresolved-relative-link" &&
    ownedRawTarget !== undefined &&
    observation.rawTarget === ownedRawTarget);

/** Decides ownership of one observation, deriving Tack's link text only for a dangling link. */
export const ownsObservedLink = Effect.fnUntraced(function* (
  observation: DestinationObservation,
  evidence: ManagedLinkEvidence,
) {
  if (observation._tag !== "unresolved-relative-link") {
    return isOwnedLink(observation, evidence, undefined);
  }
  const path = yield* Path.Path;
  const linkDirectory = yield* resolveLinkDirectory(path.dirname(observation.destinationPath));
  return isOwnedLink(
    observation,
    evidence,
    managedLinkRelativeTarget(linkDirectory, evidence.sourceDirectoryPath, path),
  );
});

/** Describes why an observed destination is not the managed state an operation expected. */
export const destinationObservationMessage = (observation: DestinationObservation) => {
  if (observation._tag === "access-failed" || observation._tag === "unresolved-relative-link") {
    return observation.message;
  }
  if (observation._tag === "absolute-link") {
    return `The destination is an absolute symbolic link to ${observation.rawTarget}.`;
  }
  if (observation._tag === "entry") {
    return `The destination is an existing ${observation.entryType}.`;
  }
  return `The destination is ${observation._tag}.`;
};
