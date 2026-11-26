import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ExecutionWorker, RunHistory } from "../../services/execution-platform.ts";
import type { HistoryRecord, OperatorRunRequest } from "../../domain/execution/execution-schema.ts";
import { ExecutionPlatformLive, makeRunCancellation } from "./execution-platform.ts";
import { interruptSignals } from "../process/main-runtime.ts";

const request: OperatorRunRequest = {
  address: {
    kind: "script",
    name: "test",
    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  },
  selector: { _tag: "user" },
};

const fixture = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "tack-execution-platform-"));
  try {
    await run(await realpath(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** Both production execution adapters, read as one object. */
type Platform = ExecutionWorker["Service"] & RunHistory["Service"];

/** Runs one production platform operation and returns its error, or `undefined` on success. */
const platformError = <A>(use: (platform: Platform) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use({ ...(yield* ExecutionWorker), ...(yield* RunHistory) });
    }).pipe(
      Effect.flip,
      Effect.map((error): unknown => error),
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.provide(ExecutionPlatformLive),
    ),
  );

const run = <A, E>(use: (platform: Platform) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use({ ...(yield* ExecutionWorker), ...(yield* RunHistory) });
    }).pipe(Effect.provide(ExecutionPlatformLive)),
  );

describe("source package readiness", () => {
  const ready = (sourcePath: string, entrypoint: string) =>
    platformError((platform) => platform.packageReady(sourcePath, entrypoint));

  it("admits a TypeScript entrypoint inside a source whose dependencies are installed", () =>
    fixture(async (directory) => {
      const source = join(directory, "source");
      await mkdir(join(source, "node_modules", "local"), { recursive: true });
      await mkdir(join(directory, "node_modules", "hoisted"), { recursive: true });
      await writeFile(join(source, "node_modules", "local", "package.json"), "{}");
      await writeFile(join(directory, "node_modules", "hoisted", "package.json"), "{}");
      await writeFile(
        join(source, "package.json"),
        JSON.stringify({ dependencies: { local: "1.0.0", hoisted: "1.0.0" } }),
      );
      await writeFile(join(source, "script.ts"), "");
      expect(await ready(source, join(source, "script.ts"))).toBeUndefined();
      await writeFile(join(source, "package.json"), "{}");
      expect(await ready(source, join(source, "script.ts"))).toBeUndefined();
    }));

  it("accepts a source with no package manifest and refuses unreadable, non-object and malformed ones", () =>
    fixture(async (directory) => {
      const entrypoint = join(directory, "script.ts");
      await writeFile(entrypoint, "");
      expect(await ready(directory, entrypoint)).toBeUndefined();
      await mkdir(join(directory, "package.json"));
      expect(await ready(directory, entrypoint)).toMatchObject({
        code: "package_manifest_unavailable",
      });
      await rm(join(directory, "package.json"), { recursive: true });
      await writeFile(join(directory, "package.json"), "{ not json");
      expect(await ready(directory, entrypoint)).toMatchObject({
        stage: "preflight",
        code: "package_manifest_unavailable",
      });
      for (const manifest of ["[]", "null", "1"]) {
        await writeFile(join(directory, "package.json"), manifest);
        expect(await ready(directory, entrypoint)).toMatchObject({
          code: "package_manifest_invalid",
          message: "The source package manifest must be an object.",
        });
      }
      for (const dependencies of [null, [], "x"]) {
        await writeFile(join(directory, "package.json"), JSON.stringify({ dependencies }));
        expect(await ready(directory, entrypoint)).toMatchObject({
          code: "package_manifest_invalid",
          message: "The source dependencies must be a package mapping.",
        });
      }
    }));

  it("refuses missing, non-TypeScript and escaping entrypoints", () =>
    fixture(async (directory) => {
      const source = join(directory, "source");
      await mkdir(source);
      await writeFile(join(source, "package.json"), "{}");
      expect(await ready(source, join(source, "missing.ts"))).toMatchObject({
        code: "entrypoint_unavailable",
      });
      await writeFile(join(source, "script.js"), "");
      await writeFile(join(directory, "outside.ts"), "");
      await symlink(join(directory, "outside.ts"), join(source, "linked.ts"));
      for (const entrypoint of [
        join(source, "script.js"),
        join(directory, "outside.ts"),
        join(source, "linked.ts"),
      ]) {
        expect(await ready(source, entrypoint)).toMatchObject({
          code: "entrypoint_unsupported",
        });
      }
    }));

  it("names a declared dependency that no ancestor installs", () =>
    fixture(async (directory) => {
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ dependencies: { "tack-absent-dependency": "1.0.0" } }),
      );
      await writeFile(join(directory, "script.ts"), "");
      expect(await ready(directory, join(directory, "script.ts"))).toMatchObject({
        code: "dependency_unavailable",
        message: expect.stringContaining("tack-absent-dependency"),
      });
    }));
});

