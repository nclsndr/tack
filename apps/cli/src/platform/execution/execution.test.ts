import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  createPendingHistory,
  finishHistory,
  listHistory,
  readHistory,
  clearHistory,
  countHistory,
} from "./history.ts";
import { historyDirectory } from "../../domain/execution/history-location.ts";
import { readRunInput } from "./input.ts";
import {
  prepareSecretLookup,
  minimalWorkerEnvironment,
  redactDiagnostic,
  redactOwnedJson,
} from "./secrets.ts";
import { encodeFrame, FrameDecoder, maximumFrameBytes } from "./protocol.ts";
import { superviseWorker } from "./supervisor.ts";
import { makeLiveShell } from "./shell.ts";
import { makeRunLogs } from "./logs.ts";
import type { HistoryRecord, OperatorRunRequest } from "../../domain/execution/execution-schema.ts";

const request: OperatorRunRequest = {
  address: {
    kind: "script",
    name: "test",
    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  },
  selector: { _tag: "user" },
};
/** Supervised runs require a caller-owned cancellation signal; these tests never abort it. */
const unused = new AbortController().signal;
const fixture = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "tack-execution-"));
  try {
    await run(await realpath(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
/** A script on the script API; `body` is its async run function's body, with `context` in scope. */
const definition = (body: string, declarations = "") =>
  `import { defineScript } from "@tackup/cli"; export default defineScript({ ${declarations} run: async (context) => { ${body} } });`;

/** Script statement that creates the readiness file once the script body is executing. */
const markReady = (path: string) =>
  `(await import("node:fs")).writeFileSync(${JSON.stringify(path)}, "ready");`;
/** Script statement that waits until the run is cancelled, then rethrows the abort. */
const untilCancelled =
  "await new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason)));";
/**
 * Supervises a worker whose run deadline expires only after the script reports readiness.
 * The default deadline is a wall-clock timer armed at spawn, so a slow worker start (a loaded host)
 * could expire it before the script runs; this latch makes the timeout deterministic instead.
 */
const superviseUntilReadyThenExpire = async (
  options: Omit<Parameters<typeof superviseWorker>[0], "timeoutMs" | "scheduleDeadline">,
  readyPath: string,
) => {
  let expire: (() => void) | undefined;
  const pending = superviseWorker({
    ...options,
    timeoutMs: 1000,
    scheduleDeadline: (fire) => {
      expire = fire;
      return () => {
        expire = undefined;
      };
    },
  });
  const run = { settled: false, ready: false };
  void pending.finally(() => {
    run.settled = true;
  });
  while (run.settled === false && run.ready === false) {
    try {
      await access(readyPath);
      run.ready = true;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
  }
  if (run.ready === false)
    throw new Error("The worker settled before the script reported readiness.");
  if (expire === undefined) throw new Error("The run deadline was never armed.");
  expire();
  return pending;
};

describe("operator private framing", () => {
  it("preserves arbitrary chunk boundaries and rejects invalid, oversized, and partial frames", () => {
    const frame = { version: 1, runId: "id", kind: "cancel", payload: {} } as const;
    const bytes = encodeFrame(frame);
    const decoder = new FrameDecoder();
    expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
    expect(decoder.push(bytes.subarray(2))).toEqual([frame]);
    decoder.end();
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(maximumFrameBytes + 1);
    expect(() => new FrameDecoder().push(oversized)).toThrow();
    const partial = new FrameDecoder();
    partial.push(bytes.subarray(0, 5));
    expect(() => partial.end()).toThrow();
    const invalid = Buffer.from('{"version":99}');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(invalid.length);
    expect(() => new FrameDecoder().push(Buffer.concat([head, invalid]))).toThrow();
  });
});

describe("run input and secrets", () => {
  it("defaults input, rejects conflicts and limits before parsing, and distinguishes reads", () =>
    fixture(async (directory) => {
      expect(await readRunInput(request)).toEqual({});
      await expect(
        readRunInput({ ...request, inputJson: "{}", inputStdin: true }),
      ).rejects.toMatchObject({ outcome: { code: "input_sources_conflict" } });
      expect(await readRunInput({ ...request, words: ["--name", "Ada"] })).toEqual({});
      await expect(
        readRunInput({ ...request, inputJson: "{}", words: ["--name", "Ada"] }),
      ).rejects.toMatchObject({
        outcome: {
          code: "input_sources_conflict",
          message: "Choose one of inline JSON, a JSON file, standard input, or arguments after --.",
        },
      });
      await expect(
        readRunInput({ ...request, inputFile: join(directory, "missing") }),
      ).rejects.toMatchObject({ outcome: { code: "input_file_read_failed" } });
      await expect(
        readRunInput({ ...request, inputJson: "x".repeat(1048577) }),
      ).rejects.toMatchObject({ outcome: { code: "input_too_large" } });
      await expect(readRunInput({ ...request, inputJson: "{" })).rejects.toMatchObject({
        outcome: { code: "input_json_invalid" },
      });
      const file = join(directory, "input.json");
      await writeFile(file, '{"name":"Ada"}');
      expect(await readRunInput({ ...request, inputFile: file })).toEqual({ name: "Ada" });
      async function* stdin() {
        yield Buffer.from("[1]");
      }
      expect(await readRunInput({ ...request, inputStdin: true }, stdin())).toEqual([1]);
    }));
  it("uses process over dotenv, rejects empty primary values and omits secrets from ambient environment", () =>
    fixture(async (directory) => {
      await writeFile(join(directory, ".env"), "TACK_TOKEN=dotenv\nTACK_ONLY=local\n");
      const lookup = await prepareSecretLookup(directory, {
        PATH: "/bin",
        TACK_TOKEN: "process",
        TACK_UNDECLARED: "hidden",
      });
      expect(await lookup.lookup(["TOKEN", "ONLY"])).toEqual({ TOKEN: "process", ONLY: "local" });
      const empty = await prepareSecretLookup(directory, { TACK_TOKEN: "" });
      await expect(empty.lookup(["TOKEN"])).rejects.toMatchObject({
        code: "secret_missing",
        names: ["TOKEN"],
      });
      expect(
        minimalWorkerEnvironment({
          PATH: "/bin",
          TACK_TOKEN: "secret",
          AWS_KEY: "secret",
          NODE_OPTIONS: "--require unsafe",
        }),
      ).toEqual({ PATH: "/bin" });
    }));
});

describe("durable run history", () => {
  it("retains pending evidence, atomically finishes, validates records and clears explicitly", () =>
    fixture(async (directory) => {
      const record: HistoryRecord = {
        version: 1,
        runId: crypto.randomUUID(),
        status: "pending",
        startedAt: new Date().toISOString(),
        address: request.address,
      };
      await createPendingHistory(directory, record);
      expect(await listHistory(directory)).toEqual({
        runs: [
          {
            runId: record.runId,
            status: "pending",
            address: record.address,
            startedAt: record.startedAt,
          },
        ],
        issues: [],
      });
      const complete: HistoryRecord = {
        ...record,
        status: "complete",
        finishedAt: new Date().toISOString(),
        originalInput: {},
        result: {
          runId: record.runId,
          outcome: {
            stage: "output",
            code: "success",
            message: "Done.",
            classification: "success",
          },
          logs: [],
          logTruncation: { truncated: false, observedBytes: 0, observedEvents: 0, reasons: [] },
          finalization: "complete",
        },
      };
      await finishHistory(directory, complete);
      expect(await readHistory(directory, record.runId)).toEqual(complete);
      expect(await listHistory(directory)).toEqual({
        runs: [
          {
            runId: record.runId,
            status: "complete",
            address: record.address,
            startedAt: record.startedAt,
            finishedAt: complete.finishedAt,
            outcome: { code: "success", classification: "success" },
          },
        ],
        issues: [],
      });
      expect(await readHistory(directory, crypto.randomUUID())).toBeUndefined();
      await writeFile(join(directory, "history", `${record.runId}.json`), "{}");
      await expect(readHistory(directory, record.runId)).rejects.toThrow("history read failed");
      expect(await listHistory(directory)).toEqual({
        runs: [],
        issues: [{ path: join(directory, "history", `${record.runId}.json`), reason: "invalid" }],
      });
      expect(await clearHistory(directory)).toBe(1);
      expect(await listHistory(directory)).toEqual({ runs: [], issues: [] });
      await expect(readHistory(directory, "../../state")).rejects.toThrow();
    }));
  it("skips and reports unreadable, invalid, misnamed and mismatched records, then clears them unread", () =>
    fixture(async (directory) => {
      const history = historyDirectory(directory);
      expect(history).toBe(join(directory, "history"));
      expect(await listHistory(directory)).toEqual({ runs: [], issues: [] });
      expect(await countHistory(directory)).toBe(0);
      expect(await clearHistory(directory)).toBe(0);
      const valid: HistoryRecord = {
        version: 1,
        runId: crypto.randomUUID(),
        status: "pending",
        startedAt: "2026-01-01T00:00:00.000Z",
        address: request.address,
      };
      await createPendingHistory(directory, valid);
      const truncated = join(history, `${crypto.randomUUID()}.json`);
      const misnamed = join(history, "not-a-run.json");
      const unreadable = join(history, `${crypto.randomUUID()}.json`);
      const mismatched = join(history, `${crypto.randomUUID()}.json`);
      await writeFile(truncated, '{"version":1,"runId":');
      await writeFile(misnamed, JSON.stringify(valid));
      await mkdir(unreadable);
      await writeFile(mismatched, JSON.stringify(valid));
      await writeFile(join(history, ".pending-leftover"), "temporary");
      const listed = await listHistory(directory);
      expect(listed.runs.map((run) => run.runId)).toEqual([valid.runId]);
      expect(listed.issues).toEqual(
        [
          { path: truncated, reason: "invalid" },
          { path: misnamed, reason: "invalid-name" },
          { path: unreadable, reason: "unreadable" },
          { path: mismatched, reason: "run-id-mismatch" },
        ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
      );
      const mismatchedId = mismatched.slice(history.length + 1, -".json".length);
      await expect(readHistory(directory, mismatchedId)).rejects.toThrow("history read failed");
      await expect(
        readHistory(directory, unreadable.slice(history.length + 1, -5)),
      ).rejects.toThrow("history read failed");
      expect(await countHistory(directory)).toBe(5);
      expect(await clearHistory(directory)).toBe(5);
      expect(await readdir(history)).toEqual([".pending-leftover"]);
      expect(await listHistory(directory)).toEqual({ runs: [], issues: [] });
    }));
  it("fails initial and terminal writes without replacing pending evidence", () =>
    fixture(async (directory) => {
      const blocked = join(directory, "blocked");
      await writeFile(blocked, "file");
      const record: HistoryRecord = {
        version: 1,
        runId: crypto.randomUUID(),
        status: "pending",
        startedAt: "now",
        address: request.address,
      };
      await expect(createPendingHistory(blocked, record)).rejects.toMatchObject({
        operation: "create",
      });
      await createPendingHistory(directory, record);
      await expect(
        finishHistory(directory, { ...record, runId: "bad", status: "complete" }),
      ).rejects.toMatchObject({ operation: "finish" });
      expect((await readHistory(directory, record.runId))?.status).toBe("pending");
    }));
});

it("captures bounded logs in one observed sequence and mirrors retained content only", () => {
  const mirrored: string[] = [];
  const logs = makeRunLogs(
    (content) => mirrored.push(content),
    () => Date.UTC(2026, 0, 2, 3, 4, 5),
  );
  logs.add("stdout", "one");
  logs.add("script", "two");
  logs.add("script", "three\n");
  logs.add("stderr", "x".repeat(70000));
  const snapshot = logs.snapshot();
  expect(snapshot.logs.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  expect(new Set(snapshot.logs.map((event) => event.timestamp))).toEqual(
    new Set(["2026-01-02T03:04:05.000Z"]),
  );
  expect(snapshot.logs.map((event) => event.content).slice(0, 3)).toEqual([
    "one",
    "two",
    "three\n",
  ]);
  // A script log record is a line on stderr; raw stream chunks are mirrored as they arrived.
  expect(mirrored).toEqual(["one", "two\n", "three\n", snapshot.logs.at(-1)?.content]);
  expect(snapshot.logTruncation.reasons).toContain("event_bytes");
});

describe("live Shell", () => {
  it("preserves argument values, default cwd, non-zero exits, and typed spawn failure", () =>
    fixture(async (directory) => {
      const shell = makeLiveShell({
        cwd: directory,
        environment: process.env,
        onOutput: () => undefined,
        onStart: () => undefined,
        onEnd: () => undefined,
      });
      const result = await Effect.runPromise(
        shell.execute({
          executable: process.execPath,
          args: [
            "-e",
            "console.log(JSON.stringify([process.cwd(),...process.argv.slice(1)]));process.exitCode=7",
            "a b",
            "$(inert)",
          ],
        }),
      );
      expect(result.exitCode).toBe(7);
      expect(JSON.parse(result.stdout)).toEqual([directory, "a b", "$(inert)"]);
      const failed = await Effect.runPromise(
        shell.execute({ executable: "/missing-tack-executable", args: [] }).pipe(Effect.result),
      );
      expect(failed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ShellFailure", operation: "spawn" },
      });
    }));
});

describe("fresh supervised workers", () => {
  it("captures module streams separately, completes encoded success and shows thrown messages", () =>
    fixture(async (directory) => {
      const entrypoint = join(directory, "script.ts");
      await writeFile(entrypoint, `console.log('import-output');\n${definition('return "done";')}`);
      const completed = await superviseWorker({
        signal: unused,
        runId: crypto.randomUUID(),
        entrypoint,
        cwd: directory,
        input: {},
        stateDirectory: directory,
        quiet: true,
      });
      expect(completed.result.outcome).toMatchObject({
        code: "success",
        classification: "success",
      });
      expect(completed.result.logs.some((event) => event.content.includes("import-output"))).toBe(
        true,
      );
      expect(completed.result.core).toMatchObject({ primary: { encoded: "done" } });
      await writeFile(entrypoint, definition('throw new Error("thrown-canary");'));
      const failed = await superviseWorker({
        signal: unused,
        runId: crypto.randomUUID(),
        entrypoint,
        cwd: directory,
        input: {},
        stateDirectory: directory,
        quiet: true,
      });
      expect(failed.result.outcome).toMatchObject({
        code: "executed_defect",
        message: "thrown-canary",
      });
    }));
  it("distinguishes import exit, timeout cleanup, missing secrets, and invalid protocol", () =>
    fixture(async (directory) => {
      const entrypoint = join(directory, "script.ts");
      await writeFile(entrypoint, "process.exit(5);");
      const exited = await superviseWorker({
        signal: unused,
        runId: crypto.randomUUID(),
        entrypoint,
        cwd: directory,
        input: {},
        stateDirectory: directory,
        quiet: true,
      });
      expect(exited.result.outcome).toMatchObject({
        code: "unexpected_worker_exit",
        details: { lastStage: "load" },
      });
      const ready = join(directory, "ready");
      await writeFile(entrypoint, definition(`${markReady(ready)} ${untilCancelled}`));
      const timed = await superviseUntilReadyThenExpire(
        {
          signal: unused,
          runId: crypto.randomUUID(),
          entrypoint,
          cwd: directory,
          input: {},
          stateDirectory: directory,
          quiet: true,
        },
        ready,
      );
      expect(timed.result.outcome.code).toBe("timeout");
      expect(timed.result.termination).toEqual({ reason: "timeout", forced: false });
      expect(timed.result.finalization).toBe("complete");
      await writeFile(entrypoint, definition('return "unreachable";', 'secrets: ["TOKEN"],'));
      const missing = await superviseWorker({
        signal: unused,
        runId: crypto.randomUUID(),
        entrypoint,
        cwd: directory,
        input: {},
        stateDirectory: directory,
        quiet: true,
        environment: { PATH: process.env["PATH"] },
      });
      expect(missing.result.outcome.code).toBe("secret_missing");
      const fake = join(directory, "fake.ts");
      await writeFile(
        fake,
        "import{writeSync}from'node:fs';writeSync(4,Buffer.from([0,0,0,2,123,125]));",
      );
      const invalid = await superviseWorker({
        signal: unused,
        runId: crypto.randomUUID(),
        entrypoint,
        cwd: directory,
        input: {},
        stateDirectory: directory,
        workerPath: fake,
        quiet: true,
      });
      expect(invalid.result.outcome.code).toBe("protocol_failure");
    }));
});

describe("describing a script", () => {
  it("reports what a script declares without running it, or why it is no script", () =>
    fixture(async (directory) => {
      const entrypoint = join(directory, "declared.ts");
      const ran = join(directory, "ran");
      await writeFile(
        entrypoint,
        `import { defineScript } from "@tackup/cli"; export default defineScript({ args: { name: { type: "string" }, times: { type: "number", default: 1 } }, secrets: ["TOKEN"], run: async () => (await import("node:fs")).writeFileSync(${JSON.stringify(ran)}, "ran") });`,
      );
      const options = {
        signal: unused,
        runId: crypto.randomUUID(),
        entrypoint,
        cwd: directory,
        input: {},
        stateDirectory: directory,
        quiet: true,
        describe: true,
      } as const;
      const described = await superviseWorker(options);
      expect(described.described).toEqual({
        args: { name: { type: "string" }, times: { type: "number", default: 1 } },
        secrets: ["TOKEN"],
      });
      await expect(access(ran)).rejects.toThrow();

      await writeFile(entrypoint, "export default 42;");
      const refused = await superviseWorker({ ...options, runId: crypto.randomUUID() });
      expect(refused.described).toBeUndefined();
      expect(refused.result.outcome).toMatchObject({ code: "invalid_definition" });
    }));
});

describe("worker failure and termination evidence", () => {
  it("retains initiating timeout when a blocked import requires force termination", () =>
    fixture(async (directory) => {
      const entrypoint = join(directory, "blocked.ts");
      await writeFile(entrypoint, "while(true) {}");
      const forced = await superviseWorker({
        signal: unused,
        runId: crypto.randomUUID(),
        entrypoint,
        cwd: directory,
        input: {},
        stateDirectory: directory,
        quiet: true,
        timeoutMs: 100,
        graceMs: 50,
      });
      expect(forced.result.outcome).toMatchObject({ code: "timeout", classification: "domain" });
      expect(forced.result.termination).toEqual({ reason: "timeout", forced: true });
      expect(forced.result.finalization).toBe("incomplete");
    }));
  it("keeps the initiating timeout when killing a worker that never read its control pipe", () =>
    fixture(async (directory) => {
      // The worker blocks before reading, so the start and cancel frames stay unread. Killing a
      // process that holds unread input resets the control pipe on Linux; that reset is a
      // consequence of the termination, not a protocol failure.
      const ready = join(directory, "ready");
      const fake = join(directory, "never-reads.ts");
      await writeFile(
        fake,
        `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(ready)},"ready");while(true){}`,
      );
      const timed = await superviseUntilReadyThenExpire(
        {
          signal: unused,
          runId: crypto.randomUUID(),
          entrypoint: join(directory, "unused.ts"),
          cwd: directory,
          input: {},
          stateDirectory: directory,
          workerPath: fake,
          quiet: true,
          graceMs: 50,
        },
        ready,
      );
      expect(timed.result.outcome).toMatchObject({ code: "timeout", classification: "domain" });
      expect(timed.result.termination).toEqual({ reason: "timeout", forced: true });
      expect(timed.result.finalization).toBe("incomplete");
    }));
  it("refuses leftover worker activity after a successful script", () =>
    fixture(async (directory) => {
      const entrypoint = join(directory, "interval.ts");
      await writeFile(entrypoint, `setInterval(()=>{},1000);\n${definition('return "done";')}`);
      const leftover = await superviseWorker({
        signal: unused,
        runId: crypto.randomUUID(),
        entrypoint,
        cwd: directory,
        input: {},
        stateDirectory: directory,
        quiet: true,
        graceMs: 50,
      });
      expect(leftover.result.outcome.code).toBe("cleanup_failed");
      expect(leftover.result.finalization).toBe("incomplete");
      expect(leftover.result.core).toMatchObject({ primary: { encoded: "done" } });
    }));
  it("gives a script its declared secret only, scrubbed from what it returns", () =>
    fixture(async (directory) => {
      const entrypoint = join(directory, "secrets.ts");
      await writeFile(join(directory, ".env"), "TACK_TOKEN=dotenv-value\n");
      await writeFile(
        entrypoint,
        definition(
          "return JSON.stringify({ value: context.secrets.TOKEN, ambient: process.env.TACK_TOKEN ?? null, undeclared: process.env.TACK_UNDECLARED ?? null });",
          'secrets: ["TOKEN"],',
        ),
      );
      const result = await superviseWorker({
        signal: unused,
        runId: crypto.randomUUID(),
        entrypoint,
        cwd: directory,
        input: {},
        stateDirectory: directory,
        quiet: true,
        environment: {
          PATH: process.env["PATH"],
          TACK_TOKEN: "process-canary",
          TACK_UNDECLARED: "undeclared-canary",
        },
      });
      expect(result.result.outcome.code).toBe("success");
      expect(JSON.stringify(result.result)).not.toContain("process-canary");
      expect(result.result.core).toMatchObject({
        primary: {
          encoded: JSON.stringify({ value: "<redacted>", ambient: null, undeclared: null }),
        },
      });
    }));
  it("terminates a Shell command tree when its Effect is interrupted", () =>
    fixture(async (directory) => {
      let ownedPid: number | undefined;
      const shell = makeLiveShell({
        cwd: directory,
        environment: process.env,
        onOutput: () => undefined,
        onStart: (pid) => {
          ownedPid = pid;
        },
        onEnd: () => undefined,
      });
      const controller = new AbortController();
      const program = shell.execute({
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
      });
      const promise = Effect.runPromiseExit(program, { signal: controller.signal });
      controller.abort();
      await promise;
      expect(ownedPid).toBeDefined();
      const pid = ownedPid;
      if (pid !== undefined) expect(() => process.kill(-pid, 0)).toThrow();
    }));
});

it("cancels a stdin read without requiring EOF and keeps UTF8 log truncation within its byte limit", async () => {
  const stream = new PassThrough();
  const controller = new AbortController();
  const pending = readRunInput({ ...request, inputStdin: true }, stream, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    outcome: { code: "interrupted", classification: "interruption" },
  });
  expect(stream.destroyed).toBe(true);
  const logs = makeRunLogs(
    () => undefined,
    () => 0,
  );
  logs.add("stdout", "x".repeat(65535) + "😀");
  const captured = logs.snapshot().logs[0]?.content ?? "";
  expect(Buffer.byteLength(captured)).toBeLessThanOrEqual(65536);
  expect(captured).not.toContain("�");
});

it("rejects forged successful cores, early terminal outcomes and duplicate terminal frames", () =>
  fixture(async (directory) => {
    const protocol = resolve(import.meta.dirname, "protocol.ts");
    const core = {
      status: "success",
      stage: "output",
      code: "success",
      primary: { status: "success", stage: "output", code: "success", encoded: "done" },
      finalization: { status: "complete" },
    };
    for (const scenario of ["forged", "early", "duplicate"]) {
      const fake = join(directory, `${scenario}.ts`);
      const malformed =
        scenario === "forged"
          ? { stage: "nonsense", code: "success", primary: {}, finalization: {} }
          : core;
      await writeFile(
        fake,
        `import{createReadStream,createWriteStream}from'node:fs';import{FrameDecoder,encodeFrame}from ${JSON.stringify(protocol)};const input=createReadStream('',{fd:3});const out=createWriteStream('',{fd:4});const d=new FrameDecoder();let id;const send=(kind,payload)=>out.write(encodeFrame({version:1,runId:id,kind,payload}));input.on('data',chunk=>{for(const f of d.push(chunk)){id=f.runId;if(f.kind==='start'){send('stage',{stage:'load'});if(${JSON.stringify(scenario)}==='early'){send('terminal',{core:${JSON.stringify(malformed)},coreTruncation:[]});out.end();input.destroy();}else send('requirements',{secrets:[],services:[]});}else if(f.kind==='capabilities'){send('stage',{stage:'execution'});send('terminal',{core:${JSON.stringify(malformed)},coreTruncation:[]});if(${JSON.stringify(scenario)}==='duplicate')send('terminal',{core:${JSON.stringify(malformed)},coreTruncation:[]});out.end();input.destroy();}}});`,
      );
      const result = await superviseWorker({
        signal: unused,
        runId: crypto.randomUUID(),
        entrypoint: fake,
        workerPath: fake,
        cwd: directory,
        input: {},
        stateDirectory: directory,
        quiet: true,
      });
      expect(result.result.outcome.code).toBe("protocol_failure");
      if (scenario === "early") {
        // A terminal frame the lifecycle rejects contributes no core evidence or finalization claim.
        expect(result.result.core).toBeUndefined();
        expect(result.result.finalization).toBe("not-started");
        expect(result.diagnostics).toBeUndefined();
      }
    }
  }));

it("preserves precise Effect logger truncation evidence in quiet and mirrored runs", () =>
  fixture(async (directory) => {
    const entrypoint = join(directory, "logs.ts");
    await writeFile(
      entrypoint,
      definition(
        'context.log("x".repeat(70000)); for (let i = 0; i < 10002; i++) context.log("event " + i); return "done";',
      ),
    );
    const quiet = await superviseWorker({
      signal: unused,
      runId: crypto.randomUUID(),
      entrypoint,
      cwd: directory,
      input: {},
      stateDirectory: directory,
      quiet: true,
    });
    const mirrored: string[] = [];
    const normal = await superviseWorker({
      signal: unused,
      runId: crypto.randomUUID(),
      entrypoint,
      cwd: directory,
      input: {},
      stateDirectory: directory,
      mirror: (content) => mirrored.push(content),
    });
    expect(quiet.result.outcome.code, JSON.stringify(quiet)).toBe("success");
    expect(quiet.result.logTruncation.truncated).toBe(true);
    expect(quiet.result.core).toMatchObject({
      truncation: expect.arrayContaining([
        expect.objectContaining({ reason: "event_bytes", observed: 70000, limit: 65536 }),
        expect.objectContaining({ reason: "event_count", observed: 10003, limit: 10000 }),
      ]),
    });
    expect(normal.result.logs.map((log) => log.content)).toEqual(
      quiet.result.logs.map((log) => log.content),
    );
    expect(mirrored).toEqual(normal.result.logs.map((log) => `${log.content}\n`));
    expect(normal.result.core).toMatchObject({ truncation: expect.any(Array) });
  }));

it("bounds settlement when raw descendants retain worker streams, including after worker exit", () =>
  fixture(async (directory) => {
    for (const [detachedFromEventLoop, detachedProcessGroup] of [
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      const entrypoint = join(directory, "descendant.ts");
      await writeFile(
        entrypoint,
        `import{spawn}from'node:child_process';\n${definition(`const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit",detached:${detachedProcessGroup}});console.error("raw-child:"+child.pid);${detachedFromEventLoop === true ? "child.unref();" : ""}return "done";`)}`,
      );
      const execution = await superviseWorker({
        signal: unused,
        runId: crypto.randomUUID(),
        entrypoint,
        cwd: directory,
        input: {},
        stateDirectory: directory,
        quiet: true,
        graceMs: 100,
      });
      const childText = execution.result.logs.map((event) => event.content).join("");
      const pid = Number(/raw-child:(\d+)/.exec(childText)?.[1]);
      try {
        expect(execution.result.outcome.code).toBe("cleanup_failed");
        expect(execution.result.finalization).toBe("incomplete");
        expect(execution.result.core).toMatchObject({ primary: { encoded: "done" } });
        expect(Number.isFinite(pid)).toBe(true);
      } finally {
        if (Number.isFinite(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already terminated by the owned worker group. */
          }
        }
      }
    }
  }));

it("prioritizes cleanup failure over the initiating timeout while retaining that reason", () =>
  fixture(async (directory) => {
    const entrypoint = join(directory, "cleanup-timeout.ts");
    const ready = join(directory, "ready");
    await writeFile(
      entrypoint,
      definition(
        `try { ${markReady(ready)} ${untilCancelled} } finally { throw new Error("cleanup failure"); }`,
      ),
    );
    // The deadline expires only after the finalizer is registered.
    const execution = await superviseUntilReadyThenExpire(
      {
        signal: unused,
        runId: crypto.randomUUID(),
        entrypoint,
        cwd: directory,
        input: {},
        stateDirectory: directory,
        quiet: true,
      },
      ready,
    );
    expect(execution.result.outcome.code).toBe("cleanup_failed");
    expect(execution.result.termination).toEqual({ reason: "timeout", forced: false });
    expect(execution.result.core).toMatchObject({
      primary: { code: "interrupted" },
      finalization: { status: "failed" },
    });
  }));

describe("bounded run input", () => {
  const oversized = () => [Buffer.alloc(700_000, 32), Buffer.alloc(700_000, 32)];

  it("refuses to read input whose run was interrupted before reading began", async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = new PassThrough();
    await expect(
      readRunInput({ ...request, inputStdin: true }, stream, controller.signal),
    ).rejects.toMatchObject({ outcome: { code: "interrupted" } });
    expect(stream.destroyed).toBe(true);
    async function* never() {
      yield Buffer.from("{}");
    }
    await expect(
      readRunInput({ ...request, inputStdin: true }, never(), controller.signal),
    ).rejects.toMatchObject({ outcome: { code: "interrupted" } });
  });

  it("stops waiting on a non-stream source when the run is interrupted", async () => {
    const controller = new AbortController();
    const pending: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    };
    const reading = readRunInput({ ...request, inputStdin: true }, pending, controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({
      outcome: { code: "interrupted", classification: "interruption" },
    });
  });

  it("stops reading standard input past 1 MiB from streams, iterables and files", () =>
    fixture(async (directory) => {
      const stream = new PassThrough();
      for (const chunk of oversized()) stream.write(chunk);
      stream.end();
      await expect(readRunInput({ ...request, inputStdin: true }, stream)).rejects.toMatchObject({
        outcome: { code: "input_too_large" },
      });
      expect(stream.destroyed).toBe(true);
      async function* chunks() {
        yield* oversized();
      }
      await expect(readRunInput({ ...request, inputStdin: true }, chunks())).rejects.toMatchObject({
        outcome: { code: "input_too_large" },
      });
      const file = join(directory, "large.json");
      await writeFile(file, Buffer.concat(oversized()));
      await expect(readRunInput({ ...request, inputFile: file })).rejects.toMatchObject({
        outcome: { code: "input_too_large" },
      });
    }));

  it("reports a failing standard input as a read failure", async () => {
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("{");
      throw new Error("stdin broke");
    }
    await expect(readRunInput({ ...request, inputStdin: true }, failing())).rejects.toMatchObject({
      outcome: { code: "input_stdin_read_failed" },
    });
  });
});

describe("secret configuration and diagnostic redaction", () => {
  it("refuses an unreadable dotenv file and secret names outside the declared form", () =>
    fixture(async (directory) => {
      await mkdir(join(directory, ".env"));
      await expect(prepareSecretLookup(directory, {})).rejects.toMatchObject({
        code: "secret_configuration_failed",
        message: "The operator secret configuration could not be read.",
      });
      const lookup = await prepareSecretLookup(join(directory, "absent"), { TACK_TOKEN: "x" });
      await expect(lookup.lookup(["token"])).rejects.toMatchObject({
        code: "secret_configuration_failed",
        names: [],
      });
    }));

  it("redacts known values, skipping empty ones, and bounds nested diagnostics", () => {
    expect(redactDiagnostic("token=abc", ["", "abc"])).toBe("token=[REDACTED]");
    const deep = Array.from({ length: 10 }).reduce<import("effect").Schema.Json>(
      (inner) => ({ inner }),
      "abc",
    );
    expect(JSON.stringify(redactOwnedJson(deep, ["abc"]))).toBe(
      `${'{"inner":'.repeat(9)}"[TRUNCATED]"${"}".repeat(9)}`,
    );
    const wide = redactOwnedJson(
      Array.from({ length: 70 }, () => "abc"),
      ["abc"],
    );
    expect(wide).toEqual(Array.from({ length: 64 }, () => "[REDACTED]"));
    expect(redactOwnedJson(7, ["7"])).toBe(7);
  });
});

describe("bounded run logs", () => {
  it("counts events past the event limit without retaining them", () => {
    const mirrored: string[] = [];
    const logs = makeRunLogs(
      (content) => mirrored.push(content),
      () => 0,
    );
    for (let index = 0; index < 10_001; index += 1) logs.add("stdout", "x");
    const snapshot = logs.snapshot();
    expect(snapshot.logs).toHaveLength(10_000);
    expect(mirrored).toHaveLength(10_000);
    expect(snapshot.logTruncation).toEqual({
      truncated: true,
      observedBytes: 10_001,
      observedEvents: 10_001,
      reasons: ["event_count"],
    });
  });

  it("retains at most the total byte limit and drops everything after it", () => {
    const logs = makeRunLogs(
      () => undefined,
      () => 0,
    );
    const event = "x".repeat(65_535);
    for (let index = 0; index < 160; index += 1) logs.add("stdout", event);
    logs.add("stderr", "y".repeat(1000));
    logs.add("stderr", "dropped");
    const snapshot = logs.snapshot();
    expect(snapshot.logs).toHaveLength(161);
    expect(snapshot.logs.at(-1)).toMatchObject({ source: "stderr", content: "y".repeat(160) });
    expect(snapshot.logs.reduce((total, log) => total + log.content.length, 0)).toBe(
      10 * 1024 * 1024,
    );
    expect(snapshot.logTruncation.reasons).toEqual(["total_bytes"]);
    expect(snapshot.logTruncation.observedEvents).toBe(162);
  });
});

describe("live Shell output bounds and termination", () => {
  const shellIn = (directory: string, outputs: string[] = []) =>
    makeLiveShell({
      cwd: directory,
      environment: process.env,
      onOutput: (content) => outputs.push(content),
      onStart: () => undefined,
      onEnd: () => undefined,
    });

  it("reports incomplete UTF-8 output tails once the command closes", () =>
    fixture(async (directory) => {
      const outputs: string[] = [];
      const result = await Effect.runPromise(
        shellIn(directory, outputs).execute({
          executable: process.execPath,
          args: [
            "-e",
            "require('fs').writeSync(1,Buffer.from([0xe2]));require('fs').writeSync(2,Buffer.from([0xe2]))",
          ],
        }),
      );
      expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
      expect(outputs).toEqual(["�", "�"]);
    }));

  it("keeps the first MiB of each stream and marks both as truncated", () =>
    fixture(async (directory) => {
      // Each stream fills its MiB first, then writes again later, so a chunk always arrives once
      // the kept output is already full, however the pipe splits the first write.
      const result = await Effect.runPromise(
        shellIn(directory).execute({
          executable: process.execPath,
          args: [
            "-e",
            "const fs=require('fs');fs.writeSync(1,'a'.repeat(1048576));fs.writeSync(2,'b'.repeat(1048576));" +
              "setTimeout(()=>{fs.writeSync(1,'a'.repeat(150000));fs.writeSync(2,'b'.repeat(150000))},100)",
          ],
        }),
      );
      expect(result.stdout).toBe("a".repeat(1024 * 1024));
      expect(result.stderr).toBe("b".repeat(1024 * 1024));
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);
    }));

  it("reports arguments the platform refuses as a spawn failure", () =>
    fixture(async (directory) => {
      const failed = await Effect.runPromise(
        shellIn(directory)
          .execute({ executable: process.execPath, args: ["nul\0byte"] })
          .pipe(Effect.result),
      );
      expect(failed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ShellFailure", operation: "spawn" },
      });
    }));

  it("escalates to SIGKILL when an interrupted command ignores SIGTERM", () =>
    fixture(async (directory) => {
      let ownedPid: number | undefined;
      const controller = new AbortController();
      const outputs: string[] = [];
      const shell = makeLiveShell({
        cwd: directory,
        environment: process.env,
        onOutput: (content) => {
          outputs.push(content);
          if (content.includes("ignoring")) controller.abort();
        },
        onStart: (pid) => {
          ownedPid = pid;
        },
        onEnd: () => undefined,
      });
      await Effect.runPromiseExit(
        shell.execute({
          executable: process.execPath,
          args: [
            "-e",
            "process.on('SIGTERM',()=>{});console.log('ignoring');setInterval(()=>{},1000)",
          ],
        }),
        { signal: controller.signal },
      );
      expect(outputs).toContain("Command interruption requested.\n");
      const pid = ownedPid;
      expect(pid).toBeDefined();
      if (pid !== undefined) expect(() => process.kill(-pid, 0)).toThrow();
    }));
});

describe("run history edge records", () => {
  const pending = (): HistoryRecord => ({
    version: 1,
    runId: crypto.randomUUID(),
    status: "pending",
    startedAt: "2026-01-01T00:00:00.000Z",
    address: request.address,
  });

  it("treats an address with an unknown key as an invalid record", () =>
    fixture(async (directory) => {
      const runId = crypto.randomUUID();
      await mkdir(historyDirectory(directory), { recursive: true });
      const path = join(historyDirectory(directory), `${runId}.json`);
      await writeFile(
        path,
        JSON.stringify({ ...pending(), runId, address: { ...request.address, owner: "team" } }),
      );
      await expect(readHistory(directory, runId)).rejects.toThrow("history read failed");
      expect(await listHistory(directory)).toEqual({
        runs: [],
        issues: [{ path, reason: "invalid" }],
      });
    }));

  it("refuses to finish a record that is no longer pending", () =>
    fixture(async (directory) => {
      const record = pending();
      await createPendingHistory(directory, record);
      const finished: HistoryRecord = {
        ...record,
        status: "complete",
        finishedAt: "2026-01-01T00:00:01.000Z",
        result: {
          runId: record.runId,
          outcome: {
            stage: "output",
            code: "success",
            message: "Done.",
            classification: "success",
          },
          logs: [],
          logTruncation: { truncated: false, observedBytes: 0, observedEvents: 0, reasons: [] },
          finalization: "complete",
        },
      };
      await finishHistory(directory, finished);
      await expect(finishHistory(directory, finished)).rejects.toMatchObject({
        operation: "finish",
      });
      expect(await readHistory(directory, record.runId)).toEqual(finished);
    }));

  it("skips a record that vanished after listing and fails when history is not a directory", () =>
    fixture(async (directory) => {
      await mkdir(historyDirectory(directory), { recursive: true });
      const dangling = join(historyDirectory(directory), `${crypto.randomUUID()}.json`);
      await symlink(join(directory, "gone.json"), dangling);
      expect(await listHistory(directory)).toEqual({ runs: [], issues: [] });
      expect(await countHistory(directory)).toBe(1);
      await rm(historyDirectory(directory), { recursive: true });
      await writeFile(historyDirectory(directory), "not a directory");
      await expect(listHistory(directory)).rejects.toThrow("history read failed");
      await expect(clearHistory(directory)).rejects.toThrow("history clear failed");
      expect(await readFile(historyDirectory(directory), "utf8")).toBe("not a directory");
    }));
});
