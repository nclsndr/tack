import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryRecord } from "../../domain/execution/execution-schema.ts";
import { clearHistory, createPendingHistory, finishHistory, readHistory } from "./history.ts";
import { historyDirectory } from "../../domain/execution/history-location.ts";

/** Device failures the history module meets through `node:fs/promises`, injected per call. */
const faults = vi.hoisted(() => ({
  open: (_path: string, _flags: string): Error | undefined => undefined,
  rm: (_path: string): Error | undefined => undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fault = faults.open(String(args[0]), String(args[1]));
      if (fault !== undefined) throw fault;
      return actual.open(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const fault = faults.rm(String(args[0]));
      if (fault !== undefined) throw fault;
      return actual.rm(...args);
    },
  };
});

afterEach(() => {
  faults.open = () => undefined;
  faults.rm = () => undefined;
});

const deviceError = (code: string) => Object.assign(new Error(code), { code });

const fixture = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "tack-history-durability-"));
  try {
    await run(await realpath(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const pending = (): HistoryRecord => ({
  version: 1,
  runId: crypto.randomUUID(),
  status: "pending",
  startedAt: "2026-01-01T00:00:00.000Z",
  address: {
    kind: "script",
    name: "test",
    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  },
});

const complete = (record: HistoryRecord): HistoryRecord => ({
  ...record,
  status: "complete",
  finishedAt: "2026-01-01T00:00:01.000Z",
  result: {
    runId: record.runId,
    outcome: { stage: "output", code: "success", message: "Done.", classification: "success" },
    logs: [],
    logTruncation: { truncated: false, observedBytes: 0, observedEvents: 0, reasons: [] },
    finalization: "complete",
  },
});

describe("terminal history durability", () => {
  it("restores the pending record when the directory barrier after the commit fails", () =>
    fixture(async (directory) => {
      const record = pending();
      await createPendingHistory(directory, record);
      let barriers = 0;
      faults.open = (path, flags) => {
        if (path !== historyDirectory(directory) || flags !== "r") return undefined;
        barriers += 1;
        return barriers === 1 ? deviceError("EIO") : undefined;
      };
      await expect(finishHistory(directory, complete(record))).rejects.toMatchObject({
        operation: "finish",
      });
      expect(barriers).toBe(2);
      expect(await readHistory(directory, record.runId)).toEqual(record);
      expect(await readdir(historyDirectory(directory))).toEqual([`${record.runId}.json`]);
    }));

  it("still reports the failure when the device also refuses the recovery", () =>
    fixture(async (directory) => {
      const record = pending();
      await createPendingHistory(directory, record);
      let barrierFailed = false;
      faults.open = (path, flags) => {
        if (path === historyDirectory(directory) && flags === "r") {
          barrierFailed = true;
          return deviceError("EIO");
        }
        return barrierFailed === true && path.includes(".pending-")
          ? deviceError("EIO")
          : undefined;
      };
      await expect(finishHistory(directory, complete(record))).rejects.toMatchObject({
        operation: "finish",
      });
      // Neither the barrier nor the recovery reached the device; the renamed record stays visible.
      expect(await readHistory(directory, record.runId)).toEqual(complete(record));
    }));

  it("completes a finish whose temporary-file cleanup fails", () =>
    fixture(async (directory) => {
      const record = pending();
      await createPendingHistory(directory, record);
      faults.rm = (path) => (path.includes(".pending-") ? deviceError("EBUSY") : undefined);
      await finishHistory(directory, complete(record));
      expect(
        JSON.parse(
          await readFile(join(historyDirectory(directory), `${record.runId}.json`), "utf8"),
        ),
      ).toEqual(complete(record));
    }));
});

describe("history clearing", () => {
  it("does not count a record that disappeared before its removal", () =>
    fixture(async (directory) => {
      const vanished = pending();
      const kept = pending();
      await createPendingHistory(directory, vanished);
      await createPendingHistory(directory, kept);
      faults.rm = (path) =>
        path.endsWith(`${vanished.runId}.json`) ? deviceError("ENOENT") : undefined;
      expect(await clearHistory(directory)).toBe(1);
      expect(await readdir(historyDirectory(directory))).toEqual([`${vanished.runId}.json`]);
    }));

  it("fails when a record cannot be removed", () =>
    fixture(async (directory) => {
      const record = pending();
      await createPendingHistory(directory, record);
      faults.rm = (path) =>
        path.startsWith(`${historyDirectory(directory)}/`) ? deviceError("EACCES") : undefined;
      await expect(clearHistory(directory)).rejects.toMatchObject({ operation: "clear" });
      expect(await readHistory(directory, record.runId)).toEqual(record);
    }));
});
