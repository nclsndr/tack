import { describe, expect, it } from "vitest";
import {
  historyLimit,
  loadHistory,
  recordCommand,
  saveHistory,
  stepHistory,
} from "./command-history.ts";

/** A storage over one map, as `sessionStorage` would hold the page's values. */
const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("command history", () => {
  it("adds a command at the end and moves a repeated one there", () => {
    expect(recordCommand(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(recordCommand(["a", "b", "c"], "a")).toEqual(["b", "c", "a"]);
  });

  it("ignores blank lines and trims what it keeps", () => {
    expect(recordCommand(["a"], "   ")).toEqual(["a"]);
    expect(recordCommand(["a"], "  tack sync  ")).toEqual(["a", "tack sync"]);
  });

  it("keeps only the newest commands", () => {
    const full = Array.from({ length: historyLimit }, (_, index) => `c${index}`);

    expect(recordCommand(full, "new")).toEqual([...full.slice(1), "new"]);
  });

  it("round-trips through storage", () => {
    const storage = memoryStorage();
    saveHistory(storage, ["tack doctor", "ls"]);

    expect(loadHistory(storage)).toEqual(["tack doctor", "ls"]);
  });

  it.each([
    ["no storage", undefined],
    ["storage that throws", throwing],
    ["nothing stored", memoryStorage()],
    ["text that is not JSON", memoryStorage({ "tack-demo-history": "{" })],
    ["JSON that is not a list of commands", memoryStorage({ "tack-demo-history": "[1, 2]" })],
  ])("starts empty with %s", (_name, storage) => {
    expect(loadHistory(storage)).toEqual([]);
  });

  it("keeps the page working when storage refuses a write", () => {
    expect(() => saveHistory(throwing, ["a"])).not.toThrow();
    expect(() => saveHistory(undefined, ["a"])).not.toThrow();
  });

  it("steps back and forth, ending on an empty line past the newest", () => {
    const history = ["a", "b"];

    expect(stepHistory(history, 2, -1)).toEqual({ at: 1, line: "b" });
    expect(stepHistory(history, 1, -1)).toEqual({ at: 0, line: "a" });
    expect(stepHistory(history, 0, -1)).toEqual({ at: 0, line: "a" });
    expect(stepHistory(history, 1, 1)).toEqual({ at: 2, line: "" });
    expect(stepHistory(history, 2, 1)).toEqual({ at: 2, line: "" });
  });
});
