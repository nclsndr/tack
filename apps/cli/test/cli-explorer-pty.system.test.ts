import { skillText } from "./support/source-tree.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  repositoryRoot as repository,
  runTackSync,
  tackEnvironment,
} from "./support/tack-process.ts";

// Python's standard pty/termios modules work on macOS and Linux CI. A real slave TTY lets us
// inspect ICANON/ECHO while the compiled binary is running and after it exits, without a native
// Node addon or a package that ships platform-specific binaries.
const root = realpathSync(mkdtempSync(join(tmpdir(), "tack-explorer-pty-")));
const release = join(root, "release");
const binary = join(release, "bin", "tack");
const home = join(root, "home");
const state = join(root, "state");
const source = join(root, "source");
const skill = join(source, "skills", "pty-fixture-skill");
const environment = tackEnvironment({ home, state }, { TERM: "xterm" });

const command = (...args: string[]) => {
  const ran = runTackSync(["--json", ...args], {
    binary,
    cwd: root,
    home,
    state,
    env: { TERM: "xterm" },
    timeoutMillis: 15_000,
  });
  return { ...ran, status: ran.exitCode };
};

beforeAll(() => {
  mkdirSync(home);
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(source, "tack.yaml"), "version: 1\nskills:\n  - path: skills\n");
  writeFileSync(
    join(skill, "SKILL.md"),
    skillText("pty-fixture-skill", { description: "A fixed PTY fixture.", body: "# Fixture\n" }),
  );
  const built = spawnSync(process.execPath, ["scripts/build-release.ts", release], {
    cwd: repository,
    // The release gate runs `check` in an exported copy with no .git, so the build cannot ask git.
    env: { ...environment, TACK_BUILD_COMMIT: "abcdef0" },
    encoding: "utf8",
    timeout: 90_000,
  });
  expect(built.status, built.stdout + built.stderr).toBe(0);
  for (const args of [
    ["state", "init"],
    ["source", "add", source, "--apply"],
    ["adapter", "enable", "claude"],
  ]) {
    const result = command(...args);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
}, 100_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const drive = (mode: "normal" | "interrupt") => {
  const result = spawnSync(
    "python3",
    [join(import.meta.dirname, "support", "explorer-pty.py"), binary, root, mode],
    { cwd: root, env: environment, encoding: "utf8", timeout: 45_000 },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const facts: unknown = JSON.parse(result.stdout);
  if (
    typeof facts !== "object" ||
    facts === null ||
    !("transcript" in facts) ||
    typeof facts.transcript !== "string" ||
    !("exitCode" in facts) ||
    typeof facts.exitCode !== "number" ||
    !("raw" in facts) ||
    typeof facts.raw !== "boolean" ||
    !("restored" in facts) ||
    typeof facts.restored !== "boolean"
  )
    throw new Error("The PTY helper returned invalid terminal facts.");
  return {
    exitCode: facts.exitCode,
    raw: facts.raw,
    restored: facts.restored,
    transcript: facts.transcript,
  };
};

it("uses raw mode and the alternate screen, then restores both on normal exit", () => {
  const facts = drive("normal");
  expect(facts.exitCode).toBe(0);
  expect(facts.raw).toBe(true);
  expect(facts.restored).toBe(true);
  expect(facts.transcript).toContain("\u001b[?1049h");
  expect(facts.transcript).toContain("Review: user");
  expect(facts.transcript).toContain("Applied: user");
  expect(facts.transcript).toContain("\u001b[?1049l");
  expect(facts.transcript.lastIndexOf("\u001b[?1049l")).toBeGreaterThan(
    facts.transcript.indexOf("Applied: user"),
  );
}, 50_000);

it("restores the terminal and leaves state untouched on Ctrl-C mid-review", () => {
  const before = readFileSync(join(state, "state.json"));
  const facts = drive("interrupt");
  expect([0, 130]).toContain(facts.exitCode);
  expect(facts.raw).toBe(true);
  expect(facts.restored).toBe(true);
  expect(facts.transcript).toContain("Review: user");
  expect(facts.transcript).toContain("\u001b[?1049h");
  expect(facts.transcript).toContain("\u001b[?1049l");
  expect(readFileSync(join(state, "state.json"))).toEqual(before);
}, 50_000);
