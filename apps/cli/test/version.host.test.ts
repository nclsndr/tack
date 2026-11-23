import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { HelpPayloadSchema } from "../src/cli/commands/index.ts";
import { readContracts } from "./support/contracts.ts";
import { runTackInProcess } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

const roots: Array<string> = [];
const strict = { onExcessProperty: "error" } as const;
const decodeHelp = Schema.decodeUnknownSync(HelpPayloadSchema, strict);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Runs the CLI in process with no initialized state, no HOME and no TACK_STATE_DIR. The
 * process-level smoke test of `--version` is in `version.system.test.ts`.
 */
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tack-version-test-")));
  roots.push(root);
  // Neither a home nor a state directory is given, so the run has neither.
  const run = async (args: ReadonlyArray<string>) => {
    const result = await Effect.runPromise(
      runTackInProcess([...(args.includes("--json") ? [] : ["--json"]), ...args], { cwd: root }),
    );
    expect(result.stderr).toBe("");
    return { envelope: decodeEnvelope(result.stdout), exitCode: result.exitCode };
  };
  return { root, run };
};

it("rejects --version next to another command with the normal invalid invocation envelope", async () => {
  const { root, run } = fixture();
  const stateDirectory = join(root, "state");
  for (const args of [
    ["status", "--version"],
    ["--version", "status"],
    ["--version", "--version"],
    ["version", "--version"],
    ["docs", "search", "owner", "--version"],
  ]) {
    const { envelope, exitCode } = await run(["--state-dir", stateDirectory, ...args]);
    expect(exitCode, args.join(" ")).toBe(2);
    expect(envelope, args.join(" ")).toMatchObject({
      status: "failure",
      classification: "invalid-invocation",
      result: null,
    });
    expect(envelope.diagnostics[0]?.code, args.join(" ")).toBe("invalid-flag");
  }
  expect(existsSync(stateDirectory)).toBe(false);
});

it("documents --version through root help and publishes no version or help contract", async () => {
  const { run } = fixture();
  const rootHelp = decodeHelp((await run(["--help"])).envelope.result);
  expect(rootHelp.commandPath).toEqual([]);
  expect(rootHelp.flags.map(({ name }) => name)).toContain("version");
  expect(rootHelp.subcommands.map(({ name }) => name)).not.toContain("version");
  expect(rootHelp.subcommands.map(({ name }) => name)).not.toContain("help");
  expect(decodeHelp((await run(["--version", "--help"])).envelope.result).commandPath).toEqual([]);

  for (const word of ["version", "help"]) {
    const { envelope, exitCode } = await run([word]);
    expect(exitCode, word).toBe(2);
    expect(envelope.diagnostics[0]?.code, word).toBe("invalid-command");
  }

  const contracts = await readContracts();
  expect(contracts.commands.map(({ command }) => command)).not.toContain("version");
  expect(contracts.commands.map(({ command }) => command)).not.toContain("help");
  expect(contracts.payloads["version"]).toBeUndefined();
  expect(contracts.payloads["help"]).toBeUndefined();
});

it("leaves the envelope version and the other format versions unchanged", async () => {
  const { run } = fixture();
  expect((await run(["--version"])).envelope.version).toBe(1);
});
