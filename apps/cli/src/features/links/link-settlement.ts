import { Effect, FileSystem, Path } from "effect";
import {
  applyLinkChanges,
  physicalDestinationIdentity,
  type LinkChange,
} from "../../domain/links/link-record-schema.ts";
import { journalOf, withJournal } from "../../domain/state/state-journal.ts";
import type { JournalEntry, State } from "../../domain/state/state-schema.ts";
import type { StateCheckpointWriter, StatePersistenceError } from "../../services/state-store.ts";
import { Destination, observeDestination } from "../../services/destination.ts";
import { type DestinationObservation } from "../../domain/reconciliation/destination-observation-schema.ts";
import { deliveryKindOf } from "./link-delivery.ts";

/**
 * What a prepared entry became: the link was `record`ed, its old evidence was `retire`d, or the
 * destination shows neither and the ledger `keep`s what it had.
 */
export type Settlement = "record" | "retire" | "keep";

/**
 * Decides one prepared entry from what its destination shows, with the proof of its delivery kind.
 * This is the one rule that settles an entry, whether an apply settles its own batch or the next
 * writer recovers a journal:
 *
 * - a `create` is recorded when the destination shows the link Tack writes for it;
 * - a `replace` is recorded then too, retires the old evidence when the destination is gone, and
 *   otherwise keeps the old evidence;
 * - a `remove` retires its evidence when the destination is gone and otherwise keeps it.
 */
export const settlementOf = (
  entry: JournalEntry,
  observation: DestinationObservation,
): Settlement => {
  if (entry._tag !== "remove" && deliveryKindOf(entry.link).created(observation, entry.link))
    return "record";
  return entry._tag !== "create" && observation._tag === "absent" ? "retire" : "keep";
};

/** The ledger change a settled entry stands for, or none when the ledger keeps what it had. */
export const settlementChange = (
  entry: JournalEntry,
  settlement: Settlement,
): LinkChange | undefined => {
  if (settlement === "keep") return undefined;
  if (settlement === "record") return { _tag: "manage", link: entry.link };
  return { _tag: "unmanage", link: entry._tag === "replace" ? entry.previous : entry.link };
};

/**
 * What the actions of one apply learned while they ran, so that settling its batch has nothing left
 * to observe for them. It lives in memory only: a crash loses it and recovery observes instead.
 */
export type ApplyOutcomes = {
  /** What an action concluded about its destination, by physical destination identity. */
  readonly learned: ReadonlyMap<string, Settlement>;
  /**
   * Destinations whose mutation started and was not verified, which an interruption can leave
   * undecided. Their entries stay prepared for the next writer, which decides them by observation.
   */
  readonly inFlight: ReadonlySet<string>;
  /** Ledger changes for evidence that was never journaled, such as a link already gone. */
  readonly changes: ReadonlyArray<LinkChange>;
};

const noOutcomes: ApplyOutcomes = { learned: new Map(), inFlight: new Set(), changes: [] };

/** A prepared entry with the settlement that was decided for it. */
export type SettledEntry = {
  readonly entry: JournalEntry;
  readonly settlement: Settlement;
};

const keyOf = (entry: JournalEntry) => physicalDestinationIdentity(entry.link.destinationPath);

/**
 * Decides every entry. An entry whose action already learned its settlement uses that one. Any
 * other entry is decided as recovery decides, and an entry whose parents its delivery kind refuses
 * is `blocked`: it settles nothing and stays prepared, which blocks only its own destination.
 * A destination already gone settles a removal whatever its parents are.
 */
const decideEntries = Effect.fnUntraced(function* (
  entries: ReadonlyArray<JournalEntry>,
  learned: ReadonlyMap<string, Settlement>,
): Effect.fn.Return<
  {
    readonly blocked: ReadonlyArray<JournalEntry>;
    readonly settled: ReadonlyArray<SettledEntry>;
  },
  never,
  Destination | FileSystem.FileSystem | Path.Path
> {
  const decided = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      const known = learned.get(keyOf(entry));
      if (known !== undefined) return { _tag: "settled", entry, settlement: known } as const;
      const verdict = yield* deliveryKindOf(entry.link).parents(entry.link, false);
      const observation = yield* observeDestination(entry.link.destinationPath);
      if (verdict._tag === "unsafe" && (entry._tag === "create" || observation._tag !== "absent"))
        return { _tag: "blocked", entry } as const;
      return { _tag: "settled", entry, settlement: settlementOf(entry, observation) } as const;
    }),
  );
  return {
    blocked: decided.flatMap((item) => (item._tag === "blocked" ? [item.entry] : [])),
    settled: decided.flatMap((item) =>
      item._tag === "settled" ? [{ entry: item.entry, settlement: item.settlement }] : [],
    ),
  };
});

/**
 * The state after settling entries: their ledger changes are applied in one pass and the journal
 * keeps only the entries that stay prepared.
 */
export const withSettledEntries = (
  state: State,
  settled: ReadonlyArray<SettledEntry>,
  retained: ReadonlyArray<JournalEntry>,
  changes: ReadonlyArray<LinkChange> = [],
): State =>
  settled.length === 0 && changes.length === 0
    ? state
    : withJournal(
        {
          ...state,
          data: {
            ...state.data,
            links: applyLinkChanges(state.data.links, [
              ...settled.flatMap(({ entry, settlement }) => {
                const change = settlementChange(entry, settlement);
                return change === undefined ? [] : [change];
              }),
              ...changes,
            ]),
          },
        },
        retained,
      );

/** The prepared entries of a state, split into those to settle now and those to keep. */
export type SettlementDecisions = {
  readonly retained: ReadonlyArray<JournalEntry>;
  readonly settled: ReadonlyArray<SettledEntry>;
};

/**
 * Decides every prepared entry of `state`, whatever delivers it. Entries an interruption has left
 * undecided and entries a delivery kind blocks are retained; each other entry uses what its action
 * learned and otherwise what its destination shows.
 */
export const decideSettlements = Effect.fnUntraced(function* (
  state: State,
  outcomes: ApplyOutcomes = noOutcomes,
): Effect.fn.Return<SettlementDecisions, never, Destination | FileSystem.FileSystem | Path.Path> {
  const prepared = journalOf(state);
  const undecided = prepared.filter((entry) => outcomes.inFlight.has(keyOf(entry)));
  const { blocked, settled } = yield* decideEntries(
    prepared.filter((entry) => !outcomes.inFlight.has(keyOf(entry))),
    outcomes.learned,
  );
  return { retained: [...undecided, ...blocked], settled };
});

/**
 * Settles the journal with one checkpoint, so its cost does not grow with the entries.
 *
 * @param outcomes - What the actions of an apply learned while they ran; recovery has none.
 */
export const settleLinkJournal = Effect.fnUntraced(function* (
  writer: StateCheckpointWriter,
  outcomes: ApplyOutcomes = noOutcomes,
): Effect.fn.Return<void, StatePersistenceError, Destination | FileSystem.FileSystem | Path.Path> {
  const { retained, settled } = yield* decideSettlements(writer.current(), outcomes);
  if (settled.length === 0 && outcomes.changes.length === 0) return;
  yield* writer.checkpoint((state) =>
    Effect.succeed({
      state: withSettledEntries(state, settled, retained, outcomes.changes),
      value: undefined,
    }),
  );
});

/**
 * Settles the prepared journal before planning, whatever left it behind and whichever kind of link
 * it holds. Every entry is decided by observation alone, and an entry whose parents are unsafe
 * stays prepared without stopping the rest.
 */
export const recoverLinkJournal = (writer: StateCheckpointWriter) => settleLinkJournal(writer);
