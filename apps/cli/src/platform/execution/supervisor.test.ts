import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defineScript,
  encodeRunOutcome,
  inspectScriptDefinition,
  NoExpectedFailure,
  runScript,
} from "@tackup/core";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { superviseWorker } from "./supervisor.ts";

/** Supervised runs require a caller-owned cancellation signal; these tests never abort it. */
const unused = new AbortController().signal;
const protocolPath = resolve(import.meta.dirname, "protocol.ts");

const fixture = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "tack-supervisor-"));
  try {
    await run(await realpath(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** A valid encoded core for a successful run, as the real worker reports it. */
const successCore = {
  status: "success",
  stage: "output",
  code: "success",
  primary: { status: "success", stage: "output", code: "success", encoded: "done" },
  finalization: { status: "complete" },
};

/**
 * Writes a scripted stand-in for the worker. `onStart` runs when the start frame arrives and
 * `onCapabilities` when the supervisor supplies capabilities; both see `id`, `frame`, `send`,
 * `out`, `input` and `finish`.
 */
const fakeWorker = async (
  directory: string,
  name: string,
  steps: { readonly prelude?: string; readonly onStart: string; readonly onCapabilities?: string },
) => {
  const path = join(directory, `${name}.ts`);
  await writeFile(
    path,
    [
      `import{closeSync,createReadStream,createWriteStream,existsSync,writeFileSync,writeSync}from'node:fs';`,
      `import{spawn}from'node:child_process';`,
      `import{FrameDecoder,encodeFrame}from ${JSON.stringify(protocolPath)};`,
      steps.prelude ?? "",
      `const input=createReadStream('',{fd:3});`,
      `const out=createWriteStream('',{fd:4});`,
      `const decoder=new FrameDecoder();`,
      `let id;`,
      `const frame=(kind,payload,runId=id)=>encodeFrame({version:1,runId,kind,payload});`,
      `const send=(kind,payload)=>out.write(frame(kind,payload));`,
      `const finish=()=>{out.end();input.destroy();};`,
      `input.on('data',(chunk)=>{for(const f of decoder.push(chunk)){id=f.runId;`,
      `if(f.kind==='start'){${steps.onStart}}`,
      `else if(f.kind==='capabilities'){${steps.onCapabilities ?? ""}}}});`,
    ].join("\n"),
  );
  return path;
};

/** Starts a detached sleeper in its own process group, like a Shell command tree. */
const detachedSleeper = `spawn('sleep',['30'],{detached:true,stdio:'ignore'})`;

const groupIsAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether a killed group disappears. The worker's orphaned commands are reaped by the system's init
 * process, so a killed group can linger briefly as a zombie; this polls a bounded number of times.
 */
const groupDisappears = async (pid: number) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (groupIsAlive(pid) === false) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return false;
};

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* Already gone. */
  }
};

/** Waits for a file the worker writes once it reached a known point. */
const waitForFile = async (path: string, settled: () => boolean) => {
  while (settled() === false) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
  }
  throw new Error(`The worker settled before ${path} appeared.`);
};

const baseOptions = (directory: string) => ({
  runId: crypto.randomUUID(),
  entrypoint: join(directory, "unused.ts"),
  cwd: directory,
  input: {},
  stateDirectory: directory,
  quiet: true,
});

const pidsIn = (logs: ReadonlyArray<{ readonly content: string }>, label: string) =>
  [
    ...logs
      .map((log) => log.content)
      .join("")
      .matchAll(new RegExp(`${label}:(\\d+)`, "g")),
  ].map((match) => Number(match[1]));

