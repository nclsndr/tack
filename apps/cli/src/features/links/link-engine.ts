import { Effect, FileSystem, Path, PlatformError } from "effect";
import {
  physicalDestinationIdentity,
  type LinkChange,
  type LinkEvidence,
} from "../../domain/links/link-record-schema.ts";
import { journalOf, withPreparedEntries } from "../../domain/state/state-journal.ts";
import type { JournalEntry, State } from "../../domain/state/state-schema.ts";
import type { StateCheckpointWriter, StatePersistenceError } from "../../services/state-store.ts";
import { Destination, observeDestination } from "../../services/destination.ts";
import { type DestinationObservation } from "../../domain/reconciliation/destination-observation-schema.ts";
import { deliveryKindOf, type ParentVerdict } from "./link-delivery.ts";
import { destinationObservationMessage } from "./managed-link-ownership.ts";
import { resourceKinds } from "../../domain/resources/kinds.ts";
import {
  decideSettlements,
  settleLinkJournal,
  withSettledEntries,
  type ApplyOutcomes,
  type Settlement,
} from "./link-settlement.ts";
import type { PendingRemovalLastResult } from "../../domain/links/pending-removal-schema.ts";

/*
 * The one engine that applies agent links and docs mounts: prepare one batch, act, settle once.
 * What differs between the two kinds is asked of `deliveryKindOf` and nowhere else.
 */

/** One link action that changes a link, before it becomes a journal entry. */
export type LinkIntent = {
  readonly _tag: "create" | "remove";
  readonly link: LinkEvidence;
  /** The evidence a creation replaces at its destination, when the plan names it. */
  readonly previous?: LinkEvidence | undefined;
};

/**
 * The journal entries one apply needs: one for every destination it creates, replaces or removes.
 * A removal followed by a creation at the same destination is one replacement naming both pieces
 * of evidence, so each destination appears once.
 */
export const preparedBatchOf = (
  intents: ReadonlyArray<LinkIntent>,
): ReadonlyArray<JournalEntry> => {
  const entries = new Map<string, JournalEntry>();
  for (const intent of intents) {
    const key = physicalDestinationIdentity(intent.link.destinationPath);
    if (intent._tag === "remove") {
      entries.set(key, { _tag: "remove", link: intent.link });
      continue;
    }
    const previous = intent.previous ?? entries.get(key)?.link;
    entries.set(
      key,
      previous === undefined
        ? { _tag: "create", link: intent.link }
        : { _tag: "replace", link: intent.link, previous },
    );
  }
  return [...entries.values()];
};

/** What the actions of one apply learn while they run, to settle the batch from. */
export type LinkLedger = {
  /** The ledger changes the actions concluded, in the order they ran. */
  readonly changes: Array<LinkChange>;
  /** Destinations whose mutation started and was not verified, with the link at each. */
  readonly inFlight: Map<string, LinkEvidence>;
  /** The destinations whose action ended, which no recovery observation needs to decide. */
  readonly learned: Map<string, Settlement>;
  /** Destinations of entries an earlier apply left prepared, which this apply must not touch. */
  readonly blocked: ReadonlySet<string>;
};

/** The identity under which a destination is known to the ledger. */
const keyOfLink = (link: Pick<LinkEvidence, "destinationPath">) =>
  physicalDestinationIdentity(link.destinationPath);

/** An empty ledger for an apply that found `journal` already holding entries. */
export const makeLinkLedger = (journal: ReadonlyArray<JournalEntry> = []): LinkLedger => ({
  changes: [],
  inFlight: new Map(),
  learned: new Map(),
  blocked: new Set(journal.map((entry) => keyOfLink(entry.link))),
});

/** What a ledger tells the settle step. */
const outcomesOf = (ledger: LinkLedger): ApplyOutcomes => ({
  changes: ledger.changes,
  inFlight: new Set(ledger.inFlight.keys()),
  learned: ledger.learned,
});

