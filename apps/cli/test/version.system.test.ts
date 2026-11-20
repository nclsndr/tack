import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { HelpPayloadSchema } from "../src/cli/commands/index.ts";
import { tackVersion, VersionReportSchema } from "../src/version.ts";
import { readContracts } from "./support/contracts.ts";
import { decodeEnvelope, runTackSync } from "./support/tack-process.ts";

const roots: Array<string> = [];
const versionModule = resolve(import.meta.dirname, "../src/version.ts");
const strict = { onExcessProperty: "error" } as const;
const decodeReport = Schema.decodeUnknownSync(VersionReportSchema, strict);
const decodeHelp = Schema.decodeUnknownSync(HelpPayloadSchema, strict);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Runs the CLI with no initialized state, no HOME and no TACK_STATE_DIR. */
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tack-version-test-")));
  roots.push(root);
  // Neither a home nor a state directory is given, so the process runs with neither.
  const run = (args: ReadonlyArray<string>) => {
    const result = runTackSync([...(args.includes("--json") ? [] : ["--json"]), ...args], {
      cwd: root,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    return { envelope: decodeEnvelope(result.stdout), exitCode: result.exitCode };
  };
  return { root, run };
};

it("reports the running version before init, with no state, home or network", () => {
  const { root, run } = fixture();
  const stateDirectory = join(root, "state");
  const results = [
    ["--version"],
    ["--json", "--version"],
    ["--version", "--json"],
    ["--state-dir", stateDirectory, "--version"],
    ["--state-dir=" + stateDirectory, "--version"],
  ].map((args) => {
    const { envelope, exitCode } = run(args);
    expect(exitCode, args.join(" ")).toBe(0);
    expect(envelope, args.join(" ")).toMatchObject({
      command: "version",
      status: "success",
      classification: "success",
      diagnostics: [],
      plan: null,
      applied: null,
      version: 1,
    });
    return decodeReport(envelope.result);
  });

  expect(results[0]).toEqual({
    kind: "version",
    version: tackVersion,
    commit: null,
    stamp: `${tackVersion}+dev`,
    sourceRun: true,
    stateFormat: 1,
  });
  for (const report of results) expect(report).toEqual(results[0]);
  expect(existsSync(stateDirectory)).toBe(false);
});

it("rejects --version next to another command with the normal invalid invocation envelope", () => {
  const { root, run } = fixture();
  const stateDirectory = join(root, "state");
  for (const args of [
    ["status", "--version"],
    ["--version", "status"],
    ["--version", "--version"],
    ["version", "--version"],
    ["docs", "search", "owner", "--version"],
  ]) {
    const { envelope, exitCode } = run(["--state-dir", stateDirectory, ...args]);
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
  const rootHelp = decodeHelp(run(["--help"]).envelope.result);
  expect(rootHelp.commandPath).toEqual([]);
  expect(rootHelp.flags.map(({ name }) => name)).toContain("version");
  expect(rootHelp.subcommands.map(({ name }) => name)).not.toContain("version");
  expect(rootHelp.subcommands.map(({ name }) => name)).not.toContain("help");
  expect(decodeHelp(run(["--version", "--help"]).envelope.result).commandPath).toEqual([]);

  for (const word of ["version", "help"]) {
    const { envelope, exitCode } = run([word]);
    expect(exitCode, word).toBe(2);
    expect(envelope.diagnostics[0]?.code, word).toBe("invalid-command");
  }

  const contracts = await readContracts();
  expect(contracts.commands.map(({ command }) => command)).not.toContain("version");
  expect(contracts.commands.map(({ command }) => command)).not.toContain("help");
  expect(contracts.payloads["version"]).toBeUndefined();
  expect(contracts.payloads["help"]).toBeUndefined();
});

it("leaves the envelope version and the other format versions unchanged", () => {
  const { run } = fixture();
  expect(run(["--version"]).envelope.version).toBe(1);
});

it("turns a release build's injected constant into the release stamp", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tack-version-build-test-")));
  roots.push(root);
  const entry = join(root, "entry.ts");
  writeFileSync(
    entry,
    `import { currentVersionReport } from ${JSON.stringify(versionModule)};\nconsole.log(JSON.stringify(currentVersionReport()));\n`,
  );
  const build = (info: string, outfile: string) =>
    spawnSync(
      process.execPath,
      [
        "build",
        entry,
        "--target",
        "bun",
        "--outfile",
        join(root, outfile),
        "--define",
        `__TACK_BUILD_INFO__=${info}`,
      ],
      { cwd: root, encoding: "utf8" },
    );
  const run = (outfile: string) =>
    spawnSync(process.execPath, [join(root, outfile)], { cwd: root, encoding: "utf8" });

  expect(build('{"commit":"fec4c8e","ahead":2}', "ahead.js").status).toBe(0);
  expect(decodeReport(JSON.parse(run("ahead.js").stdout))).toEqual({
    kind: "version",
    version: tackVersion,
    commit: "fec4c8e",
    stamp: `${tackVersion}+gfec4c8e.ahead.2`,
    sourceRun: false,
    stateFormat: 1,
  });

  expect(build('{"commit":"fec4c8e","ahead":0}', "synced.js").status).toBe(0);
  expect(decodeReport(JSON.parse(run("synced.js").stdout))).toMatchObject({
    stamp: `${tackVersion}+gfec4c8e`,
    sourceRun: false,
  });

  expect(readFileSync(join(root, "synced.js"), "utf8")).not.toContain("__TACK_BUILD_INFO__");
});