describe("production execution adapters", () => {
  it("maps input, history and secret failures to stable execution errors", () =>
    fixture(async (directory) => {
      expect(
        await platformError((platform) =>
          platform.input({ ...request, inputJson: "{}", inputStdin: true }),
        ),
      ).toMatchObject({ stage: "invocation", code: "input_sources_conflict" });
      const blocked = join(directory, "blocked");
      await writeFile(blocked, "");
      const record: HistoryRecord = {
        version: 1,
        runId: crypto.randomUUID(),
        status: "pending",
        startedAt: "2026-01-01T00:00:00.000Z",
        address: request.address,
      };
      expect(
        await platformError((platform) => platform.createHistory(blocked, record)),
      ).toMatchObject({ stage: "history", code: "history_create_failed" });
      // A directory where the operator dotenv file belongs cannot be read as secrets.
      await mkdir(join(directory, ".env"));
      expect(
        await platformError((platform) =>
          platform.worker({
            runId: crypto.randomUUID(),
            entrypoint: join(directory, "script.ts"),
            cwd: directory,
            input: {},
            stateDirectory: directory,
            quiet: true,
            signal: new AbortController().signal,
          }),
        ),
      ).toMatchObject({ stage: "preflight", code: "secret_configuration_failed" });
    }));

  it("reads input and keeps run history through the production layer", () =>
    fixture(async (directory) => {
      expect(await run((platform) => platform.input({ ...request, inputJson: '{"a":1}' }))).toEqual(
        { a: 1 },
      );
      const record: HistoryRecord = {
        version: 1,
        runId: crypto.randomUUID(),
        status: "pending",
        startedAt: "2026-01-01T00:00:00.000Z",
        address: request.address,
      };
      await run((platform) => platform.createHistory(directory, record));
      const finished: HistoryRecord = {
        ...record,
        status: "complete",
        finishedAt: "2026-01-01T00:00:01.000Z",
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
      await run((platform) => platform.finishHistory(directory, finished));
      expect(await run((platform) => platform.showHistory(directory, record.runId))).toEqual(
        finished,
      );
      expect(await run((platform) => platform.countHistory(directory))).toBe(1);
      expect((await run((platform) => platform.listHistory(directory))).runs).toHaveLength(1);
      expect(await run((platform) => platform.clearHistory(directory))).toBe(1);
      expect(await run((platform) => platform.countHistory(directory))).toBe(0);
    }));

  it("runs a script in a supervised worker and owns operator cancellation", () =>
    fixture(async (directory) => {
      const entrypoint = join(directory, "script.ts");
      await writeFile(
        entrypoint,
        `import { defineScript } from "@tackup/cli"; export default defineScript({ run: () => "done" });`,
      );
      const before = process.listenerCount("SIGINT");
      const cancellation = await run((platform) => platform.cancellation());
      try {
        expect(process.listenerCount("SIGINT")).toBe(before + 1);
        const execution = await run((platform) =>
          platform.worker({
            runId: crypto.randomUUID(),
            entrypoint,
            cwd: directory,
            input: {},
            stateDirectory: directory,
            quiet: true,
            signal: cancellation.signal,
          }),
        );
        expect(execution.result.outcome.code).toBe("success");
      } finally {
        cancellation.close();
      }
      expect(process.listenerCount("SIGINT")).toBe(before);
    }));
});

describe("operator run cancellation", () => {
  it("aborts on the first signal, notifies repeat listeners after it and detaches on close", () => {
    const before = interruptSignals.map((signal) => new Set(process.listeners(signal)));
    const cancellation = makeRunCancellation();
    const added = interruptSignals.flatMap((signal, index) =>
      process.listeners(signal).filter((listener) => before[index]?.has(listener) === false),
    );
    const [interrupt, terminate, hangUp] = added;
    try {
      // One listener serves every interrupt signal.
      expect(added).toHaveLength(interruptSignals.length);
      expect(new Set(added).size).toBe(1);
      const repeats: string[] = [];
      const unsubscribe = cancellation.onRepeatSignal(() => repeats.push("kept"));
      const removed = cancellation.onRepeatSignal(() => repeats.push("removed"));
      removed();
      interrupt?.("SIGINT");
      expect(cancellation.signal.aborted).toBe(true);
      expect(repeats).toEqual([]);
      terminate?.("SIGTERM");
      expect(repeats).toEqual(["kept"]);
      hangUp?.("SIGHUP");
      expect(repeats).toEqual(["kept", "kept"]);
      unsubscribe();
      interrupt?.("SIGINT");
      expect(repeats).toEqual(["kept", "kept"]);
      cancellation.onRepeatSignal(() => repeats.push("cleared"));
      cancellation.close();
      // Closing forgets every repeat listener too.
      interrupt?.("SIGINT");
      expect(repeats).toEqual(["kept", "kept"]);
    } finally {
      cancellation.close();
    }
    expect(interruptSignals.map((signal) => new Set(process.listeners(signal)))).toEqual(before);
  });
});
