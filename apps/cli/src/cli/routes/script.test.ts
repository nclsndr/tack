import { skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { mutateStateFixture, stateOptionsAt } from "../../../test/support/state-fixture.ts";
import {
  ExecutionWorker,
  RunHistory,
  type WorkerRequest,
} from "../../services/execution-platform.ts";
import { makeRunCancellation } from "../../platform/execution/execution-platform.ts";
import { initializeState } from "../../services/state-store.ts";
import { registerSource } from "../../features/sources/source.ts";
import {
  runFailure,
  summarizeHistory,
  type HistoryRecord,
  type OperatorRunResult,
} from "../../domain/execution/execution-schema.ts";
import type { Invocation } from "../commands/index.ts";
import type { PublicOutcome } from "../envelope/public-outcome.ts";
import { scriptRoutes } from "./script.ts";
import type { ForegroundSession } from "./route.ts";
import { routeOutcome } from "./route.test-support.ts";

type ScriptRun = Extract<Invocation, { readonly _tag: "script-run" }>;

const succeeded = (runId: string): OperatorRunResult => ({
  runId,
  outcome: runFailure("execution", "success", "The script finished."),
  core: { greeting: "hello" },
  logs: [],
  logTruncation: { truncated: false, observedBytes: 0, observedEvents: 0, reasons: [] },
  finalization: "complete",
});

/**
 * A state with one source declaring the script `hello` and the project `demo`, run by an in-memory
 * execution platform whose worker answers with `answer` instead of starting a process.
 */
const scene = (
  answer: (request: WorkerRequest) => OperatorRunResult = (request) => succeeded(request.runId),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "tack-run-route-" }),
    );
    const home = path.join(root, "home");
    const source = path.join(root, "tools");
    const project = path.join(root, "project");
    yield* Effect.forEach([home, source, project], (directory) =>
      fs.makeDirectory(directory, { recursive: true }),
    );
    yield* fs.writeFileString(
      path.join(source, "tack.yaml"),
      "version: 1\nname: tools\nskills: [{path: skills}]\nscripts: [{name: hello, path: hello.ts, description: Says hello}]\n",
    );
    yield* fs.writeFileString(path.join(source, "hello.ts"), "export default {};\n");
    yield* fs.makeDirectory(path.join(source, "skills", "hello"), { recursive: true });
    yield* fs.writeFileString(
      path.join(source, "skills", "hello", "SKILL.md"),
      skillText("hello", { description: "A skill that shares the script name", body: "" }),
    );
    const options = stateOptionsAt(path.join(root, "state"), home);
    yield* initializeState(options);
    yield* registerSource(options, { sourcePath: source });
    yield* mutateStateFixture(options, (state) => ({
      ...state,
      data: {
        ...state.data,
        projects: [{ name: "demo", gitCommonDirectory: path.join(root, "git"), roots: [project] }],
      },
    }));
    const history = new Map<string, HistoryRecord>();
    const workers: Array<WorkerRequest> = [];
    const runHistory = RunHistory.of({
      createHistory: (_directory, record) =>
        Effect.sync(() => void history.set(record.runId, record)),
      finishHistory: (_directory, record) =>
        Effect.sync(() => void history.set(record.runId, record)),
      listHistory: () =>
        Effect.sync(() => ({
          runs: [...history.values()].map(summarizeHistory),
          issues: [],
        })),
      countHistory: () => Effect.sync(() => history.size),
      showHistory: (_directory, runId) => Effect.sync(() => history.get(runId)),
      clearHistory: () =>
        Effect.sync(() => {
          const removed = history.size;
          history.clear();
          return removed;
        }),
    });
    const worker = ExecutionWorker.of({
      cancellation: () => Effect.sync(makeRunCancellation),
      input: () => Effect.succeed(null),
      packageReady: () => Effect.void,
      worker: (request) =>
        Effect.sync(() => {
          workers.push(request);
          return {
            result: answer(request),
            ...(request.describe === true
              ? { described: { args: { name: { type: "string" as const } }, secrets: [] } }
              : {}),
          };
        }),
    });
    const routed = <E, R>(effect: Effect.Effect<PublicOutcome | ForegroundSession, E, R>) =>
      routeOutcome(effect).pipe(
        Effect.provideService(ExecutionWorker, worker),
        Effect.provideService(RunHistory, runHistory),
      );
    const run = (invocation: ScriptRun) =>
      routed(scriptRoutes["script-run"].run(invocation, options));
    return { root, home, project, options, history, workers, run, routed };
  });

const scriptRun = (reference: string, request: Partial<ScriptRun["request"]> = {}): ScriptRun => ({
  _tag: "script-run",
  reference,
  request: { selector: { _tag: "user" }, quiet: true, ...request },
});

