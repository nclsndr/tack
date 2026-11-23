import { mutateStateFixture } from "../../../test/support/state-fixture.ts";
import { Effect, FileSystem, Path } from "effect";
import { expect, it } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { ExecutionError, ExecutionWorker, RunHistory } from "../../services/execution-platform.ts";
import { ExecutionPlatformLive } from "../../platform/execution/execution-platform.ts";
import {
  initializeState,
  StateStore,
  StateCorruptError,
  StateFormatUnsupportedError,
  StateNotInitializedError,
  type StateOptions,
} from "../../services/state-store.ts";
import { registerSource } from "../sources/source.ts";
import {
  describeScript,
  runOperatorScript,
  listScriptHistory,
  showScriptHistory,
  clearScriptHistory,
  HistoryNotFoundError,
} from "./execution.ts";
import type {
  HistoryRecord,
  OperatorRunRequest,
  OperatorRunResult,
} from "../../domain/execution/execution-schema.ts";
import type { RunCancellation, WorkerRequest } from "../../services/execution-platform.ts";

const request: OperatorRunRequest = {
  address: {
    kind: "script",
    name: "run",
    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  },
  selector: { _tag: "user" },
  quiet: true,
};
const fixture = <A, E, R>(
  use: (
    options: StateOptions & { readonly homeDirectory: string },
    root: string,
  ) => Effect.Effect<A, E, R>,
  initialize = true,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "tack-operator-test-" }),
    );
    const homeDirectory = path.join(root, "home");
    yield* fs.makeDirectory(homeDirectory);
    const options = {
      environment: { TACK_STATE_DIR: path.join(root, "state") },
      homeDirectory,
    } satisfies StateOptions;
    if (initialize === true) yield* initializeState(options);
    return yield* use(options, root);
  }).pipe(Effect.scoped, Effect.provide(ExecutionPlatformLive));
/** Registers project `demo` whose roots are real canonical directories below the fixture root. */
const registerProject = (options: StateOptions, root: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const anchor = path.join(root, "git");
    yield* fs.makeDirectory(anchor, { recursive: true });
    const roots = names.map((name) => path.join(root, name));
    yield* Effect.forEach(roots, (directory) => fs.makeDirectory(directory, { recursive: true }));
    yield* mutateStateFixture(options, (state) => ({
      ...state,
      data: {
        ...state.data,
        projects: [{ name: "demo", gitCommonDirectory: anchor, roots: [...roots].sort() }],
      },
    }));
    return roots;
  });

/** Registers a source declaring the given scripts and returns the request for its `run` script. */
const registerScripts = (options: StateOptions, root: string, scripts: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = path.join(root, "source");
    yield* fs.makeDirectory(path.join(source, "scripts"), { recursive: true });
    yield* fs.writeFileString(path.join(source, "tack.yaml"), `version: 1\nscripts:\n${scripts}`);
    yield* fs.writeFileString(path.join(source, "scripts/run.ts"), "export default 1;\n");
    yield* fs.writeFileString(path.join(source, "scripts/other.ts"), "export default 2;\n");
    const registered = yield* registerSource(options, { sourcePath: source });
    return {
      entrypoint: path.join(source, "scripts/run.ts"),
      request: {
        ...request,
        address: { ...request.address, sourceRegistrationId: registered.registration.id },
      } satisfies OperatorRunRequest,
    };
  });
const runScript = "  - name: run\n    path: scripts/run.ts\n    description: Run\n";

/** A cancellation the test controls, with no process signal handlers. */
const controlledCancellation = (controller: AbortController): RunCancellation => ({
  signal: controller.signal,
  onRepeatSignal: () => () => undefined,
  close: () => undefined,
});