describe("supervisor startup", () => {
  it("reports an interruption before startup without spawning a worker", () =>
    fixture(async (directory) => {
      const controller = new AbortController();
      controller.abort();
      const marker = join(directory, "spawned");
      const worker = await fakeWorker(directory, "never", {
        prelude: `writeFileSync(${JSON.stringify(marker)},"");`,
        onStart: "",
      });
      const result = await superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        signal: controller.signal,
      });
      expect(result.result.outcome).toMatchObject({
        code: "interrupted",
        classification: "interruption",
      });
      expect(result.result.finalization).toBe("not-started");
      expect(result.result.termination).toEqual({ reason: "user-interruption", forced: false });
      await expect(access(marker)).rejects.toThrow();
    }));

  it("reports a worker that cannot be spawned at all as a spawn failure", () =>
    fixture(async (directory) => {
      const result = await superviseWorker({
        ...baseOptions(directory),
        signal: unused,
        workerPath: "worker\0.ts",
      });
      expect(result.result.outcome).toMatchObject({
        stage: "worker",
        code: "worker_spawn_failed",
      });
      expect(result.result.finalization).toBe("not-started");
      expect(result.diagnostics).toBeUndefined();
    }));

  it("reports a worker whose working directory is missing as a spawn failure", () =>
    fixture(async (directory) => {
      const result = await superviseWorker({
        ...baseOptions(directory),
        cwd: join(directory, "missing"),
        signal: unused,
      });
      expect(result.result.outcome).toMatchObject({
        stage: "worker",
        code: "worker_spawn_failed",
      });
      expect(result.result.finalization).toBe("not-started");
    }));

  it("honours an interruption that lands while the worker is being wired", () =>
    fixture(async (directory) => {
      const controller = new AbortController();
      const worker = await fakeWorker(directory, "blocking", { onStart: "while(true){}" });
      const result = await superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        graceMs: 50,
        signal: controller.signal,
        onRepeatSignal: () => {
          // The operator interrupts before the supervisor listens for the abort event.
          controller.abort();
          return () => undefined;
        },
      });
      expect(result.result.outcome.code).toBe("interrupted");
      expect(result.result.termination?.reason).toBe("user-interruption");
    }));

  it("mirrors captured output to stderr when neither quiet nor a mirror is requested", () =>
    fixture(async (directory) => {
      // Exit only after the start frame arrives: writing it to an exited worker resets the pipe on Linux.
      const worker = await fakeWorker(directory, "chatty", {
        onStart: `writeSync(1,"mirrored-by-default\\n");process.exit(0);`,
      });
      const writes: string[] = [];
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      try {
        const { quiet: _quiet, ...options } = baseOptions(directory);
        const result = await superviseWorker({ ...options, workerPath: worker, signal: unused });
        expect(result.result.outcome.code).toBe("unexpected_worker_exit");
      } finally {
        stderr.mockRestore();
      }
      expect(writes.join("")).toContain("mirrored-by-default");
    }));
});

