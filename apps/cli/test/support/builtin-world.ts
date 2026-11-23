import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect } from "vitest";
import { runTackInProcess } from "./host-runner.ts";
import { decodeEnvelope, runTack, type TackRun } from "./tack-process.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Whether a {@link builtinWorld} runs `tack` as a child process or in the test process. */
export type TackRunner = "process" | "in-process";

/** The bundled skills that every catalog lists. */
export const builtinSkills = [
  "author-tack-profiles",
  "manage-tack-sources",
  "prepare-tack-checkout",
  "use-tack",
  "write-reader-figures",
] as const;

/**
 * A throwaway home and state with the Claude Code, Codex and Cursor adapters enabled and no source
 * registered. `base` decides where the fixture lives and therefore how its source path sorts
 * against the built-in source; `.tack-builtin-test-` under `apps/cli` sorts before
 * `apps/cli/src/builtins`.
 */
export const builtinWorld = async (runner: TackRunner, base = tmpdir()) => {
  const root = realpathSync(mkdtempSync(join(base, ".tack-builtin-test-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const state = join(root, "state");
  const tack = (args: ReadonlyArray<string>): Promise<TackRun> =>
    runner === "process"
      ? runTack(args, { cwd: root, home, state })
      : Effect.runPromise(runTackInProcess(args, { cwd: root, home, state }));
  /** Runs `tack --json`, requires the exit status and an empty stderr, and returns the envelope. */
  const run = async (args: ReadonlyArray<string>, exitCode = 0) => {
    const result = await tack(["--json", "--state-dir", state, ...args]);
    expect(result.stderr).toBe("");
    expect(result.exitCode, result.stdout).toBe(exitCode);
    return decodeEnvelope(result.stdout);
  };
  const addSkill = (name: string, metadata = "") => {
    const source = join(root, "source");
    const directory = join(source, "skills", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(source, "tack.yaml"),
      "version: 1\nname: source\nskills:\n  - path: skills\n",
    );
    writeFileSync(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Example skill\n${metadata}---\n`,
    );
    return source;
  };
  const link = (name: string, adapter = ".agents") => join(home, adapter, "skills", name);
  await run(["state", "init"]);
  await run(["adapter", "enable", "claude", "codex", "cursor"]);
  return { root, home, run, addSkill, link };
};
