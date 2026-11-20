import { open, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { historyDirectory } from "../../domain/execution/history-location.ts";
import {
  HistoryRecordSchema,
  isHistoryRunId,
  summarizeHistory,
  type HistoryIssue,
  type HistoryRecord,
  type HistorySummary,
} from "../../domain/execution/execution-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";

/** A safe persistence failure; underlying filesystem messages stay out of public records. */
export class HistoryFailure extends Error {
  readonly operation: "create" | "finish" | "read" | "clear";
  constructor(operation: "create" | "finish" | "read" | "clear") {
    super(`Run history ${operation} failed.`);
    this.operation = operation;
  }
}
const recordSuffix = ".json";
const recordPath = (stateDirectory: string, runId: string) => {
  if (isHistoryRunId(runId) === false) throw new HistoryFailure("read");
  return join(historyDirectory(stateDirectory), `${runId}${recordSuffix}`);
};
const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const decode = Schema.decodeUnknownSync(HistoryRecordSchema, { onExcessProperty: "error" });
/** The one decoder for retained record text; show and list must accept and reject the same files. */
const decodeRecordText = (text: string): HistoryRecord => decode(JSON.parse(text));
const syncDirectory = async (path: string) => {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Durably creates a private pending record before executable work is admitted. */
export const createPendingHistory = async (
  stateDirectory: string,
  record: HistoryRecord,
): Promise<void> => {
  try {
    await mkdir(historyDirectory(stateDirectory), { recursive: true, mode: 0o700 });
    const file = await open(recordPath(stateDirectory, record.runId), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(decode(record)));
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(historyDirectory(stateDirectory));
  } catch {
    throw new HistoryFailure("create");
  }
};

/** Replaces a pending record only after its complete terminal document reaches disk. */
export const finishHistory = async (
  stateDirectory: string,
  record: HistoryRecord,
): Promise<void> => {
  const temporary = join(historyDirectory(stateDirectory), `.pending-${crypto.randomUUID()}`);
  let previous: string | undefined;
  let replaced = false;
  let target = "";
  try {
    target = recordPath(stateDirectory, record.runId);
    previous = await readFile(target, "utf8");
    if (decode(JSON.parse(previous)).status !== "pending") throw new HistoryFailure("finish");
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(decode(record)));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    replaced = true;
    await syncDirectory(historyDirectory(stateDirectory));
  } catch {
    // A failed directory durability barrier must restore the visible pending attempt where the filesystem still permits recovery.
    if (replaced === true && previous !== undefined) {
      try {
        const rollback = await open(temporary, "wx", 0o600);
        try {
          await rollback.writeFile(previous);
          await rollback.sync();
        } finally {
          await rollback.close();
        }
        await rename(temporary, target);
        await syncDirectory(historyDirectory(stateDirectory));
      } catch {
        /* A failed device can prevent both commit and recovery; the caller still receives a history failure. */
      }
    }
    throw new HistoryFailure("finish");
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

/** Reads one validated local run, or nothing when no record has that identifier. */
export const readHistory = async (
  stateDirectory: string,
  runId: string,
): Promise<HistoryRecord | undefined> => {
  let text: string;
  try {
    text = await readFile(recordPath(stateDirectory, runId), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new HistoryFailure("read");
  }
  try {
    const record = decodeRecordText(text);
    if (record.runId !== runId) throw new HistoryFailure("read");
    return record;
  } catch {
    throw new HistoryFailure("read");
  }
};

/** Names retained record files in code-unit order; an absent history directory has none. */
const recordFiles = async (stateDirectory: string): Promise<ReadonlyArray<string>> => {
  let names: string[];
  try {
    names = await readdir(historyDirectory(stateDirectory));
  } catch (error) {
    if (isMissing(error)) return [];
    throw new HistoryFailure("read");
  }
  return names.filter((name) => name.endsWith(recordSuffix)).sort(compareCodeUnits);
};

type RecordInspection =
  | { readonly summary: HistorySummary }
  | { readonly issue: HistoryIssue }
  | undefined;

/** Summarizes one record file, or names why it was skipped; a vanished file is skipped silently. */
const inspectRecordFile = async (
  stateDirectory: string,
  name: string,
): Promise<RecordInspection> => {
  const path = join(historyDirectory(stateDirectory), name);
  const runId = name.slice(0, -recordSuffix.length);
  if (isHistoryRunId(runId) === false) return { issue: { path, reason: "invalid-name" } };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    return { issue: { path, reason: "unreadable" } };
  }
  let record: HistoryRecord;
  try {
    record = decodeRecordText(text);
  } catch {
    return { issue: { path, reason: "invalid" } };
  }
  if (record.runId !== runId) return { issue: { path, reason: "run-id-mismatch" } };
  return { summary: summarizeHistory(record) };
};

/**
 * Summarizes every readable retained run, one record at a time so only summaries stay in memory.
 * Unreadable or invalid record files are reported as issues instead of failing the listing.
 */
export const listHistory = async (
  stateDirectory: string,
): Promise<{
  readonly runs: ReadonlyArray<HistorySummary>;
  readonly issues: ReadonlyArray<HistoryIssue>;
}> => {
  const runs: HistorySummary[] = [];
  const issues: HistoryIssue[] = [];
  for (const name of await recordFiles(stateDirectory)) {
    const inspection = await inspectRecordFile(stateDirectory, name);
    if (inspection === undefined) continue;
    if ("summary" in inspection) runs.push(inspection.summary);
    else issues.push(inspection.issue);
  }
  return { runs, issues };
};

/** Counts retained record files without reading or decoding them. */
export const countHistory = async (stateDirectory: string): Promise<number> =>
  (await recordFiles(stateDirectory)).length;

/**
 * Removes every retained record file without decoding it, so corrupt records cannot block
 * clearing; in-flight temporary files and unrelated state stay intact. Returns the removed count.
 */
export const clearHistory = async (stateDirectory: string): Promise<number> => {
  try {
    let removed = 0;
    for (const name of await recordFiles(stateDirectory)) {
      try {
        await rm(join(historyDirectory(stateDirectory), name), { recursive: true });
        removed += 1;
      } catch (error) {
        if (isMissing(error) === false) throw error;
      }
    }
    return removed;
  } catch {
    throw new HistoryFailure("clear");
  }
};