describe("supervised worker streams and frames", () => {
  it("keeps an incomplete UTF-8 tail of worker output as a replacement character", () =>
    fixture(async (directory) => {
      const worker = await fakeWorker(directory, "partial-utf8", {
        prelude: `writeSync(1,Buffer.from([0xe2,0x82]));process.exit(0);`,
        onStart: "",
      });
      const result = await superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        signal: unused,
      });
      expect(result.result.logs.map((log) => [log.source, log.content])).toEqual([["stdout", "�"]]);
    }));

  it("reports a worker that ends inside a protocol frame", () =>
    fixture(async (directory) => {
      const worker = await fakeWorker(directory, "truncated", {
        onStart: "out.write(Buffer.from([0,0,0,9,123]));finish();",
      });
      const result = await superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        signal: unused,
      });
      expect(result.result.outcome).toMatchObject({
        code: "protocol_failure",
        message: "The worker ended an incomplete protocol frame.",
      });
    }));

  it("refuses a frame that names another run", () =>
    fixture(async (directory) => {
      const worker = await fakeWorker(directory, "other-run", {
        onStart: "out.write(frame('stage',{stage:'load'},'another-run'));",
      });
      const result = await superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        signal: unused,
      });
      expect(result.result.outcome).toMatchObject({
        code: "protocol_failure",
        message: "The worker sent invalid private protocol traffic.",
      });
    }));

  it("withholds capabilities from a worker that broke the protocol while they were prepared", () =>
    fixture(async (directory) => {
      const received = join(directory, "received-capabilities");
      const worker = await fakeWorker(directory, "requirements-then-invalid", {
        onStart: `out.write(Buffer.concat([frame('stage',{stage:'load'}),frame('requirements',{secrets:[],services:[]}),frame('log',{source:'effect',content:'x'},'another-run')]));setInterval(()=>{},1000);`,
        onCapabilities: `writeFileSync(${JSON.stringify(received)},"");`,
      });
      const result = await superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        signal: unused,
      });
      expect(result.result.outcome.code).toBe("protocol_failure");
      await expect(access(received)).rejects.toThrow();
    }));

  it("reports capabilities that cannot reach the worker as a protocol failure, not a secret failure", () =>
    fixture(async (directory) => {
      const worker = await fakeWorker(directory, "closed-control", {
        onStart:
          "input.destroy();input.once('close',()=>{send('stage',{stage:'load'});send('requirements',{secrets:[],services:[]});setInterval(()=>{},1000);});",
      });
      const result = await superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        signal: unused,
      });
      expect(result.result.outcome).toMatchObject({
        stage: "worker",
        code: "protocol_failure",
        message: "The capabilities could not reach the worker.",
      });
    }));

  it("rejects a terminal core that is not an object", () =>
    fixture(async (directory) => {
      const worker = await fakeWorker(directory, "scalar-core", {
        onStart: "send('stage',{stage:'load'});send('requirements',{secrets:[],services:[]});",
        onCapabilities:
          "send('stage',{stage:'execution'});send('terminal',{core:'done',coreTruncation:[]});finish();",
      });
      const result = await superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        signal: unused,
      });
      expect(result.result.outcome).toMatchObject({
        code: "protocol_failure",
        message: "The worker sent invalid terminal data.",
      });
      expect(result.result.core).toBeUndefined();
    }));
});

describe("supervised Shell command groups", () => {
  it("kills the command groups a worker leaves open and forgets the ones it settled", () =>
    fixture(async (directory) => {
      const worker = await fakeWorker(directory, "shell-groups", {
        onStart: "send('stage',{stage:'load'});send('requirements',{secrets:[],services:[]});",
        onCapabilities: `send('stage',{stage:'execution'});const open=${detachedSleeper};const settled=${detachedSleeper};open.unref();settled.unref();writeSync(2,'open:'+open.pid+' settled:'+settled.pid+'\\n');send('shell-start',{pid:open.pid});send('shell-start',{pid:settled.pid});send('shell-end',{pid:settled.pid});send('terminal',{core:${JSON.stringify(successCore)},coreTruncation:[]});finish();`,
      });
      const result = await superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        signal: unused,
      });
      const [open] = pidsIn(result.result.logs, "open");
      const [settled] = pidsIn(result.result.logs, "settled");
      try {
        expect(result.result.outcome.code).toBe("success");
        expect(open).toBeGreaterThan(0);
        expect(settled).toBeGreaterThan(0);
        expect(await groupDisappears(open ?? 0)).toBe(true);
        expect(groupIsAlive(settled ?? 0)).toBe(true);
      } finally {
        for (const pid of [open, settled]) if (pid !== undefined) killGroup(pid);
      }
    }));

  it("kills open command groups when the worker breaks the protocol", () =>
    fixture(async (directory) => {
      const worker = await fakeWorker(directory, "shell-then-invalid", {
        onStart: "send('stage',{stage:'load'});send('requirements',{secrets:[],services:[]});",
        onCapabilities: `send('stage',{stage:'execution'});const open=${detachedSleeper};open.unref();writeSync(2,'open:'+open.pid+'\\n');send('shell-start',{pid:open.pid});out.write(frame('stage',{stage:'load'},'another-run'));setInterval(()=>{},1000);`,
      });
      const result = await superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        signal: unused,
      });
      const [open] = pidsIn(result.result.logs, "open");
      try {
        expect(result.result.outcome.code).toBe("protocol_failure");
        expect(open).toBeGreaterThan(0);
        expect(await groupDisappears(open ?? 0)).toBe(true);
      } finally {
        if (open !== undefined) killGroup(open);
      }
    }));
});

