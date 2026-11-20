/** How many commands the demo remembers. */
export const historyLimit = 100;

/** Where the visit's commands are kept, under the page's own origin. */
const historyKey = "tack-demo-history";

/** The two calls of `sessionStorage` the history uses; either may throw when storage is blocked. */
type HistoryStorage = {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
};

/**
 * The history after running `line`: blank lines are not kept, a repeated command moves to the end
 * instead of appearing twice, and only the newest `historyLimit` commands stay.
 */
export const recordCommand = (history: ReadonlyArray<string>, line: string) => {
  const command = line.trim();
  if (command === "") return history;
  return [...history.filter((entry) => entry !== command), command].slice(-historyLimit);
};

const isCommandList = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** The commands this visit ran so far, or none when storage is absent, blocked or holds junk. */
export const loadHistory = (storage: HistoryStorage | undefined): ReadonlyArray<string> => {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(historyKey) ?? "[]");
    return isCommandList(stored) ? stored.slice(-historyLimit) : [];
  } catch {
    return [];
  }
};

/** Keeps the history for the rest of the visit; a refused write only costs the memory. */
export const saveHistory = (
  storage: HistoryStorage | undefined,
  history: ReadonlyArray<string>,
) => {
  try {
    storage?.setItem(historyKey, JSON.stringify(history));
  } catch {
    // Blocked storage leaves the history in memory only.
  }
};

/**
 * Moves through the history from position `at` by `delta` (-1 is older, Up; 1 is newer, Down).
 * Past the newest command is an empty line to type a new one.
 */
export const stepHistory = (history: ReadonlyArray<string>, at: number, delta: number) => {
  const next = Math.max(0, Math.min(history.length, at + delta));
  return { at: next, line: history[next] ?? "" };
};
