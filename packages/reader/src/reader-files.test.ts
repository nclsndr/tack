import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { readerEntry, readerFile } from "./reader-files.ts";

it("finds the reader's own files and TypeScript entry points beside its sources", () => {
  expect(readerFile("visuals.tsx")).toBe(fileURLToPath(new URL("visuals.tsx", import.meta.url)));
  expect(readerEntry("engine")).toBe(fileURLToPath(new URL("engine.ts", import.meta.url)));
  expect(readerEntry("watcher")).toBe(fileURLToPath(new URL("watcher.ts", import.meta.url)));
});