describe("supervised interruption", () => {
  it("forces termination when the operator interrupts a second time", () =>
    fixture(async (directory) => {
      const ready = join(directory, "ready");
      const worker = await fakeWorker(directory, "ignores-cancel", {
        prelude: `writeFileSync(${JSON.stringify(ready)},"");while(true){}`,
        onStart: "",
      });
      const controller = new AbortController();
      let repeat: (() => void) | undefined;
      const run = { settled: false };
      const pending = superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        // A long grace period: only the repeated interruption may force the termination.
        graceMs: 60_000,
        signal: controller.signal,
        onRepeatSignal: (listener) => {
          repeat = listener;
          return () => {
            repeat = undefined;
          };
        },
      });
      void pending.finally(() => {
        run.settled = true;
      });
      await waitForFile(ready, () => run.settled);
      controller.abort();
      repeat?.();
      const result = await pending;
      expect(result.result.outcome.code).toBe("interrupted");
      expect(result.result.termination).toEqual({ reason: "user-interruption", forced: true });
      expect(result.result.logs).toContainEqual(
        expect.objectContaining({
          source: "supervisor",
          content: "Operator requested interruption.\n",
        }),
      );
      expect(repeat).toBeUndefined();
    }));

  it("keeps the interruption as the outcome when the cancel request breaks the control pipe", () =>
    fixture(async (directory) => {
      const ready = join(directory, "ready");
      const worker = await fakeWorker(directory, "closed-then-blocked", {
        onStart: `input.destroy();input.once('close',()=>{writeFileSync(${JSON.stringify(ready)},"");while(true){}});`,
      });
      const controller = new AbortController();
      const run = { settled: false };
      const pending = superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        graceMs: 60_000,
        signal: controller.signal,
      });
      void pending.finally(() => {
        run.settled = true;
      });
      await waitForFile(ready, () => run.settled);
      controller.abort();
      const result = await pending;
      expect(result.result.outcome.code).toBe("interrupted");
      expect(result.result.termination).toEqual({ reason: "user-interruption", forced: true });
    }));

  it("ignores an interruption that arrives after the terminal report", () =>
    fixture(async (directory) => {
      const reported = join(directory, "reported");
      const go = join(directory, "go");
      const worker = await fakeWorker(directory, "late-interrupt", {
        onStart: "send('stage',{stage:'load'});send('requirements',{secrets:[],services:[]});",
        // The supervisor ends the control pipe once it accepted the terminal report.
        onCapabilities: `send('stage',{stage:'execution'});send('terminal',{core:${JSON.stringify(successCore)},coreTruncation:[]});input.once('end',()=>{writeFileSync(${JSON.stringify(reported)},"");const wait=setInterval(()=>{if(existsSync(${JSON.stringify(go)})){clearInterval(wait);out.end();}},5);});`,
      });
      const controller = new AbortController();
      const run = { settled: false };
      const pending = superviseWorker({
        ...baseOptions(directory),
        workerPath: worker,
        signal: controller.signal,
      });
      void pending.finally(() => {
        run.settled = true;
      });
      await waitForFile(reported, () => run.settled);
      controller.abort();
      await writeFile(go, "");
      const result = await pending;
      expect(result.result.outcome.code).toBe("success");
      expect(result.result.termination).toBeUndefined();
    }));
});

/** The encoded core a worker reports for one in-process run, without its logs and truncation. */
const coreOf = async (definition: unknown, input: unknown): Promise<unknown> => {
  const recognized = inspectScriptDefinition(definition);
  if (recognized.ok === false) throw new Error(recognized.message);
  const {
    logs: _logs,
    truncation: _truncation,
    ...core
  } = encodeRunOutcome(await runScript(recognized.definition, { input, services: {} }));
  return core;
};