/** Records what an action concluded about its destination, and that its mutation is verified. */
export const conclude = (ledger: LinkLedger, link: LinkEvidence, settlement: Settlement) => {
  ledger.learned.set(keyOfLink(link), settlement);
  ledger.inFlight.delete(keyOfLink(link));
};

/**
 * Records that an action left its destination as it was, unless an earlier action of the same
 * replacement already concluded something about it: a removal that succeeded stays retired when the
 * creation after it fails.
 */
export const concludeUnchanged = (ledger: LinkLedger, link: LinkEvidence) => {
  if (!ledger.learned.has(keyOfLink(link))) conclude(ledger, link, "keep");
  ledger.inFlight.delete(keyOfLink(link));
};

/** Records that a removal settled its destination: the record and the removal it owed are deleted. */
export const concludeSettled = (ledger: LinkLedger, link: LinkEvidence) => {
  ledger.changes.push({ _tag: "settle", link });
  conclude(ledger, link, "keep");
};

/** Records the result of a removal attempt that left its destination in place. */
export const concludeResult = (
  ledger: LinkLedger,
  link: LinkEvidence,
  lastResult: PendingRemovalLastResult,
) => {
  ledger.changes.push({ _tag: "result", link, lastResult });
  conclude(ledger, link, "keep");
};

/** Whether an earlier apply left this destination prepared, so this one must leave it alone. */
export const isBlocked = (ledger: LinkLedger, link: Pick<LinkEvidence, "destinationPath">) =>
  ledger.blocked.has(keyOfLink(link));

/**
 * What a caller that owns more of the state than its links adds to a prepared batch, so that its
 * own transitions are written by the same two checkpoints.
 */
export type PreparedBatchExtension = {
  /**
   * The caller's transition, applied by the prepare checkpoint before the batch is journaled. With
   * an extension that checkpoint runs even when no entry is fresh.
   */
  readonly prepare: (state: State) => State;
  /** Ledger changes the settle records beside those the actions concluded. */
  readonly changes: (ledger: LinkLedger) => ReadonlyArray<LinkChange>;
  /** Finishes the settled state and writes it, in place of the engine's own settle checkpoint. */
  readonly settle: (settled: State) => Effect.Effect<void, StatePersistenceError>;
};

/** Settles a batch whose caller extends it: decides every entry, then hands the state over. */
const settleExtended = Effect.fnUntraced(function* (
  writer: StateCheckpointWriter,
  ledger: LinkLedger,
  extension: PreparedBatchExtension,
): Effect.fn.Return<void, StatePersistenceError, Destination | FileSystem.FileSystem | Path.Path> {
  const outcomes = outcomesOf(ledger);
  const { retained, settled } = yield* decideSettlements(writer.current(), outcomes);
  const changes = [...outcomes.changes, ...extension.changes(ledger)];
  yield* extension.settle(withSettledEntries(writer.current(), settled, retained, changes));
});

/**
 * Applies work as one batch, however many links it holds. The state is written twice at most:
 *
 * 1. **Prepare.** One checkpoint applies the transition of the `extension`, if any, and journals
 *    every entry, except those for a destination an earlier apply left prepared.
 * 2. **Act.** `act` runs the actions in plan order. Each re-observes its destination and re-proves
 *    ownership right before it changes anything, with no state I/O in between.
 * 3. **Settle.** One checkpoint records every outcome and clears the journal. It decides an entry
 *    by what its action learned and, for one that did not run or did not finish, by observing its
 *    destination exactly as recovery does. It runs when the actions end however they end, so an
 *    interrupted apply still settles what completed. With an `extension`, the extension writes
 *    the settled state instead.
 */