it.layer(LiveTestLayer)("script run route", (test) => {
  test.effect("runs the declared script for the user and records its history", () =>
    Effect.gen(function* () {
      const { home, run, history, workers } = yield* scene();
      const outcome = yield* run(scriptRun("hello"));
      expect(outcome).toMatchObject({
        classification: "success",
        diagnostics: [],
        result: { kind: "script-run", core: { greeting: "hello" } },
      });
      expect(workers.map(({ cwd }) => cwd)).toEqual([home]);
      expect([...history.values()].map(({ status }) => status)).toEqual(["complete"]);
    }),
  );

  test.effect("runs the declared script in a registered project root", () =>
    Effect.gen(function* () {
      const { project, run, workers } = yield* scene();
      const outcome = yield* run(
        scriptRun("tools:hello", { selector: { _tag: "project", projectName: "demo" } }),
      );
      expect(outcome.classification).toBe("success");
      expect(workers.map(({ cwd }) => cwd)).toEqual([project]);
    }),
  );

  test.effect("refuses a project that is not registered before resolving the script", () =>
    Effect.gen(function* () {
      const { run, history } = yield* scene();
      const error = yield* run(
        scriptRun("hello", { selector: { _tag: "project", projectName: "nope" } }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ExecutionError",
        code: "run_project_not_registered",
        details: { projectName: "nope" },
      });
      expect(history.size).toBe(0);
    }),
  );

  test.effect("suggests qualified commands that keep every target flag of the run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, options, run, workers } = yield* scene();
      const missing = yield* run(scriptRun("absent")).pipe(Effect.flip);
      expect(missing).toMatchObject({ _tag: "ResourceReferenceError", code: "resource-not-found" });

      yield* fs.makeDirectory(`${root}/more`);
      yield* fs.writeFileString(
        `${root}/more/tack.yaml`,
        "version: 1\nname: more\nscripts: [{name: hello, path: hello.ts, description: Also hello}]\n",
      );
      yield* fs.writeFileString(`${root}/more/hello.ts`, "export default {};\n");
      yield* registerSource(options, { sourcePath: `${root}/more` });
      const flags = `--project demo --root ${root}/project --cwd '${root}/a dir'`;
      const ambiguous = yield* run(
        scriptRun("hello", {
          selector: { _tag: "project", projectName: "demo" },
          root: `${root}/project`,
          cwd: `${root}/a dir`,
        }),
      ).pipe(Effect.flip);
      expect(ambiguous).toMatchObject({
        _tag: "ResourceReferenceError",
        code: "resource-ambiguous",
        candidates: [`tack script run more:hello ${flags}`, `tack script run tools:hello ${flags}`],
      });
      const user = yield* run(scriptRun("hello")).pipe(Effect.flip);
      expect(user).toMatchObject({
        candidates: ["tack script run more:hello --user", "tack script run tools:hello --user"],
      });
      expect(workers).toEqual([]);
    }),
  );

  test.effect("refuses a run result that is not valid public JSON", () =>
    Effect.gen(function* () {
      const { run } = yield* scene((request) => ({
        ...succeeded(request.runId),
        core: Number.NaN,
      }));
      const error = yield* run(scriptRun("hello")).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ExecutionError",
        stage: "worker",
        code: "run_result_invalid",
        classification: "internal",
      });
    }),
  );
});

it.layer(LiveTestLayer)("script show route", (test) => {
  test.effect("describes the declared script, not the skill that shares its name", () =>
    Effect.gen(function* () {
      const { root, options, routed, workers } = yield* scene();
      const outcome = yield* routed(
        scriptRoutes["script-show"].run({ _tag: "script-show", reference: "hello" }, options),
      );
      expect(outcome).toMatchObject({
        classification: "success",
        result: {
          kind: "script-show",
          address: { kind: "script", name: "hello" },
          description: "Says hello",
          filePath: `${root}/tools/hello.ts`,
          arguments: [{ name: "name", type: "string" }],
          secrets: [],
        },
      });
      expect(workers.map(({ describe }) => describe)).toEqual([true]);
    }),
  );
});

it.layer(LiveTestLayer)("script history routes", (test) => {
  test.effect("lists, shows and clears retained runs, removing them only on apply", () =>
    Effect.gen(function* () {
      const { options, run, routed, history } = yield* scene();
      yield* run(scriptRun("hello"));
      const [runId] = [...history.keys()];
      if (runId === undefined) throw new Error("The run left no history.");

      expect(
        yield* routed(
          scriptRoutes["script-history-list"].run(
            { _tag: "script-history-list", limit: 20, offset: 0 },
            options,
          ),
        ),
      ).toMatchObject({ classification: "success", result: { total: 1 } });
      expect(
        yield* routed(
          scriptRoutes["script-history-show"].run({ _tag: "script-history-show", runId }, options),
        ),
      ).toMatchObject({ classification: "success", result: { runId, status: "complete" } });

      const clear = scriptRoutes["script-history-clear"];
      const preview = yield* routed(
        clear.run({ _tag: "script-history-clear", apply: false }, options),
      );
      expect(preview).toMatchObject({ plan: { kind: "history-clear-plan", count: 1 } });
      expect(preview).not.toHaveProperty("applied");
      expect(history.size).toBe(1);
      expect(
        yield* routed(clear.run({ _tag: "script-history-clear", apply: true }, options)),
      ).toMatchObject({ applied: { kind: "history-clear-application", removedCount: 1 } });
      expect(history.size).toBe(0);
    }),
  );
});
