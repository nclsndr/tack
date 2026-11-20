import { BunServices } from "@effect/platform-bun";
import { Effect, type FileSystem } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectStateFormat } from "./state-format-probe.ts";

const run = <A>(effect: Effect.Effect<A, never, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

describe("inspecting a state file without decoding it", () => {
  const inspect = (contents: string | undefined) => {
    const directory = mkdtempSync(join(tmpdir(), "tack-state-format-"));
    const path = join(directory, "state.json");
    if (contents !== undefined) writeFileSync(path, contents);
    return run(inspectStateFormat(path));
  };

  it.each([
    ["no file", undefined, { exists: false, format: null }],
    ["format 1", '{\n  "format": 1,\n  "data": {}\n}', { exists: true, format: 1 }],
    ["format 2", '{"format":2}', { exists: true, format: 2 }],
    ["no envelope key", '{"data":{}}', { exists: true, format: null }],
    ["invalid JSON", "not json", { exists: true, format: null }],
    ["a text format", '{"format":"1"}', { exists: true, format: null }],
  ])("reports %s", async (_name, contents, expected) => {
    expect(await inspect(contents)).toEqual(expected);
  });

  it("treats a path it cannot open for another reason than absence as an existing file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tack-state-format-"));
    const file = join(directory, "file");
    writeFileSync(file, "");

    expect(await run(inspectStateFormat(join(file, "state.json")))).toEqual({
      exists: true,
      format: null,
    });
  });

  it("treats an unreadable path as an existing file of no known format", async () => {
    expect(await run(inspectStateFormat(tmpdir()))).toEqual({
      exists: true,
      format: null,
    });
  });
});