export const runPreparedBatch = Effect.fnUntraced(function* <A, E, R>(
  writer: StateCheckpointWriter,
  entries: ReadonlyArray<JournalEntry>,
  act: (ledger: LinkLedger) => Effect.Effect<A, E, R>,
  extension?: PreparedBatchExtension,
): Effect.fn.Return<
  A,
  E | StatePersistenceError,
  R | Destination | FileSystem.FileSystem | Path.Path
> {
  const ledger = makeLinkLedger(journalOf(writer.current()));
  const fresh = entries.filter((entry) => !ledger.blocked.has(keyOfLink(entry.link)));
  if (fresh.length > 0 || extension !== undefined) {
    yield* writer.checkpoint((state) => {
      const prepared = extension === undefined ? state : extension.prepare(state);
      return Effect.succeed({
        state: fresh.length === 0 ? prepared : withPreparedEntries(prepared, fresh),
        value: undefined,
      });
    });
  }
  return yield* act(ledger).pipe(
    Effect.onExit(() =>
      extension === undefined
        ? settleLinkJournal(writer, outcomesOf(ledger))
        : settleExtended(writer, ledger, extension),
    ),
  );
});

/** Why a link's source cannot be linked to. */
export type SourceRefusal =
  | { readonly _tag: "unreadable"; readonly error: PlatformError.PlatformError }
  | {
      readonly _tag: "wrong-type";
      readonly kind: LinkEvidence["resource"]["kind"];
      readonly expected: "file" | "directory";
    }
  | { readonly _tag: "not-canonical" };

/**
 * Checks a link's source before it is created: it must exist, have the type its resource kind
 * links to, and still be at the canonical path the evidence records.
 */
export const refuseSource = Effect.fnUntraced(function* (
  link: LinkEvidence,
): Effect.fn.Return<SourceRefusal | undefined, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const status = yield* fileSystem.stat(link.sourceDirectoryPath).pipe(
    Effect.map((info) => ({ _tag: "found" as const, info })),
    Effect.catch((error) => Effect.succeed({ _tag: "unreadable" as const, error })),
  );
  if (status._tag === "unreadable") return status;
  const expected = resourceKinds[link.resource.kind].entryType;
  if (status.info.type !== (expected === "file" ? "File" : "Directory"))
    return { _tag: "wrong-type", kind: link.resource.kind, expected };
  const canonical = yield* fileSystem.realPath(link.sourceDirectoryPath).pipe(
    Effect.map((path) => ({ _tag: "found" as const, path })),
    Effect.catch((error) => Effect.succeed({ _tag: "unreadable" as const, error })),
  );
  if (canonical._tag === "unreadable") return canonical;
  return canonical.path === link.sourceDirectoryPath ? undefined : { _tag: "not-canonical" };
});

/** How an attempt to create one link ended. Every refusal leaves the destination as it was. */
export type CreateResult =
  | { readonly _tag: "created" }
  | { readonly _tag: "source-refused"; readonly refusal: SourceRefusal }
  | {
      readonly _tag: "parents-unsafe";
      readonly verdict: Extract<ParentVerdict, { _tag: "unsafe" }>;
    }
  | { readonly _tag: "occupied"; readonly observation: DestinationObservation }
  | { readonly _tag: "filesystem-failure"; readonly error: PlatformError.PlatformError }
  | { readonly _tag: "unverified"; readonly observation: DestinationObservation };

/**
 * Creates one link. It checks the parents of its kind (creating absent ones), then the source,
 * then observes the destination right before the symlink, so the proof and the change are
 * adjacent. A created link is learned as `record`, and a refusal is learned as unchanged. The link
 * text is the caller's, because only the caller knows how it was derived.
 */
export const createLink = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  link: LinkEvidence,
  linkText: string,
): Effect.fn.Return<CreateResult, never, Destination | FileSystem.FileSystem | Path.Path> {
  const refuse = (result: CreateResult) => {
    concludeUnchanged(ledger, link);
    return result;
  };
  const kind = deliveryKindOf(link);
  const verdict = yield* kind.parents(link, true);
  if (verdict._tag === "unsafe") return refuse({ _tag: "parents-unsafe", verdict });
  const refusal = yield* refuseSource(link);
  if (refusal !== undefined) return refuse({ _tag: "source-refused", refusal });

  const observation = yield* observeDestination(link.destinationPath);
  if (observation._tag !== "absent") return refuse({ _tag: "occupied", observation });
  ledger.inFlight.set(keyOfLink(link), link);
  const fileSystem = yield* FileSystem.FileSystem;
  const created = yield* fileSystem.symlink(linkText, link.destinationPath).pipe(
    Effect.map(() => undefined),
    Effect.catch((error) => Effect.succeed(error)),
  );
  const after = yield* observeDestination(link.destinationPath);
  if (kind.created(after, link)) {
    conclude(ledger, link, "record");
    return { _tag: "created" };
  }
  return refuse(
    created === undefined
      ? { _tag: "unverified", observation: after }
      : { _tag: "filesystem-failure", error: created },
  );
});