it.layer(LiveTestLayer)("operator run execution", (test) => {
  test.effect(
    "a worker result is returned and recorded with its input, target and diagnostics",
    () =>
      fixture((options, root) =>
        Effect.gen(function* () {
          const live = yield* ExecutionWorker;
          const { request: run, entrypoint } = yield* registerScripts(options, root, runScript);
          const requests: Array<Omit<WorkerRequest, "signal" | "onRepeatSignal">> = [];
          const succeeded = (runId: string): OperatorRunResult => ({
            runId,
            outcome: {
              stage: "execution",
              code: "success",
              message: "Done.",
              classification: "success",
            },
            logs: [],
            logTruncation: { truncated: false, observedBytes: 0, observedEvents: 0, reasons: [] },
            finalization: "complete",
          });
          const platform = {
            ...live,
            cancellation: () => Effect.succeed(controlledCancellation(new AbortController())),
            input: () => Effect.succeed({ answer: 42 }),
            packageReady: () => Effect.void,
            worker: ({ signal: _signal, onRepeatSignal: _repeat, ...worker }: WorkerRequest) =>
              Effect.sync(() => {
                requests.push(worker);
                return { result: succeeded(worker.runId), diagnostics: { memory: 1 } };
              }),
          };
          const result = yield* runOperatorScript(options, { ...run, timeoutMs: 5000 }).pipe(
            Effect.provideService(ExecutionWorker, platform),
          );
          // Without a timeout or quiet flag, the worker request carries neither.
          const { quiet: _quiet, ...loud } = run;
          const second = yield* runOperatorScript(options, loud).pipe(
            Effect.provideService(ExecutionWorker, platform),
          );
          expect(result).toEqual(succeeded(result.runId));
          expect(requests).toEqual([
            {
              runId: result.runId,
              entrypoint,
              cwd: options.homeDirectory,
              input: { answer: 42 },
              stateDirectory: options.environment["TACK_STATE_DIR"],
              timeoutMs: 5000,
              quiet: true,
            },
            {
              runId: second.runId,
              entrypoint,
              cwd: options.homeDirectory,
              input: { answer: 42 },
              stateDirectory: options.environment["TACK_STATE_DIR"],
            },
          ]);
          expect(yield* showScriptHistory(options, result.runId)).toMatchObject({
            status: "complete",
            originalInput: { answer: 42 },
            target: { canonicalPath: options.homeDirectory },
            diagnostics: { memory: 1 },
            result: { outcome: { code: "success" } },
          });
        }),
      ),
  );

  test.effect("records the words a run was given in place of its JSON input", () =>
    fixture((options, root) =>
      Effect.gen(function* () {
        const live = yield* ExecutionWorker;
        const { request: run } = yield* registerScripts(options, root, runScript);
        const words: Array<ReadonlyArray<string> | undefined> = [];
        const platform = {
          ...live,
          packageReady: () => Effect.void,
          worker: (worker: WorkerRequest) =>
            Effect.sync(() => {
              words.push(worker.words);
              return {
                result: {
                  runId: worker.runId,
                  outcome: {
                    stage: "execution" as const,
                    code: "success",
                    message: "Done.",
                    classification: "success" as const,
                  },
                  logs: [],
                  logTruncation: {
                    truncated: false,
                    observedBytes: 0,
                    observedEvents: 0,
                    reasons: [],
                  },
                  finalization: "complete" as const,
                },
              };
            }),
        };
        const result = yield* runOperatorScript(options, { ...run, words: ["--name", "Ada"] }).pipe(
          Effect.provideService(ExecutionWorker, platform),
        );
        expect(words).toEqual([["--name", "Ada"]]);
        const record = yield* showScriptHistory(options, result.runId);
        expect(record).toMatchObject({ originalWords: ["--name", "Ada"] });
        expect(record).not.toHaveProperty("originalInput");
      }),
    ),
  );

  test.effect(
    "describes a declared script with its catalog facts, or fails as its worker did",
    () =>
      fixture((options, root) =>
        Effect.gen(function* () {
          const live = yield* ExecutionWorker;
          const { request: run, entrypoint } = yield* registerScripts(options, root, runScript);
          const requests: Array<Omit<WorkerRequest, "signal" | "onRepeatSignal">> = [];
          const refusal = {
            stage: "preflight" as const,
            code: "invalid_definition",
            message: "Rewrite it.",
            classification: "invalid-configuration" as const,
          };
          const platform = (described: boolean) => ({
            ...live,
            packageReady: () => Effect.void,
            worker: ({ signal: _signal, onRepeatSignal: _repeat, ...worker }: WorkerRequest) =>
              Effect.sync(() => {
                requests.push(worker);
                return {
                  result: {
                    runId: worker.runId,
                    outcome: refusal,
                    logs: [],
                    logTruncation: {
                      truncated: false,
                      observedBytes: 0,
                      observedEvents: 0,
                      reasons: [],
                    },
                    finalization: "not-started" as const,
                  },
                  ...(described
                    ? {
                        described: {
                          args: {
                            name: { type: "string" as const },
                            dry: { type: "boolean" as const },
                          },
                          secrets: ["TOKEN"],
                        },
                      }
                    : {}),
                };
              }),
          });
          const shown = yield* describeScript(options, run.address).pipe(
            Effect.provideService(ExecutionWorker, platform(true)),
          );
          expect(shown).toMatchObject({
            address: run.address,
            description: "Run",
            filePath: entrypoint,
            arguments: [
              { name: "name", type: "string" },
              { name: "dry", type: "boolean" },
            ],
            secrets: ["TOKEN"],
          });
          expect(requests[0]).toMatchObject({ describe: true, input: {}, quiet: true });
          const failed = yield* Effect.flip(
            describeScript(options, run.address).pipe(
              Effect.provideService(ExecutionWorker, platform(false)),
            ),
          );
          expect(failed).toMatchObject({ code: "invalid_definition", stage: "preflight" });
        }),
      ),
  );

  test.effect("an interruption before or after the package check runs no worker", () =>
    fixture((options, root) =>
      Effect.gen(function* () {
        const live = yield* ExecutionWorker;
        const { request: run } = yield* registerScripts(options, root, runScript);
        let workers = 0;
        const attempt = (abortAt: "start" | "package") =>
          Effect.gen(function* () {
            const controller = new AbortController();
            if (abortAt === "start") controller.abort();
            return yield* runOperatorScript(options, run).pipe(
              Effect.provideService(ExecutionWorker, {
                ...live,
                cancellation: () => Effect.succeed(controlledCancellation(controller)),
                input: () => Effect.succeed({}),
                packageReady: () => Effect.sync(() => controller.abort()),
                worker: () =>
                  Effect.sync(() => {
                    workers += 1;
                    throw new Error("A worker must not start.");
                  }),
              }),
            );
          });
        for (const abortAt of ["start", "package"] as const)
          expect((yield* attempt(abortAt)).outcome).toMatchObject({
            stage: "execution",
            code: "interrupted",
            classification: "interruption",
          });
        expect(workers).toBe(0);
      }),
    ),
  );

  test.effect("conflicting targets and an invalid timeout are refused before any input", () =>
    fixture((options) =>
      Effect.gen(function* () {
        const conflict = yield* runOperatorScript(options, { ...request, targetConflict: true });
        expect(conflict.outcome).toMatchObject({
          stage: "invocation",
          code: "run_targets_conflict",
          classification: "invalid-invocation",
        });
        for (const timeoutMs of [0, -5, 1.5, Number.POSITIVE_INFINITY, Number.NaN])
          expect(
            (yield* runOperatorScript(options, { ...request, timeoutMs })).outcome.code,
            String(timeoutMs),
          ).toBe("timeout_invalid");
      }),
    ),
  );

  test.effect("a script address one source declares twice is ambiguous", () =>
    fixture((options, root) =>
      Effect.gen(function* () {
        const { request: run } = yield* registerScripts(
          options,
          root,
          `${runScript}${runScript.replace("scripts/run.ts", "scripts/other.ts")}`,
        );
        const result = yield* runOperatorScript(options, run);
        expect(result.outcome).toMatchObject({
          stage: "resolution",
          code: "script_address_ambiguous",
        });
      }),
    ),
  );

  test.effect("a state file from a newer release fails resolution without naming it", () =>
    fixture((options) =>
      Effect.gen(function* () {
        const store = yield* StateStore;
        const result = yield* runOperatorScript(options, request).pipe(
          Effect.provideService(StateStore, {
            ...store,
            read: () =>
              Effect.fail(new StateFormatUnsupportedError({ foundFormat: 99, statePath: "/safe" })),
          }),
        );
        expect(result.outcome).toEqual({
          stage: "resolution",
          code: "run_resolution_failed",
          message: "The script or target could not be resolved from initialized Tack state.",
          classification: "invalid-configuration",
        });
      }),
    ),
  );
});

