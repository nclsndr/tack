import { Effect, FileSystem, Path, Schema } from "effect";
import type { LinkEvidence } from "../../domain/links/link-record-schema.ts";
import { managedAgentEvidence } from "../../domain/links/link-record-schema.ts";
import { isStrictlyInside } from "../../domain/identity/path-containment.ts";
import {
  DocsConflictCodeSchema,
  DocsError,
  docsRelativeTarget,
  type DocsConflictCode,
} from "../../domain/docs/docs-schema.ts";
import { Destination, observeDestination } from "../../services/destination.ts";
import { type DestinationObservation } from "../../domain/reconciliation/destination-observation-schema.ts";
import { linkResolvesToEvidence, ownsObservedLink } from "./managed-link-ownership.ts";

/**
 * Whether the directories above a link are safe to act through. An unsafe parent names the stable
 * reason, so a plan, an apply and a recovery report the same cause.
 */
export type ParentVerdict =
  | { readonly _tag: "safe" }
  | { readonly _tag: "unsafe"; readonly code: DocsConflictCode; readonly message: string };

/** The parent verdict of a link whose parents need no check. */
const safeParents: ParentVerdict = { _tag: "safe" };

/** Proves a recorded relative link still names the exact stored target, including a missing target. */
const matchesDocsLink = (
  observation: DestinationObservation,
  evidence: Pick<LinkEvidence, "destinationPath" | "sourceDirectoryPath">,
) =>
  (observation._tag === "relative-link" || observation._tag === "unresolved-relative-link") &&
  observation.rawTarget === docsRelativeTarget(evidence) &&
  (observation._tag === "unresolved-relative-link" ||
    observation.canonicalTarget === evidence.sourceDirectoryPath);

/**
 * Rejects redirected project roots and parents before observing or changing a docs destination.
 * With `create`, an absent parent is created, which is never journaled: it records nothing.
 */
export const checkDocsParents = Effect.fnUntraced(function* (
  evidence: Pick<LinkEvidence, "destinationPath" | "target">,
  create: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = evidence.target._tag === "project-root" ? evidence.target.canonicalPath : undefined;
  if (root === undefined || isStrictlyInside(root, evidence.destinationPath) === false)
    return yield* new DocsError({
      code: "docs-destination-escape",
      message: "The docs destination must stay inside its registered root.",
    });
  const actualRoot = yield* fs.realPath(root);
  if (actualRoot !== root)
    return yield* new DocsError({
      code: "docs-root-moved",
      message: "The registered project root has moved.",
    });
  const parts = path
    .relative(root, path.dirname(evidence.destinationPath))
    .split(path.sep)
    .filter((part) => part.length > 0);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const observed = yield* observeDestination(current);
    if (observed._tag === "absent") {
      if (create === false) return undefined;
      yield* fs.makeDirectory(current);
    } else if (observed._tag !== "entry" || observed.entryType !== "directory") {
      return yield* new DocsError({
        code: "docs-parent-not-directory",
        message: `Docs parent ${current} must be an ordinary directory.`,
      });
    }
    if ((yield* fs.realPath(current)) !== current)
      return yield* new DocsError({
        code: "docs-parent-redirected",
        message: `Docs parent ${current} has been redirected.`,
      });
  }
  return undefined;
});

const isConflictCode = Schema.is(DocsConflictCodeSchema);

/** The docs parent policy as a verdict: every way the check can fail names its cause. */
const docsParents = (link: LinkEvidence, create: boolean) =>
  checkDocsParents(link, create).pipe(
    Effect.map((): ParentVerdict => safeParents),
    Effect.catch((error) =>
      Effect.succeed<ParentVerdict>({
        _tag: "unsafe",
        code:
          error._tag === "DocsError" && isConflictCode(error.code)
            ? error.code
            : "docs-parent-unreadable",
        message: error.message,
      }),
    ),
  );

/**
 * What an observed destination is to the evidence Tack holds for it. `linked` is the link Tack
 * writes, resolving to the recorded source; `dangling` is that link once the source no longer
 * resolves. Tack owns both. `foreign` is anything else there, which Tack cannot prove it made.
 */