/** How an attempt to adopt one link ended. Nothing changes the destination. */
export type AdoptResult =
  | { readonly _tag: "adopted" }
  | Extract<CreateResult, { readonly _tag: "source-refused" | "parents-unsafe" }>
  | { readonly _tag: "changed"; readonly observation: DestinationObservation };

/**
 * Records a link Tack did not create as Tack's own, without touching it. It checks the parents and
 * the source as a creation does, then observes the destination: only the link Tack writes for this
 * evidence, with exactly `linkText`, is learned as `record`. Anything else is learned as unchanged.
 */
export const adoptLink = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  link: LinkEvidence,
  linkText: string,
): Effect.fn.Return<AdoptResult, never, Destination | FileSystem.FileSystem | Path.Path> {
  const refuse = (result: AdoptResult) => {
    concludeUnchanged(ledger, link);
    return result;
  };
  const kind = deliveryKindOf(link);
  const verdict = yield* kind.parents(link, false);
  if (verdict._tag === "unsafe") return refuse({ _tag: "parents-unsafe", verdict });
  const refusal = yield* refuseSource(link);
  if (refusal !== undefined) return refuse({ _tag: "source-refused", refusal });
  const observation = yield* observeDestination(link.destinationPath);
  if (
    observation._tag !== "relative-link" ||
    observation.rawTarget !== linkText ||
    kind.created(observation, link) === false
  )
    return refuse({ _tag: "changed", observation });
  conclude(ledger, link, "record");
  return { _tag: "adopted" };
});

/** How an attempt to remove one link ended. Only `removed` changes the destination. */
export type RemoveResult =
  | { readonly _tag: "removed" }
  | {
      readonly _tag: "parents-unsafe";
      readonly verdict: Extract<ParentVerdict, { _tag: "unsafe" }>;
    }
  | { readonly _tag: "not-owned"; readonly observation: DestinationObservation }
  | {
      readonly _tag: "filesystem-failure";
      readonly error: PlatformError.PlatformError;
      readonly observation: DestinationObservation;
    }
  | { readonly _tag: "still-present"; readonly observation: DestinationObservation };

/**
 * Removes one link Tack proves it owns. A destination already gone is removed. Otherwise the
 * parents of its kind must be safe and the observation must prove ownership right before the
 * unlink; the unlink is then verified by observing again. The caller concludes the outcome, since
 * a removal may owe an obligation that a reconciliation does not.
 */
export const removeLink = Effect.fnUntraced(function* (
  ledger: LinkLedger,
  link: LinkEvidence,
): Effect.fn.Return<RemoveResult, never, Destination | FileSystem.FileSystem | Path.Path> {
  const kind = deliveryKindOf(link);
  const before = yield* observeDestination(link.destinationPath);
  if (before._tag === "absent") return { _tag: "removed" };
  const verdict = yield* kind.parents(link, false);
  if (verdict._tag === "unsafe") return { _tag: "parents-unsafe", verdict };
  if ((yield* kind.owns(before, link)) === false) return { _tag: "not-owned", observation: before };

  // FileSystem exposes no atomic compare-and-unlink operation, so an external
  // actor can still replace this verified destination before removal.
  ledger.inFlight.set(keyOfLink(link), link);
  const fileSystem = yield* FileSystem.FileSystem;
  const failure = yield* fileSystem.remove(link.destinationPath, { recursive: false }).pipe(
    Effect.map(() => undefined),
    Effect.catch((error) => Effect.succeed(error)),
  );
  const after = yield* observeDestination(link.destinationPath);
  if (after._tag === "absent") return { _tag: "removed" };
  return failure === undefined
    ? { _tag: "still-present", observation: after }
    : { _tag: "filesystem-failure", error: failure, observation: after };
});

