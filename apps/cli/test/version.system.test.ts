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
import { tackVersion, VersionReportSchema } from "../src/version.ts";
import { decodeEnvelope, runTackSync } from "./support/tack-process.ts";

const roots: Array<string> = [];
const versionModule = resolve(import.meta.dirname, "../src/version.ts");
const strict = { onExcessProperty: "error" } as const;
const decodeReport = Schema.decodeUnknownSync(VersionReportSchema, strict);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Runs the CLI with no initialized state, no HOME and no TACK_STATE_DIR. The first case is the
 * process-level smoke test of `--version`; the envelope-only cases are in `version.host.test.ts`.
 */
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