describe("supervised core projection", () => {
  it("names a cleanup failure after success and a run that never started finalization", () =>
    fixture(async (directory) => {
      const declared = {
        contract: 1,
        output: Schema.String,
        error: NoExpectedFailure,
        secrets: [],
        services: [],
      } as const;
      const cores = {
        cleanup: await coreOf(
          defineScript({
            ...declared,
            input: Schema.Struct({}),
            run: () =>
              Effect.as(
                Effect.addFinalizer(() => Effect.die(new Error("cleanup canary"))),
                "done",
              ),
          }),
          {},
        ),
        input: await coreOf(
          defineScript({
            ...declared,
            input: Schema.Struct({ name: Schema.String }),
            run: () => Effect.succeed("unreachable"),
          }),
          {},
        ),
      };
      const supervised = async (name: keyof typeof cores) =>
        superviseWorker({
          ...baseOptions(directory),
          signal: unused,
          workerPath: await fakeWorker(directory, name, {
            onStart: "send('stage',{stage:'load'});send('requirements',{secrets:[],services:[]});",
            onCapabilities: `send('stage',{stage:'execution'});send('terminal',{core:${JSON.stringify(cores[name])},coreTruncation:[]});finish();`,
          }),
        });

      expect((await supervised("cleanup")).result).toMatchObject({
        outcome: { code: "cleanup_failed", message: "The script did not complete successfully." },
        core: { primary: { status: "success", encoded: "done" } },
      });
      expect((await supervised("input")).result).toMatchObject({
        outcome: { code: "invalid_input" },
        finalization: "not-started",
      });
    }));

  const script = (options: string) =>
    `import { defineScript } from "@tackup/cli"; export default defineScript({ ${options} });`;

  it("exposes the encoded expected failure of a failed run", () =>
    fixture(async (directory) => {
      const entrypoint = join(directory, "expected.ts");
      await writeFile(entrypoint, script('run: ({ fail }) => fail("refused")'));
      const result = await superviseWorker({
        ...baseOptions(directory),
        entrypoint,
        signal: unused,
      });
      expect(result.result.outcome).toMatchObject({ code: "expected_failure", stage: "execution" });
      expect(result.result.core).toMatchObject({
        primary: {
          status: "failure",
          encoded: { message: "refused", details: null },
          encodedFailures: [{ message: "refused", details: null }],
        },
      });
    }));

  it("reports a run refused for its arguments as never having started finalization", () =>
    fixture(async (directory) => {
      const entrypoint = join(directory, "input.ts");
      await writeFile(
        entrypoint,
        script('args: { name: { type: "string" } }, run: () => "unreachable"'),
      );
      const result = await superviseWorker({
        ...baseOptions(directory),
        entrypoint,
        signal: unused,
      });
      expect(result.result.outcome).toMatchObject({ code: "invalid_args", stage: "preflight" });
      expect(result.result.finalization).toBe("not-started");
    }));
});

describe("worker-reported failures", () => {
  it("distinguishes a missing dependency, a failing module and a value that is no definition", () =>
    fixture(async (directory) => {
      const cases = [
        ["dependency", 'import "tack-missing-dependency";', "load", "dependency_unavailable"],
        ["throwing", 'throw new Error("load-private-canary");', "load", "module_load_failed"],
        ["plain", "export default 42;", "preflight", "invalid_definition"],
      ] as const;
      for (const [name, source, stage, code] of cases) {
        const entrypoint = join(directory, `${name}.ts`);
        await writeFile(entrypoint, source);
        const result = await superviseWorker({
          ...baseOptions(directory),
          entrypoint,
          signal: unused,
        });
        expect(result.result.outcome).toMatchObject({ stage, code });
        expect(result.result.finalization).toBe("not-started");
        if (name === "throwing") {
          expect(JSON.stringify(result.result)).not.toContain("load-private-canary");
          expect(JSON.stringify(result.diagnostics)).toContain("load-private-canary");
        }
      }
    }));
});
