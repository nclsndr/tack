import type { JournalEntry, State } from "./state-schema.ts";

/** Every entry the journal holds, in the order they were prepared. */
export const journalOf = (state: State): ReadonlyArray<JournalEntry> => state.data.journal ?? [];

/**
 * Makes `entries` the whole journal. A journal with nothing left is removed, and a state that had
 * no journal to settle is returned as it is.
 */
export const withJournal = (state: State, entries: ReadonlyArray<JournalEntry>): State => {
  if (state.data.journal === undefined && entries.length === 0) return state;
  const { journal: _journal, ...data } = state.data;
  return { ...state, data: entries.length === 0 ? data : { ...data, journal: entries } };
};

/** Prepares `entries` after the ones the journal already holds, whatever delivers them. */
export const withPreparedEntries = (state: State, entries: ReadonlyArray<JournalEntry>): State =>
  withJournal(state, [...journalOf(state), ...entries]);
