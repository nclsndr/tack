import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  decodeEnvelope,
  repositoryRoot as repository,
  runTackSync,
  sourceEntrypoint as entrypoint,
} from "./support/tack-process.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tack-explore-built-")));
const artifact = join(root, "main.js");

beforeAll(() => {
  symlinkSync(join(repository, "apps/cli/node_modules"), join(root, "node_modules"));
  const built = spawnSync(
    process.execPath,
    [
      "build",
      entrypoint,
      "--outfile",
      artifact,
      "--target",
      "bun",
      "--external",
      "@tackup/reader/*",
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  expect(built.status, built.stderr).toBe(0);
}, 20000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

it("refuses a closed stdin from the built executable", () => {
  const ran = runTackSync(["--json", "explore"], {
    entrypoint: artifact,
    cwd: root,
    home: root,
    state: join(root, "state"),
    env: { TERM: "xterm" },
    timeoutMillis: 30_000,
  });
  const result = { ...ran, status: ran.exitCode };
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(2);
  const envelope = decodeEnvelope(result.stdout);
  expect(envelope).toMatchObject({
    command: "explore",
    classification: "invalid-invocation",
    diagnostics: [{ code: "terminal-required" }],
  });
  expect(result.stderr).toBe("");
}, 60_000);
