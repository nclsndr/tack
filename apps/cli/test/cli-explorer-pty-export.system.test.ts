import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "../../..");

// The release gate runs `bun run check` in an exported staging copy that has no `.git`. A test
// that builds a release and silently relies on git passes in a checkout but fails the gate.
it("passes the explorer PTY system test from an export with no .git", () => {
  const exported = realpathSync(mkdtempSync(join(tmpdir(), "tack-export-check-")));
  for (const path of [
    "package.json",
    "bun.lock",
    "patches",
    "tsconfig.base.json",
    "tsconfig.json",
    "vitest.config.mts",
    "scripts",
    "apps/cli/package.json",
    "apps/cli/src",
    "apps/cli/test",
    "packages/core/package.json",
    "packages/core/src",
    "packages/reader/package.json",
    "packages/reader/src",
  ])
    cpSync(join(repository, path), join(exported, path), { recursive: true });
  expect(existsSync(join(exported, ".git"))).toBe(false);

  const { TACK_BUILD_COMMIT: _commit, TACK_BUILD_AHEAD: _ahead, ...inherited } = process.env;
  const run = (args: string[]) =>
    spawnSync(process.execPath, args, {
      cwd: exported,
      env: inherited,
      encoding: "utf8",
      timeout: 240_000,
    });
  const installed = run(["install", "--frozen-lockfile"]);
  expect(installed.status, installed.stdout + installed.stderr).toBe(0);
  const result = run(["--bun", "vitest", "run", "apps/cli/test/cli-explorer-pty.system.test.ts"]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 300_000);
