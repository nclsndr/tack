import { encodeStateFixture } from "./support/state-fixture.ts";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
  rm,
  access,
  rename,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { watchFile, unwatchFile } from "node:fs";
import { Effect, Schema } from "effect";
import { decodeState } from "../src/domain/state/state-codec.ts";
import { StateSchema } from "../src/domain/state/state-schema.ts";
import type { PublicEnvelope } from "../src/cli/envelope/public-outcome.ts";
import {
  HistoryListPayloadSchema,
  HistoryRecordSchema,
  RunResultSchema,
} from "../src/domain/execution/execution-schema.ts";
import {
  builtEntrypoint,
  decodeEnvelope,
  runTack,
  tackEnvironment,
} from "./support/tack-process.ts";

const decodeRun = Schema.decodeUnknownSync(RunResultSchema);
/** `--timeout` argument for tests that need the deadline to fire only after the script is running. */
const runTimeoutMs = "4000";
const decodeHistory = Schema.decodeUnknownSync(HistoryListPayloadSchema);
const decodeRecord = Schema.decodeUnknownSync(HistoryRecordSchema);
/** A script on the script API; `body` is its async run function's body, with `context` in scope. */
const definition = (body: string, declarations = "") =>
  `import { defineScript } from "@tackup/cli"; export default defineScript({ ${declarations} run: async (context) => { ${body} } });`;
/** Script code that waits until the run is cancelled, then rethrows the abort. */
const untilCancelled =
  "await new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason)));";