it.layer(LiveTestLayer)("operator attempt lifetime", (test) => {
  test.effect(
    "initial history failure prevents every later input, resolution, and worker call",
    () =>
      fixture((options) =>
        Effect.gen(function* () {
          const live = yield* ExecutionWorker;
          const history = yield* RunHistory;
          let touched = false;
          const result = yield* runOperatorScript(options, request).pipe(
            Effect.provideService(RunHistory, {
              ...history,
              createHistory: () =>
                Effect.fail(
                  new ExecutionError({
                    stage: "history",
                    code: "history_create_failed",
                    message: "Cannot create history.",
                    classification: "persistence",
                  }),
                ),
            }),
            Effect.provideService(ExecutionWorker, {
              ...live,
              input: () =>
                Effect.sync(() => {
                  touched = true;
                  return {};
                }),
              worker: () =>
                Effect.sync(() => {
                  touched = true;
                  throw new Error("Worker must not start.");
                }),
            }),
          );
          expect(result.outcome.code).toBe("history_create_failed");
          expect(touched).toBe(false);
        }),
      ),
  );
  test.effect("stamps the run record's start and finish from the Effect clock", () =>
    fixture((options) =>
      Effect.gen(function* () {
        const live = yield* ExecutionWorker;
        yield* TestClock.setTime(Date.UTC(2026, 0, 2, 3, 4, 5));
        const result = yield* runOperatorScript(options, request).pipe(
          Effect.provideService(ExecutionWorker, {
            ...live,
            // Reading the input takes 90 seconds of test time between the two stamps.
            input: () => TestClock.adjust("90 seconds").pipe(Effect.as({})),
          }),
        );
        expect(yield* showScriptHistory(options, result.runId)).toMatchObject({
          status: "complete",
          startedAt: "2026-01-02T03:04:05.000Z",
          finishedAt: "2026-01-02T03:05:35.000Z",
        });
      }),
    ),
  );
  test.effect(
    "conflicting input sources and unresolved scripts still finish durable attempts",
    () =>
      fixture((options) =>
        Effect.gen(function* () {
          const conflict = yield* runOperatorScript(options, {
            ...request,
            inputJson: "{}",
            inputStdin: true,
          });
          expect(conflict.outcome.code).toBe("input_sources_conflict");
          const missing = yield* runOperatorScript(options, request);
          expect(missing.outcome.code).toBe("script_not_found");
          const history = yield* listScriptHistory(options);
          expect(history).toMatchObject({ total: 2, offset: 0, limit: 20, truncated: false });
          expect(
            history.runs
              .map((run) => String(run.outcome?.code))
              .sort((left, right) => left.localeCompare(right)),
          ).toEqual(["input_sources_conflict", "script_not_found"]);
          expect(history.runs.every((run) => run.status === "complete")).toBe(true);
          expect(yield* clearScriptHistory(options)).toEqual({
            plan: { kind: "history-clear-plan", count: 2 },
          });
          expect((yield* listScriptHistory(options)).runs).toHaveLength(2);
          expect(yield* clearScriptHistory(options, true)).toEqual({
            plan: { kind: "history-clear-plan", count: 2 },
            applied: { kind: "history-clear-application", removedCount: 2 },
          });
          expect(yield* listScriptHistory(options)).toEqual({
            runs: [],
            total: 0,
            offset: 0,
            limit: 20,
            truncated: false,
            issues: [],
          });
        }),
      ),
  );
  test.effect("terminal write failure keeps completed safe outcome and the pending record", () =>
    fixture((options) =>
      Effect.gen(function* () {
        const live = yield* RunHistory;
        const result = yield* runOperatorScript(options, request).pipe(
          Effect.provideService(RunHistory, {
            ...live,
            finishHistory: () =>
              Effect.fail(
                new ExecutionError({
                  stage: "history",
                  code: "history_finish_failed",
                  message: "Cannot finish history.",
                  classification: "persistence",
                }),
              ),
          }),
        );
        expect(result.outcome).toMatchObject({
          code: "history_finish_failed",
          classification: "persistence",
          details: { runOutcome: { code: "script_not_found" } },
        });
        expect((yield* listScriptHistory(options)).runs[0]?.status).toBe("pending");
      }),
    ),
  );
  test.effect(
    "state corruption retains persistence classification and source package failure prevents import",
    () =>
      fixture((options, root) =>
        Effect.gen(function* () {
          const store = yield* StateStore;
          const result = yield* runOperatorScript(options, request).pipe(
            Effect.provideService(StateStore, {
              ...store,
              read: () =>
                Effect.fail(new StateCorruptError({ message: "bad", statePath: "/safe" })),
            }),
          );
          expect(result.outcome.classification).toBe("persistence");
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const source = path.join(root, "source");
          yield* fs.makeDirectory(path.join(source, "scripts"), { recursive: true });
          yield* fs.writeFileString(
            path.join(source, "tack.yaml"),
            "version: 1\nscripts:\n  - name: run\n    path: scripts/run.ts\n    description: Probe\n",
          );
          const probe = path.join(root, "imported");
          yield* fs.writeFileString(path.join(source, "package.json"), "{ not json");
          yield* fs.writeFileString(
            path.join(source, "scripts/run.ts"),
            `await Bun.write(${JSON.stringify(probe)}, "imported");`,
          );
          const registered = yield* registerSource(options, { sourcePath: source });
          const refused = yield* runOperatorScript(options, {
            ...request,
            address: { ...request.address, sourceRegistrationId: registered.registration.id },
          });
          expect(refused.outcome.code).toBe("package_manifest_unavailable");
          expect(yield* fs.exists(probe)).toBe(false);
        }),
      ),
  );
  test.effect("history pages newest-first summaries with offset, limit and runId tie-breaks", () =>
    fixture((options) =>
      Effect.gen(function* () {
        const platform = yield* RunHistory;
        const stateDirectory = options.environment["TACK_STATE_DIR"] ?? "";
        const records: HistoryRecord[] = Array.from({ length: 35 }, (_, index) => ({
          version: 1,
          runId: crypto.randomUUID(),
          status: "pending",
          // Pairs of runs share a start time so the runId tie-break decides their order.
          startedAt: new Date(Date.UTC(2026, 0, 1, 0, Math.floor(index / 2))).toISOString(),
          address: request.address,
        }));
        yield* Effect.forEach(records, (record) => platform.createHistory(stateDirectory, record));
        const newestFirst = records
          .map((record) => record.runId)
          .sort((left, right) => {
            const startedAt = (runId: string) =>
              records.find((record) => record.runId === runId)?.startedAt ?? "";
            return startedAt(right).localeCompare(startedAt(left)) || (right < left ? -1 : 1);
          });
        const first = yield* listScriptHistory(options);
        expect(first).toMatchObject({ total: 35, offset: 0, limit: 20, truncated: true });
        expect(first.runs.map((run) => run.runId)).toEqual(newestFirst.slice(0, 20));
        expect(first.runs[0]).toEqual({
          runId: newestFirst[0],
          status: "pending",
          address: request.address,
          startedAt: "2026-01-01T00:17:00.000Z",
        });
        const rest = yield* listScriptHistory(options, { offset: 20 });
        expect(rest).toMatchObject({ total: 35, offset: 20, limit: 20, truncated: false });
        expect(rest.runs.map((run) => run.runId)).toEqual(newestFirst.slice(20));
        const exact = yield* listScriptHistory(options, { offset: 5, limit: 30 });
        expect(exact).toMatchObject({ total: 35, truncated: false });
        expect(exact.runs).toHaveLength(30);
        expect(yield* listScriptHistory(options, { offset: 40, limit: 100 })).toEqual({
          runs: [],
          total: 35,
          offset: 40,
          limit: 100,
          truncated: false,
          issues: [],
        });
      }),
    ),
  );
  test.effect(
    "one corrupt record is skipped with an issue while valid runs list, and clear --apply removes it",
    () =>
      fixture((options) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const platform = yield* RunHistory;
          const stateDirectory = options.environment["TACK_STATE_DIR"] ?? "";
          const valid: HistoryRecord = {
            version: 1,
            runId: crypto.randomUUID(),
            status: "pending",
            startedAt: "2026-01-01T00:00:00.000Z",
            address: request.address,
          };
          yield* platform.createHistory(stateDirectory, valid);
          const corrupt = path.join(stateDirectory, "history", `${crypto.randomUUID()}.json`);
          yield* fs.writeFileString(corrupt, '{"version":1,');
          expect(yield* listScriptHistory(options)).toEqual({
            runs: [
              {
                runId: valid.runId,
                status: "pending",
                address: request.address,
                startedAt: valid.startedAt,
              },
            ],
            total: 1,
            offset: 0,
            limit: 20,
            truncated: false,
            issues: [{ path: corrupt, reason: "invalid" }],
          });
          expect(yield* clearScriptHistory(options)).toEqual({
            plan: { kind: "history-clear-plan", count: 2 },
          });
          expect(yield* clearScriptHistory(options, true)).toEqual({
            plan: { kind: "history-clear-plan", count: 2 },
            applied: { kind: "history-clear-application", removedCount: 2 },
          });
          expect(yield* fs.exists(corrupt)).toBe(false);
          expect(yield* listScriptHistory(options)).toMatchObject({ runs: [], issues: [] });
        }),
      ),
  );
  test.effect("skipped record files are reported in path order", () =>
    fixture((options) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const history = path.join(options.environment["TACK_STATE_DIR"] ?? "", "history");
        yield* fs.makeDirectory(history, { recursive: true });
        const later = path.join(history, "00000000-0000-4000-8000-00000000000b.json");
        const earlier = path.join(history, "00000000-0000-4000-8000-00000000000a.json");
        for (const file of [later, earlier]) yield* fs.writeFileString(file, "{");
        expect((yield* listScriptHistory(options)).issues).toEqual([
          { path: earlier, reason: "invalid" },
          { path: later, reason: "invalid" },
        ]);
      }),
    ),
  );
  test.effect("history show distinguishes a missing run from a retained one", () =>
    fixture((options) =>
      Effect.gen(function* () {
        const platform = yield* RunHistory;
        const stateDirectory = options.environment["TACK_STATE_DIR"] ?? "";
        const record: HistoryRecord = {
          version: 1,
          runId: crypto.randomUUID(),
          status: "pending",
          startedAt: "2026-01-01T00:00:00.000Z",
          address: request.address,
        };
        yield* platform.createHistory(stateDirectory, record);
        expect(yield* showScriptHistory(options, record.runId)).toEqual(record);
        const missing = crypto.randomUUID();
        const failure = yield* Effect.flip(showScriptHistory(options, missing));
        expect(failure).toBeInstanceOf(HistoryNotFoundError);
        expect(failure).toMatchObject({ runId: missing });
      }),
    ),
  );
  test.effect("history commands refuse uninitialized state without creating files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tack-operator-test-" });
      const options = {
        environment: { TACK_STATE_DIR: path.join(root, "state") },
        homeDirectory: root,
      } satisfies StateOptions;
      const refusals = [
        yield* Effect.flip(listScriptHistory(options)),
        yield* Effect.flip(showScriptHistory(options, crypto.randomUUID())),
        yield* Effect.flip(clearScriptHistory(options)),
        yield* Effect.flip(clearScriptHistory(options, true)),
      ];
      for (const refusal of refusals) expect(refusal).toBeInstanceOf(StateNotInitializedError);
      expect(yield* fs.exists(path.join(root, "state"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(ExecutionPlatformLive)),
  );
  test.effect("an uninitialized state directory refuses the run without creating any files", () =>
    fixture(
      (options, root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const result = yield* runOperatorScript(options, request);
          expect(result.outcome).toEqual({
            stage: "resolution",
            code: "state_not_initialized",
            message: expect.stringContaining("tack state init"),
            classification: "invalid-configuration",
            details: { stateDirectory: path.join(root, "state") },
          });
          expect(result.finalization).toBe("not-started");
          expect(yield* fs.exists(path.join(root, "state"))).toBe(false);
        }),
      false,
    ),
  );
  test.effect("an unregistered project names the project", () =>
    fixture((options) =>
      Effect.gen(function* () {
        const result = yield* runOperatorScript(options, {
          ...request,
          selector: { _tag: "project", projectName: "ghost" },
        });
        expect(result.outcome).toMatchObject({
          stage: "resolution",
          code: "run_project_not_registered",
          classification: "invalid-configuration",
          details: { projectName: "ghost" },
        });
        expect(result.outcome.message).toContain("ghost");
        expect(result.outcome.message).toContain("tack project");
      }),
    ),
  );
  test.effect("a bare run outside registered roots names the directory and every target flag", () =>
    fixture((options, root) =>
      Effect.gen(function* () {
        yield* registerProject(options, root, ["first"]);
        const outside = yield* runOperatorScript(options, {
          ...request,
          selector: { _tag: "bare" },
          cwd: options.homeDirectory,
        });
        expect(outside.outcome).toMatchObject({
          stage: "resolution",
          code: "run_cwd_not_registered",
          classification: "invalid-configuration",
          details: { cwd: options.homeDirectory },
        });
        for (const flag of ["--project", "--root", "--user"])
          expect(outside.outcome.message).toContain(flag);
        const missing = yield* runOperatorScript(options, {
          ...request,
          selector: { _tag: "bare" },
          cwd: `${root}/missing`,
        });
        expect(missing.outcome).toMatchObject({
          stage: "resolution",
          code: "run_cwd_unavailable",
          classification: "invalid-configuration",
          details: { cwd: `${root}/missing` },
        });
      }),
    ),
  );
  test.effect("an explicit root reports whether it is unregistered, unavailable, or nested", () =>
    fixture((options, root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const [first = ""] = yield* registerProject(options, root, ["first"]);
        const outside = yield* runOperatorScript(options, {
          ...request,
          selector: { _tag: "bare" },
          root: options.homeDirectory,
        });
        expect(outside.outcome).toMatchObject({
          stage: "resolution",
          code: "run_root_not_registered",
          classification: "invalid-configuration",
          details: { root: options.homeDirectory },
        });
        expect(outside.outcome.details).not.toHaveProperty("containingRoot");
        expect(outside.outcome.message).toContain("tack project");
        const unavailable = yield* runOperatorScript(options, {
          ...request,
          selector: { _tag: "bare" },
          root: `${root}/missing`,
        });
        expect(unavailable.outcome).toMatchObject({
          stage: "resolution",
          code: "run_root_unavailable",
          classification: "invalid-configuration",
          details: { root: `${root}/missing` },
        });
        const nested = `${first}/nested`;
        yield* fs.makeDirectory(nested);
        const inside = yield* runOperatorScript(options, {
          ...request,
          selector: { _tag: "bare" },
          root: nested,
        });
        expect(inside.outcome).toMatchObject({
          code: "run_root_not_registered",
          details: { root: nested, containingRoot: first },
        });
        expect(inside.outcome.message).toContain(`Use --root ${first}`);
        const exact = yield* runOperatorScript(options, {
          ...request,
          selector: { _tag: "bare" },
          root: first,
          cwd: options.homeDirectory,
        });
        expect(exact.outcome.code).toBe("script_not_found");
      }),
    ),
  );
  test.effect("a project with several roots lists them and suggests --root", () =>
    fixture((options, root) =>
      Effect.gen(function* () {
        const roots = yield* registerProject(options, root, ["third", "first", "second"]);
        const result = yield* runOperatorScript(options, {
          ...request,
          selector: { _tag: "project", projectName: "demo" },
        });
        expect(result.outcome).toMatchObject({
          stage: "resolution",
          code: "run_target_not_unique",
          classification: "invalid-configuration",
          details: { projectName: "demo", roots: [...roots].sort() },
        });
        expect(result.outcome.message).toContain("--root <path>");
      }),
    ),
  );
  test.effect("a project without an available root reports the unavailable target", () =>
    fixture((options, root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const [only = ""] = yield* registerProject(options, root, ["only"]);
        yield* fs.remove(only, { recursive: true });
        const result = yield* runOperatorScript(options, {
          ...request,
          selector: { _tag: "project", projectName: "demo" },
        });
        expect(result.outcome).toMatchObject({
          stage: "resolution",
          code: "run_target_unavailable",
          classification: "invalid-configuration",
          details: { projectName: "demo" },
        });
        expect(result.outcome.message).toContain("tack project");
      }),
    ),
  );
  test.effect("a bare run whose containing root is the home directory selects that root", () =>
    fixture((options, root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const [home = ""] = yield* registerProject(options, root, ["home"]);
        expect(home).toBe(options.homeDirectory);
        const nested = path.join(home, "nested");
        yield* fs.makeDirectory(nested);
        for (const selection of [{ cwd: nested }, { root: home }]) {
          const result = yield* runOperatorScript(options, {
            ...request,
            selector: { _tag: "bare" },
            ...selection,
          });
          expect(result.outcome.code).toBe("script_not_found");
        }
      }),
    ),
  );
});