export type DestinationClaim = "absent" | "linked" | "dangling" | "foreign";

/** Whether a claim proves Tack owns the destination, which authorizes replacing or unlinking it. */
export const isOwnedClaim = (claim: DestinationClaim): boolean =>
  claim === "linked" || claim === "dangling";

/**
 * What the engine asks of a delivery kind. These are the only facts on which agent links and docs
 * mounts differ once a link is planned; each is defined once per kind below.
 */
export type LinkDeliveryKind = {
  /** Whether the directories above the link are safe to act through, creating them if asked. */
  readonly parents: (
    link: LinkEvidence,
    create: boolean,
  ) => Effect.Effect<ParentVerdict, never, Destination | FileSystem.FileSystem | Path.Path>;
  /** Whether an observation shows the link Tack writes for this evidence, which records a create. */
  readonly created: (observation: DestinationObservation, link: LinkEvidence) => boolean;
  /** What an observation is to the link's evidence, which is how planning decides ownership. */
  readonly classify: (
    observation: DestinationObservation,
    link: LinkEvidence,
  ) => Effect.Effect<DestinationClaim, never, Destination | Path.Path>;
  /** Whether an observation proves Tack owns the destination, which authorizes unlinking it. */
  readonly owns: (
    observation: DestinationObservation,
    link: LinkEvidence,
  ) => Effect.Effect<boolean, never, Destination | Path.Path>;
};

/** Derives the ownership proof of a kind from its classification, so the two cannot disagree. */
const ownsBy =
  (classify: LinkDeliveryKind["classify"]): LinkDeliveryKind["owns"] =>
  (observation, link) =>
    classify(observation, link).pipe(Effect.map(isOwnedClaim));

/** An agent delivery can hold only a skill or a command; a destination for anything else is foreign. */
const classifyAgent: LinkDeliveryKind["classify"] = (observation, link) => {
  const evidence = managedAgentEvidence(link);
  if (evidence === undefined) return Effect.succeed("foreign");
  if (observation._tag === "absent") return Effect.succeed("absent");
  return ownsObservedLink(observation, evidence).pipe(
    Effect.map((owned): DestinationClaim => {
      if (owned === false) return "foreign";
      return linkResolvesToEvidence(observation, evidence) ? "linked" : "dangling";
    }),
  );
};

/** A docs mount is Tack's only while it is a relative link with the exact stored text. */
const classifyDocs: LinkDeliveryKind["classify"] = (observation, link) => {
  if (observation._tag === "absent") return Effect.succeed("absent");
  if (matchesDocsLink(observation, link) === false) return Effect.succeed("foreign");
  return Effect.succeed(observation._tag === "relative-link" ? "linked" : "dangling");
};

/**
 * Agent links resolve through directory aliases, so their parents need no check and a dangling
 * link is owned when its text is the text Tack derives from the real directory. A creation is
 * recorded when the link resolves to the recorded source.
 */
const agentKind: LinkDeliveryKind = {
  parents: () => Effect.succeed(safeParents),
  created: (observation, link) => {
    const evidence = managedAgentEvidence(link);
    return evidence !== undefined && linkResolvesToEvidence(observation, evidence);
  },
  classify: classifyAgent,
  owns: ownsBy(classifyAgent),
};

/**
 * Docs mounts sit under a canonical root through ordinary, unredirected directories, so the link
 * text is derived from the destination alone. The one proof, a relative link with that text that
 * resolves to the recorded source or dangles, both records a creation and authorizes a removal.
 */
const docsKind: LinkDeliveryKind = {
  parents: docsParents,
  created: matchesDocsLink,
  classify: classifyDocs,
  owns: ownsBy(classifyDocs),
};

/** The delivery kind that decides the parent policy and the proofs for one link. */
export const deliveryKindOf = (link: LinkEvidence): LinkDeliveryKind =>
  link.delivery._tag === "docs" ? docsKind : agentKind;

/** Asks the delivery kind of a link what an observed destination is to its evidence. */
export const classifyDestination = (observation: DestinationObservation, link: LinkEvidence) =>
  deliveryKindOf(link).classify(observation, link);
