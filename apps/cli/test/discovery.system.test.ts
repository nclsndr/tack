import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { afterEach, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { describeHelp, HelpPayloadSchema } from "../src/cli/commands/index.ts";
import { readContracts } from "./support/contracts.ts";
import { decodeEnvelope, runTackSync } from "./support/tack-process.ts";

const roots: Array<string> = [];
const strict = { onExcessProperty: "error" } as const;
const decodeHelp = Schema.decodeUnknownSync(HelpPayloadSchema, strict);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Runs the CLI with no initialized state, no HOME and no TACK_STATE_DIR. */
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tack-discovery-test-")));
  roots.push(root);
  const run = (args: ReadonlyArray<string>) => {
    const result = runTackSync(["--json", ...args], { cwd: root });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    return { envelope: decodeEnvelope(result.stdout), exitCode: result.exitCode };
  };
  return { root, run };
};

it("describes the grammar before init and without a home directory", async () => {
  const { root, run } = fixture();
  const stateDirectory = join(root, "state");

  for (const args of [[], ["pick", "--help"], ["pick", "include", "--help"]]) {
    const { envelope, exitCode } = run(["--state-dir", stateDirectory, ...args]);
    expect(exitCode, args.join(" ")).toBe(0);
    expect(envelope).toMatchObject({ command: "help", status: "success", plan: null });
    decodeHelp(envelope.result);
  }
  expect(decodeHelp(run(["pick", "include", "--help"]).envelope.result)).toMatchObject({
    commandPath: ["pick", "include"],
    mutation: "immediate",
  });

  const contracts = await readContracts();
  expect(contracts.commands.map(({ command }) => command)).toContain("sync");
  for (const contract of contracts.commands) {
    expect(
      contract.flags.find(({ name }) => name === "json"),
      contract.command,
    ).toMatchObject({
      required: false,
      type: "boolean",
    });
    const help = decodeHelp(
      await Effect.runPromise(
        describeHelp(contract.commandPath).pipe(Effect.provide(BunServices.layer)),
      ),
    );
    expect(
      help.flags.find(({ name }) => name === "json"),
      contract.command,
    ).toMatchObject({
      required: false,
      type: "boolean",
    });
  }
  expect(existsSync(stateDirectory)).toBe(false);
});

it("rejects unknown help paths, and the removed schema command, as invalid invocations", () => {
  const { run } = fixture();
  for (const [args, command] of [
    [["wibble", "--help"], "help"],
    [["schema"], "unknown"],
    [["schema", "pick"], "unknown"],
  ] as const) {
    const { envelope, exitCode } = run(args);
    expect(exitCode, args.join(" ")).toBe(2);
    expect(envelope).toMatchObject({
      command,
      classification: "invalid-invocation",
      diagnostics: [expect.objectContaining({ code: "invalid-command" })],
      result: null,
    });
  }
});