type Fixture = {
  root: string;
  home: string;
  state: string;
  source: string;
  run: (
    args: string[],
    input?: string,
  ) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
    envelope: PublicEnvelope;
  }>;
};
const fixture = async (use: (f: Fixture) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tack-cli-execution-")));
  const home = join(root, "home");
  const state = join(root, "state");
  const source = join(root, "source");
  try {
    await Promise.all([
      mkdir(home),
      mkdir(state),
      mkdir(join(source, "scripts"), { recursive: true }),
    ]);
    await writeFile(
      join(source, "tack.yaml"),
      "version: 1\nname: source\nscripts:\n  - name: run\n    path: scripts/run.ts\n    description: Run fixture\n",
    );
    await writeFile(join(source, "package.json"), "{}");
    await writeFile(join(source, "scripts/run.ts"), definition('return "done";'));
    await writeFile(
      join(state, "state.json"),
      encodeStateFixture({
        version: 1,
        data: { sources: [{ id: crypto.randomUUID(), canonicalPath: source }] },
      }),
    );
    const run: Fixture["run"] = async (args, input) => {
      const {
        exitCode: code,
        stdout,
        stderr,
      } = await runTack(["--json", ...args], {
        cwd: root,
        entrypoint: builtEntrypoint,
        home,
        state,
        ...(input === undefined ? {} : { stdin: input }),
      });
      expect(stdout.trim().split("\n")).toHaveLength(1);
      return { code, stdout, stderr, envelope: decodeEnvelope(stdout) };
    };
    await use({ root, home, state, source, run });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const listRuns = async (f: Fixture) =>
  decodeHistory((await f.run(["script", "history"])).envelope.result).runs;
const latestRecord = async (f: Fixture) =>
  decodeRecord(
    (await f.run(["script", "history", "show", (await listRuns(f))[0]?.runId ?? ""])).envelope
      .result,
  );

describe("operator CLI execution", () => {
  it("lists metadata without imports and durably records resolution and input failures", () =>
    fixture(async (f) => {
      const marker = join(f.root, "imported");
      await writeFile(
        join(f.source, "scripts/run.ts"),
        `await Bun.write(${JSON.stringify(marker)},"imported"); throw new Error("import");`,
      );
      const listed = await f.run(["catalog", "--kind", "script"]);
      expect(listed.code).toBe(0);
      expect(listed.envelope.result).toMatchObject({
        complete: true,
        resources: [{ kind: "script", address: { kind: "script", name: "run" } }],
        scope: "script",
      });
      await expect(access(marker)).rejects.toThrow();
      const conflict = await f.run([
        "script",
        "run",
        "run",
        "--user",
        "--input-json",
        "{}",
        "--input-stdin",
      ]);
      expect(conflict.code).toBe(2);
      expect(decodeRun(conflict.envelope.result).outcome.code).toBe("input_sources_conflict");
      await expect(access(marker)).rejects.toThrow();
      const missing = await f.run(["script", "run", "unlisted", "--user"]);
      expect(missing.code).toBe(2);
      expect(missing.envelope).toMatchObject({
        diagnostics: [{ code: "resource-not-found" }],
        result: null,
      });
      const records = await listRuns(f);
      expect(records).toHaveLength(1);
      expect((await f.run(["script", "history"])).envelope.result).toMatchObject({
        kind: "run-history",
        total: 1,
      });
      expect(records.every((r) => r.status === "complete")).toBe(true);
      expect(
        decodeRecord(
          (await f.run(["script", "history", "show", records[0]!.runId])).envelope.result,
        ),
      ).toMatchObject({ runId: records[0]!.runId, status: "complete" });
      const preview = await f.run(["script", "history", "clear"]);
      expect(preview.envelope).toMatchObject({ plan: { count: 1 }, applied: null });
      expect(await listRuns(f)).toHaveLength(1);
      expect((await f.run(["script", "history", "clear", "--apply"])).envelope).toMatchObject({
        plan: { count: 1 },
        applied: { removedCount: 1 },
      });
      expect(await listRuns(f)).toEqual([]);
    }));
  it("lists a corrupt history partially, keeps history lookups distinct, and clears unread", () =>
    fixture(async (f) => {
      await f.run(["script", "run", "run", "--user", "--input-json", "{}", "--input-stdin"]);
      const [valid] = await listRuns(f);
      const corrupt = join(f.state, "history", `${crypto.randomUUID()}.json`);
      await writeFile(corrupt, '{"version":1,');
      const partial = await f.run(["script", "history"]);
      expect(partial.code).toBe(1);
      expect(partial.envelope).toMatchObject({
        classification: "partial",
        diagnostics: [{ code: "history-partial", details: { skipped: 1 }, severity: "warning" }],
        result: {
          runs: [{ runId: valid!.runId, status: "complete" }],
          total: 1,
          offset: 0,
          limit: 20,
          truncated: false,
          issues: [{ path: corrupt, reason: "invalid" }],
        },
      });
      const paged = await f.run(["script", "history", "--limit", "1", "--offset", "1"]);
      expect(paged.envelope.result).toMatchObject({ runs: [], total: 1, offset: 1, limit: 1 });
      const tooMany = await f.run(["script", "history", "--limit", "101"]);
      expect(tooMany.code).toBe(2);
      expect(tooMany.envelope.classification).toBe("invalid-invocation");
      const unknown = crypto.randomUUID();
      const missing = await f.run(["script", "history", "show", unknown]);
      expect(missing.code).toBe(1);
      expect(missing.envelope).toMatchObject({
        classification: "domain",
        diagnostics: [{ code: "history-not-found", details: { runId: unknown } }],
      });
      const damaged = await f.run([
        "script",
        "history",
        "show",
        corrupt.slice(join(f.state, "history").length + 1, -".json".length),
      ]);
      expect(damaged.envelope).toMatchObject({
        classification: "persistence",
        diagnostics: [{ code: "history_read_failed" }],
      });
      expect(damaged.stdout).not.toContain('{\\"version\\":1,');
      const malformed = await f.run(["script", "history", "show", "../state"]);
      expect(malformed.code).toBe(2);
      expect(malformed.envelope.classification).toBe("invalid-invocation");
      expect((await f.run(["script", "history", "clear", "--apply"])).envelope).toMatchObject({
        classification: "success",
        plan: { count: 2 },
        applied: { removedCount: 2 },
      });
      await expect(access(corrupt)).rejects.toThrow();
      expect((await f.run(["script", "history"])).envelope).toMatchObject({
        classification: "success",
        result: { runs: [], total: 0, issues: [] },
      });
      const typo = join(f.root, "typo");
      for (const args of [
        ["script", "history"],
        ["script", "history", "show", unknown],
        ["script", "history", "clear"],
      ]) {
        const refused = await f.run(["--state-dir", typo, ...args]);
        expect(refused.envelope).toMatchObject({
          classification: "invalid-configuration",
          diagnostics: [
            {
              message: `Tack state is absent at ${join(typo, "state.json")}. Run \`tack --state-dir ${typo} state init\` to initialize this exact directory.`,
            },
          ],
        });
      }
      await expect(access(typo)).rejects.toThrow();
    }));
  it(
    "returns one safe success envelope and keeps quiet logs in history",
    () =>
      fixture(async (f) => {
        await writeFile(
          join(f.source, "scripts/run.ts"),
          definition(
            'console.log("captured stdout"); console.error("captured stderr"); context.log("captured effect"); return "done";',
          ),
        );
        const result = await f.run(["script", "run", "run", "--user", "--quiet"]);
        expect(result.code, result.stdout).toBe(0);
        expect(result.stderr).toBe("");
        const run = decodeRun(result.envelope.result);
        expect(run).toMatchObject({ outcome: { code: "success" }, finalization: "complete" });
        expect(run.logs.map((l) => l.content).join("\n")).toContain("captured stdout");
        const retained = JSON.parse(
          await readFile(join(f.state, "history", `${run.runId}.json`), "utf8"),
        );
        expect(retained.result).toEqual(run);
      }),
    20000,
  );
});

const fileReady = (path: string) => {
  let close = () => {};
  const ready = new Promise<void>((resolveReady, reject) => {
    const observed = () => {
      void access(path).then(
        () => resolveReady(),
        () => undefined,
      );
    };
    watchFile(path, { interval: 10 }, observed);
    const deadline = setTimeout(
      () => reject(new Error(`Readiness file was not created: ${path}`)),
      8000,
    );
    close = () => {
      clearTimeout(deadline);
      unwatchFile(path, observed);
    };
    observed();
  });
  return { ready, close };
};

it.each([false, true])(
  "settles built CLI signal cancellation with forced=%s and terminal history",
  async (forced) =>
    fixture(async (f) => {
      const readyPath = join(f.root, "ready");
      const cleanupPath = join(f.root, "cleanup");
      const finishedPath = join(f.root, "finished");
      const ready = fileReady(readyPath);
      let cleaning: ReturnType<typeof fileReady> | undefined;
      await writeFile(
        join(f.source, "scripts/run.ts"),
        definition(
          `try { await Bun.write(${JSON.stringify(readyPath)}, String(process.pid)); ${untilCancelled} } finally { await Bun.write(${JSON.stringify(cleanupPath)}, "cleanup"); ${forced ? "await new Promise(() => {});" : `await Bun.write(${JSON.stringify(finishedPath)}, "finished");`} }`,
        ),
      );
      const child = Bun.spawn(
        [process.execPath, builtEntrypoint, "--json", "script", "run", "run", "--user", "--quiet"],
        {
          cwd: f.root,
          env: tackEnvironment({ home: f.home, state: f.state }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      try {
        await Promise.race([
          ready.ready,
          child.exited.then(async (code) => {
            throw new Error(
              `CLI exited before readiness (${code}): ${await stdout} ${await stderr}`,
            );
          }),
        ]);
        cleaning = fileReady(cleanupPath);
        child.kill("SIGINT");
        await Promise.race([
          cleaning.ready,
          child.exited.then(async (code) => {
            await access(cleanupPath).catch(async () => {
              throw new Error(
                `CLI exited before cleanup (${code}): ${await stdout} ${await stderr}`,
              );
            });
          }),
        ]);
        if (forced === true) child.kill("SIGTERM");
        const [code, output, errors] = await Promise.all([child.exited, stdout, stderr]);
        expect(code).toBe(130);
        expect(errors).toBe("");
        expect(output.trim().split("\n")).toHaveLength(1);
        const result = decodeRun(decodeEnvelope(output).result);
        expect(result).toMatchObject({
          outcome: { classification: "interruption" },
          termination: { reason: "user-interruption", forced },
          finalization: forced === true ? "incomplete" : "complete",
        });
        expect(await listRuns(f)).toHaveLength(1);
        expect(await latestRecord(f)).toMatchObject({ status: "complete", result });
        const workerPid = Number(await readFile(readyPath, "utf8"));
        expect(() => process.kill(workerPid, 0)).toThrow();
        if (forced === false) expect(await readFile(finishedPath, "utf8")).toBe("finished");
      } finally {
        ready.close();
        cleaning?.close();
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    }),
  20000,
);

it(
  "settles built CLI timeout only after finalization and history",
  () =>
    fixture(async (f) => {
      const finished = join(f.root, "finished");
      await writeFile(
        join(f.source, "scripts/run.ts"),
        definition(
          `try { ${untilCancelled} } finally { await Bun.write(${JSON.stringify(finished)}, "finished"); }`,
        ),
      );
      const completed = await f.run([
        "script",
        "run",
        "run",
        "--user",
        "--quiet",
        "--timeout",
        // The built CLI takes no injected clock, so the wall-clock deadline (armed at worker spawn)
        // must outlast worker startup for finalization to be observed. Spawn-to-running measured
        // 54ms idle and 245ms at 5x CPU oversubscription; 4s keeps a >15x margin.
        runTimeoutMs,
      ]);
      expect(completed.code, completed.stdout + completed.stderr).toBe(1);
      const result = decodeRun(completed.envelope.result);
      expect(result).toMatchObject({
        outcome: { code: "timeout" },
        termination: { reason: "timeout", forced: false },
        finalization: "complete",
      });
      expect(await readFile(finished, "utf8")).toBe("finished");
      expect(await latestRecord(f)).toMatchObject({
        status: "complete",
        result,
      });
    }),
  20000,
);

it(
  "narrows run targets without affecting broad maintenance selectors",
  () =>
    fixture(async (f) => {
      const anchor = join(f.root, "git");
      const first = join(f.root, "first");
      const second = join(f.root, "second");
      const nested = join(first, "nested");
      await Promise.all([mkdir(anchor), mkdir(second), mkdir(nested, { recursive: true })]);
      const statePath = join(f.state, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.data.projects = [
        { name: "demo", gitCommonDirectory: anchor, roots: [first, second], removingRoots: [] },
      ];
      await writeFile(statePath, JSON.stringify(state));
      await writeFile(join(f.source, "scripts/run.ts"), definition("return process.cwd();"));
      const broad = await f.run(["script", "run", "run", "--project", "demo"]);
      expect(broad.code).toBe(2);
      expect(decodeRun(broad.envelope.result).outcome).toMatchObject({
        code: "run_target_not_unique",
        details: { projectName: "demo", roots: [first, second] },
      });
      expect(broad.envelope.diagnostics[0]).toMatchObject({
        code: "run_target_not_unique",
        details: { outcome: { roots: [first, second] } },
      });
      expect(broad.envelope.diagnostics[0]?.message).toContain("--root <path>");
      const ghost = await f.run(["script", "run", "run", "--project", "ghost"]);
      expect(ghost.code).toBe(2);
      expect(ghost.envelope).toMatchObject({
        diagnostics: [
          { code: "run_project_not_registered", details: { outcome: { projectName: "ghost" } } },
        ],
        result: null,
      });
      const outside = await f.run(["script", "run", "run"]);
      expect(outside.code).toBe(2);
      expect(decodeRun(outside.envelope.result).outcome).toMatchObject({
        code: "run_cwd_not_registered",
        details: { cwd: f.root },
      });
      const exact = await f.run(["script", "run", "run", "--root", first]);
      expect(exact.code, exact.stdout).toBe(0);
      expect(decodeRun(exact.envelope.result).core).toMatchObject({
        primary: { encoded: first },
      });
      const containing = await f.run(["script", "run", "run", "--cwd", nested]);
      expect(containing.code, containing.stdout).toBe(0);
      expect(decodeRun(containing.envelope.result).core).toMatchObject({
        primary: { encoded: first },
      });
      const invalid = await f.run(["script", "run", "run", "--root", nested]);
      expect(invalid.code).toBe(2);
      expect(decodeRun(invalid.envelope.result).outcome).toMatchObject({
        code: "run_root_not_registered",
        details: { root: nested, containingRoot: first },
      });
      const conflict = await f.run(["script", "run", "run", "--user", "--root", first]);
      expect(conflict.code).toBe(2);
      expect(decodeRun(conflict.envelope.result).outcome.code).toBe("run_targets_conflict");
    }),
  20000,
);

it("refuses a run against a mistyped state directory without creating it", () =>
  fixture(async (f) => {
    const typo = join(f.root, "stat");
    const refused = await f.run(["--state-dir", typo, "script", "run", "run", "--user"]);
    expect(refused.code).toBe(2);
    expect(refused.envelope).toMatchObject({
      classification: "invalid-configuration",
      diagnostics: [{ code: "state-not-initialized" }],
      result: null,
    });
    expect(refused.envelope.diagnostics[0]?.message).toContain("state init");
    await expect(access(typo)).rejects.toThrow();
  }));

it(
  "runs a bare script in a registered root that is also the home directory",
  () =>
    fixture(async (f) => {
      const anchor = join(f.root, "git");
      await mkdir(anchor);
      const statePath = join(f.state, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.data.projects = [
        { name: "home", gitCommonDirectory: anchor, roots: [f.home], removingRoots: [] },
      ];
      await writeFile(statePath, JSON.stringify(state));
      await writeFile(join(f.source, "scripts/run.ts"), definition("return process.cwd();"));
      const bare = await f.run(["script", "run", "run", "--cwd", f.home]);
      expect(bare.code, bare.stdout).toBe(0);
      expect(decodeRun(bare.envelope.result).core).toMatchObject({
        primary: { encoded: f.home },
      });
    }),
  20000,
);

it(
  "preserves expected failures, thrown messages and initial history failure exit classes",
  () =>
    fixture(async (f) => {
      await writeFile(join(f.source, "scripts/run.ts"), definition('context.fail("expected");'));
      const expected = await f.run(["script", "run", "run", "--user"]);
      expect(expected.code).toBe(1);
      expect(decodeRun(expected.envelope.result).outcome.code).toBe("expected_failure");
      await writeFile(
        join(f.source, "scripts/run.ts"),
        definition('throw new Error("private defect message");'),
      );
      const defect = await f.run(["script", "run", "run", "--user"]);
      expect(defect.code).toBe(3);
      // A script's own thrown message is shown, so its author can fix the script.
      expect(decodeRun(defect.envelope.result).outcome).toMatchObject({
        code: "executed_defect",
        message: "private defect message",
      });
      await rm(join(f.state, "history"), { recursive: true, force: true });
      await writeFile(join(f.state, "history"), "blocked history");
      const blocked = await f.run(["script", "run", "run", "--user"]);
      expect(blocked.code).toBe(3);
      expect(decodeRun(blocked.envelope.result)).toMatchObject({
        outcome: { stage: "history", classification: "persistence" },
        finalization: "not-started",
      });
    }),
  20000,
);

it(
  "retains original inline, file and stdin JSON and rejects unreadable input before imports",
  () =>
    fixture(async (f) => {
      await writeFile(
        join(f.source, "scripts/run.ts"),
        definition('return "accepted";', 'args: { name: { type: "string" } },'),
      );
      const input = { name: "Ada" };
      const json = JSON.stringify(input);
      const file = join(f.root, "input.json");
      await writeFile(file, json);
      for (const [flags, stdin] of [
        [["--input-json", json], undefined],
        [["--input-file", file], undefined],
        [["--input-stdin"], json],
      ] satisfies ReadonlyArray<readonly [string[], string | undefined]>) {
        const result = await f.run(["script", "run", "run", "--user", ...flags], stdin);
        expect(result.code, result.stdout).toBe(0);
        const run = decodeRun(result.envelope.result);
        const stored = JSON.parse(
          await readFile(join(f.state, "history", `${run.runId}.json`), "utf8"),
        );
        expect(stored.originalInput).toEqual(input);
      }
      const missing = await f.run([
        "script",
        "run",
        "run",
        "--user",
        "--input-file",
        join(f.root, "missing"),
      ]);
      expect(missing.code).toBe(2);
      expect(decodeRun(missing.envelope.result).outcome.code).toBe("input_file_read_failed");
      const malformed = await f.run(["script", "run", "run", "--user", "--input-json", "{"]);
      expect(malformed.code).toBe(2);
      expect(decodeRun(malformed.envelope.result).outcome.code).toBe("input_json_invalid");
    }),
  20000,
);

it(
  "interrupts an open stdin attempt and completes history without loading code",
  () =>
    fixture(async (f) => {
      const marker = join(f.root, "imported");
      await writeFile(
        join(f.source, "scripts/run.ts"),
        `await Bun.write(${JSON.stringify(marker)},"imported");`,
      );
      const pending = fileReady(join(f.state, "history"));
      const child = Bun.spawn(
        [
          process.execPath,
          builtEntrypoint,
          "--json",
          "script",
          "run",
          "run",
          "--user",
          "--input-stdin",
          "--quiet",
        ],
        {
          cwd: f.root,
          env: tackEnvironment({ home: f.home, state: f.state }),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      try {
        await Promise.race([
          pending.ready,
          child.exited.then(async (code) => {
            throw new Error(
              `CLI exited before stdin cancellation (${code}): ${await stdout} ${await stderr}`,
            );
          }),
        ]);
        child.kill("SIGINT");
        const [code, output, errors] = await Promise.all([child.exited, stdout, stderr]);
        expect(code).toBe(130);
        expect(errors).toBe("");
        expect(output.trim().split("\n")).toHaveLength(1);
        const result = decodeRun(decodeEnvelope(output).result);
        expect(result).toMatchObject({
          outcome: { classification: "interruption" },
          finalization: "not-started",
        });
        expect(await latestRecord(f)).toMatchObject({
          status: "complete",
          result,
        });
        await expect(access(marker)).rejects.toThrow();
      } finally {
        pending.close();
        await child.stdin.end();
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    }),
  20000,
);

it("records invalid timeout attempts before executable loading", () =>
  fixture(async (f) => {
    const marker = join(f.root, "imported");
    await writeFile(
      join(f.source, "scripts/run.ts"),
      `await Bun.write(${JSON.stringify(marker)},"imported");`,
    );
    for (const raw of ["0", "-1", "1.5", "garbage"]) {
      const result = await f.run(["script", "run", "run", "--user", "--timeout", raw]);
      expect(result.code).toBe(2);
      expect(decodeRun(result.envelope.result)).toMatchObject({
        outcome: { stage: "invocation", code: "timeout_invalid" },
        finalization: "not-started",
      });
    }
    expect(await listRuns(f)).toHaveLength(4);
    await expect(access(marker)).rejects.toThrow();
  }));

it("keeps cleanup failure above timeout in the built public outcome and process status", () =>
  fixture(async (f) => {
    await writeFile(
      join(f.source, "scripts/run.ts"),
      definition(`try { ${untilCancelled} } finally { throw new Error("cleanup canary"); }`),
    );
    const execution = await f.run([
      "script",
      "run",
      "run",
      "--user",
      "--quiet",
      // The deadline must fire after the finalizer is registered; see runTimeoutMs.
      "--timeout",
      runTimeoutMs,
    ]);
    expect(execution.code, execution.stdout + execution.stderr).toBe(1);
    expect(decodeRun(execution.envelope.result)).toMatchObject({
      outcome: { code: "cleanup_failed", classification: "domain" },
      termination: { reason: "timeout", forced: false },
      core: { primary: { code: "interrupted" }, finalization: { status: "failed" } },
    });
  }));

it.each([false, true])(
  "owns process-group SIGINT and preserves cleanup priority with failed=%s",
  async (failed) =>
    fixture(async (f) => {
      const readyPath = join(f.root, "ready");
      const finalizedPath = join(f.root, "finalized");
      const ready = fileReady(readyPath);
      await writeFile(
        join(f.source, "scripts/run.ts"),
        definition(
          `try { await Bun.write(${JSON.stringify(readyPath)}, String(process.pid)); ${untilCancelled} } finally { await Bun.write(${JSON.stringify(finalizedPath)}, "finalized"); ${failed === true ? 'throw new Error("cleanup canary");' : ""} }`,
        ),
      );
      const child = spawn(
        process.execPath,
        [builtEntrypoint, "--json", "script", "run", "run", "--user", "--quiet"],
        {
          cwd: f.root,
          env: tackEnvironment({ home: f.home, state: f.state }),
          detached: true,
          stdio: "pipe",
        },
      );
      const exited = new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", resolveExit);
      });
      const capture = (stream: typeof child.stdout) =>
        new Promise<string>((resolveText, reject) => {
          let text = "";
          stream.on("data", (chunk: Buffer | string) => {
            text += chunk.toString();
          });
          stream.once("error", reject);
          stream.once("end", () => resolveText(text));
        });
      const stdout = capture(child.stdout);
      const stderr = capture(child.stderr);
      try {
        await Promise.race([
          ready.ready,
          exited.then(async (code) => {
            throw new Error(
              `CLI exited before group signal ${code}: ${await stdout} ${await stderr}`,
            );
          }),
        ]);
        if (child.pid === undefined) throw new Error("CLI PID unavailable.");
        process.kill(-child.pid, "SIGINT");
        const [code, output, errors] = await Promise.all([exited, stdout, stderr]);
        expect(code, output + errors).toBe(failed === true ? 1 : 130);
        expect(errors).toBe("");
        const result = decodeRun(decodeEnvelope(output).result);
        expect(result).toMatchObject({
          outcome: { code: failed === true ? "cleanup_failed" : "interrupted" },
          termination: { reason: "user-interruption", forced: false },
          finalization: "complete",
        });
        expect(await readFile(finalizedPath, "utf8")).toBe("finalized");
        const workerPid = Number(await readFile(readyPath, "utf8"));
        expect(() => process.kill(workerPid, 0)).toThrow();
        expect(await latestRecord(f)).toMatchObject({
          status: "complete",
          result,
        });
      } finally {
        ready.close();
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
        await exited;
      }
    }),
);

it("round-trips normalized ownership across CLI restarts, roots, adapters, docs, and source relocation", () =>
  fixture(async (f) => {
    const roots = [join(f.root, "first"), join(f.root, "second")];
    await Promise.all(roots.map((root) => mkdir(root)));
    await mkdir(join(f.source, "skills", "review"), { recursive: true });
    await mkdir(join(f.source, "knowledge"));
    await writeFile(
      join(f.source, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review fixture\n---\n",
    );
    await writeFile(join(f.source, "knowledge", "guide.md"), "# Owned docs\n");
    await writeFile(
      join(f.source, "tack.yaml"),
      "version: 1\nname: source\nskills:\n  - path: skills\nscripts:\n  - name: run\n    path: scripts/run.ts\n    description: Run fixture\ndocs:\n  - name: handbook\n    path: knowledge\n",
    );
    const statePath = join(f.state, "state.json");
    const initial = await Effect.runPromise(
      decodeState(JSON.parse(await readFile(statePath, "utf8"))),
    );
    const source = initial.data.sources?.[0];
    if (source === undefined) throw new Error("Expected registered fixture source");
    const resource = {
      sourceRegistrationId: source.id,

      name: "handbook",
    };
    await writeFile(
      statePath,
      encodeStateFixture({
        ...initial,
        data: {
          ...initial.data,
          enabledAdapters: ["codex", "cursor"],
          projects: [{ name: "demo", gitCommonDirectory: join(f.root, "git"), roots }],
          choices: [
            {
              namespace: { _tag: "project", projectName: "demo" },
              address: { kind: "skill", name: "review", sourceRegistrationId: source.id },
              decision: "include",
            },
          ],
          docsProjects: [
            { projectName: "demo", attachments: [resource], defaultWritingResource: resource },
          ],
        },
      }),
    );
    expect((await f.run(["sync", "--project", "demo", "--apply"])).code).toBe(0);
    expect((await f.run(["sync", "--no-adapters", "--project", "demo", "--apply"])).code).toBe(0);
    const readDisk = async () =>
      Schema.decodeUnknownSync(StateSchema, { onExcessProperty: "error" })(
        JSON.parse(await readFile(statePath, "utf8")),
      );
    const installed = await readDisk();
    const agentLinks = (links: typeof installed.data.links) =>
      links.filter((link) => link.delivery._tag === "agent");
    const docsLinks = (links: typeof installed.data.links) =>
      links.filter((link) => link.delivery._tag === "docs");
    // One ledger holds the four agent links and the two docs mounts.
    expect(installed.data.links).toHaveLength(6);
    expect(agentLinks(installed.data.links)).toHaveLength(4);
    expect(agentLinks(installed.data.links)).toMatchObject(
      roots.flatMap((root) =>
        ["codex", "cursor"].map((adapter) => ({
          delivery: { _tag: "agent", adapter },
          target: { _tag: "project-root", projectName: "demo", canonicalPath: root },
          resource: { kind: "skill", name: "review", sourceRegistrationId: source.id },
          sourceDirectoryPath: join(f.source, "skills", "review"),
        })),
      ),
    );
    for (const root of roots) {
      for (const directory of [".agents", ".cursor"]) {
        expect(await realpath(join(root, directory, "skills", "review"))).toBe(
          join(f.source, "skills", "review"),
        );
      }
      expect(await realpath(join(root, ".tack", "docs", source.id, "handbook"))).toBe(
        join(f.source, "knowledge"),
      );
    }
    expect(installed.data.links.every((link) => link.removal === undefined)).toBe(true);
    expect(installed.data.projects?.[0]).toMatchObject({
      choices: [{ address: { kind: "skill", name: "review" }, decision: "include" }],
      docs: { attachments: [{ ...resource, writingDefault: true }] },
    });
    expect(docsLinks(installed.data.links)).toHaveLength(2);
    expect(JSON.stringify(installed)).not.toContain('"docsManagedLinks"');
    expect(JSON.stringify(installed)).not.toContain('"relativeTarget"');
    expect(JSON.stringify(installed)).not.toContain('"managedLinks"');
    const moved = join(f.root, "moved-source");
    await rename(f.source, moved);
    expect((await f.run(["source", "relocate", source.id, moved])).code).toBe(0);
    const relocated = await readDisk();
    expect(relocated.data.sources?.[0]?.canonicalPath).toBe(moved);
    expect(agentLinks(relocated.data.links)[0]?.sourceDirectoryPath).toBe(
      join(f.source, "skills", "review"),
    );
    // Links to the historical source path now dangle with exactly the text Tack wrote, which
    // proves ownership, so cleanup removes them without restoring that target.
    expect((await f.run(["state", "clean", "--project", "demo", "--apply"])).code).toBe(0);
    for (const root of roots) {
      for (const directory of [".agents", ".cursor"]) {
        await expect(lstat(join(root, directory, "skills", "review"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }
    expect(
      (await f.run(["docs", "detach", `${source.id}:handbook`, "--project", "demo"])).code,
    ).toBe(0);
    expect((await f.run(["sync", "--no-adapters", "--project", "demo", "--apply"])).code).toBe(0);
    for (const root of roots) {
      await expect(lstat(join(root, ".tack", "docs", source.id, "handbook"))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    }
    const cleaned = await readDisk();
    expect(cleaned.data.links).toEqual([]);
    expect(await readFile(join(moved, "knowledge", "guide.md"), "utf8")).toBe("# Owned docs\n");
  }));