/**
 * Why a create or remove did not happen, in the engine's words. Each caller maps the code to the
 * code it publishes, because agent links, docs mounts and removal publish different ones today.
 * The conclusion is what a removal obligation records for the attempt.
 */
export type LinkFailure =
  | {
      readonly code: "parents-unsafe";
      readonly message: string;
      readonly conclusion: "blocked";
      /** The stable reason the parent check names. */
      readonly reason: Extract<ParentVerdict, { _tag: "unsafe" }>["code"];
    }
  | {
      readonly code: "destination-occupied" | "destination-not-owned" | "unverified";
      readonly message: string;
      readonly conclusion: "blocked";
      /** The destination as last observed, which is what stopped the change. */
      readonly observation: DestinationObservation;
    }
  | { readonly code: "source-changed"; readonly message: string; readonly conclusion: "blocked" }
  | {
      readonly code: "filesystem-failure";
      readonly message: string;
      readonly conclusion: "filesystem-failure";
    };

/** The engine's code for why a create or remove did not happen. */
export type LinkFailureCode = LinkFailure["code"];

const parentsUnsafe = (verdict: Extract<ParentVerdict, { _tag: "unsafe" }>): LinkFailure => ({
  code: "parents-unsafe",
  message: verdict.message,
  conclusion: "blocked",
  reason: verdict.code,
});

const atDestination = (
  code: "destination-occupied" | "destination-not-owned" | "unverified",
  observation: DestinationObservation,
): LinkFailure => ({
  code,
  message: destinationObservationMessage(observation),
  conclusion: "blocked",
  observation,
});

const filesystemFailure = (error: PlatformError.PlatformError): LinkFailure => ({
  code: "filesystem-failure",
  message: error.message,
  conclusion: "filesystem-failure",
});

/** Describes how a create ended: undefined when the link was created. */
export const describeCreate = (result: CreateResult): LinkFailure | undefined => {
  switch (result._tag) {
    case "created":
      return undefined;
    case "parents-unsafe":
      return parentsUnsafe(result.verdict);
    case "source-refused": {
      const { refusal } = result;
      if (refusal._tag === "unreadable") return filesystemFailure(refusal.error);
      return {
        code: "source-changed",
        message:
          refusal._tag === "wrong-type"
            ? `The recorded ${refusal.kind} source must be a ${refusal.expected}.`
            : "The recorded source path is no longer canonical.",
        conclusion: "blocked",
      };
    }
    case "occupied":
      return atDestination("destination-occupied", result.observation);
    case "unverified":
      return atDestination("unverified", result.observation);
    case "filesystem-failure":
      return filesystemFailure(result.error);
    // Coverage skip: the exhaustive never guard cannot run for a well-typed result.
    /* v8 ignore next -- @preserve */
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
};

/** Describes how an adoption ended: undefined when the link was recorded. */
export const describeAdopt = (result: AdoptResult): LinkFailure | undefined => {
  if (result._tag === "adopted") return undefined;
  if (result._tag === "changed") return atDestination("destination-not-owned", result.observation);
  return describeCreate(result);
};

/** Describes how a remove ended: undefined when the link is gone. */
export const describeRemove = (result: RemoveResult): LinkFailure | undefined => {
  switch (result._tag) {
    case "removed":
      return undefined;
    case "parents-unsafe":
      return parentsUnsafe(result.verdict);
    case "not-owned":
      return atDestination("destination-not-owned", result.observation);
    case "still-present":
      return atDestination("unverified", result.observation);
    case "filesystem-failure":
      return filesystemFailure(result.error);
    // Coverage skip: the exhaustive never guard cannot run for a well-typed result.
    /* v8 ignore next -- @preserve */
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
};
