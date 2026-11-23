import { DateTime, Effect, Path, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import {
  ExecutionPlatform,
  ExecutionError,
  executionError,
  executionFailureOutcome,
} from "../../services/execution-platform.ts";
import { resolveStateDirectory, type StateOptions } from "../../services/state-store.ts";
import { type State } from "../../domain/state/state-schema.ts";
import { readInvocationSnapshot, resolveInvocationCatalog } from "../snapshot/command-snapshot.ts";
import { isEntryOfKind, resourceAddressIdentity } from "../../domain/sources/catalog-schema.ts";
import { resolveContainingRoot, selectTargets } from "../projects/project.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import {
  runFailure,
  historyListBounds,
  type HistoryList,
  type HistoryRecord,
  type HistorySummary,
  type OperatorRunRequest,
  type OperatorRunResult,
  type RunFailure,
  type RunTarget,
} from "../../domain/execution/execution-schema.ts";

const emptyResult = (runId: string, outcome: RunFailure): OperatorRunResult => ({
  runId,
  outcome,
  logs: [],
  logTruncation: { truncated: false, observedBytes: 0, observedEvents: 0, reasons: [] },
  finalization: "not-started",
});
const safeFailure = (error: unknown): RunFailure => {
  if (error instanceof ExecutionError) return executionFailureOutcome(error);
  const tag =
    typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;
  if (
    tag === "StateCorruptError" ||
    tag === "StateStorageError" ||
    tag === "StateMutationError" ||
    tag === "ProjectStorageError"
  )
    return runFailure(
      "resolution",
      "state_storage_failed",
      "Tack could not safely read persisted run configuration.",
    );
  if (tag === "StateBusyError")
    return runFailure("resolution", "state_busy", "Another command owns the state writer lock.");
  return runFailure(
    "resolution",
    "run_resolution_failed",
    "The script or target could not be resolved from initialized Tack state.",
  );
};

const inspectHint = "Run `tack project` to list registered projects and roots.";
const targetFlags = "Choose a target with --project <name>, --root <path>, or --user.";

/**
 * Resolves the one target a run executes in. A bare run, with or without `--root`, uses the
 * deepest active registered root containing the lookup directory; `--root` must name that root
 * exactly. Each refusal names the input to change and carries it in `details`.
 */
const resolveRunTarget = Effect.fnUntraced(function* (
  state: State,
  stateOptions: StateOptions,
  request: OperatorRunRequest,
) {
  const path = yield* Path.Path;
  const selector = request.selector;
  if (selector._tag !== "bare") {
    const projectName = selector._tag === "project" ? selector.projectName : undefined;
    const selection = yield* selectTargets(state, stateOptions, {
      cwd: path.resolve("."),
      selector,
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "ProjectNotFoundError"
          ? executionError(
              "resolution",
              "run_project_not_registered",
              `Project "${error.projectName}" is not registered. ${inspectHint}`,
              { projectName: error.projectName },
            )
          : error,
      ),
    );
    const targets = selection.targets.filter((candidate) => candidate._tag !== "pending-removal");
    const scope = projectName === undefined ? "The run target" : `Project "${projectName}"`;
    const projectDetails = projectName === undefined ? {} : { projectName };
    const [selected] = targets;
    if (selected === undefined)
      return yield* executionError(
        "resolution",
        "run_target_unavailable",
        `${scope} has no active registered root available for a run. ${inspectHint}`,
        projectDetails,
      );
    if (targets.length !== 1)
      return yield* executionError(
        "resolution",
        "run_target_not_unique",
        `${scope} has ${targets.length} active registered roots. Choose one with --root <path>.`,
        { ...projectDetails, roots: targets.map((candidate) => candidate.canonicalPath) },
      );
    return selected;
  }
  const explicit = request.root !== undefined;
  const lookup = path.resolve(request.root ?? request.cwd ?? ".");
  const { canonicalCwd, containing } = yield* resolveContainingRoot(state, lookup).pipe(
    Effect.mapError((error) => {
      if (error._tag !== "TargetSelectionError") return error;
      return explicit === true
        ? executionError(
            "resolution",
            "run_root_unavailable",
            `The --root path is not an accessible directory. ${inspectHint}`,
            { root: lookup },
          )
        : executionError(
            "resolution",
            "run_cwd_unavailable",
            `The current directory (or --cwd) is not an accessible directory. ${targetFlags}`,
            { cwd: lookup },
          );
    }),
  );
  if (containing === undefined)
    return yield* explicit === true
      ? executionError(
          "resolution",
          "run_root_not_registered",
          `The --root path is not a registered active project root. ${inspectHint}`,
          { root: lookup },
        )
      : executionError(
          "resolution",
          "run_cwd_not_registered",
          `The current directory (or --cwd) is not inside an active registered project root. ${targetFlags}`,
          { cwd: lookup },
        );
  if (explicit === true && canonicalCwd !== containing.root)
    return yield* executionError(
      "resolution",
      "run_root_not_registered",
      `The --root path is inside registered root ${containing.root} but is not itself a registered root. Use --root ${containing.root}.`,
      { root: lookup, containingRoot: containing.root },
    );
  return {
    _tag: "project-root",
    canonicalPath: containing.root,
    projectName: containing.projectName,
  } satisfies RunTarget;
});

/**
 * The one healthy catalog entry declaring an exact script address, once its source's declared
 * dependencies are installed.
 */
const declaredScript = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  address: OperatorRunRequest["address"],
) {
  const platform = yield* ExecutionPlatform;
  const catalog = yield* resolveInvocationCatalog(stateOptions);
  const identity = resourceAddressIdentity(address);
  const duplicates = catalog.quarantined.some(
    (entry) =>
      entry.address !== undefined &&
      resourceAddressIdentity(entry.address) === identity &&
      entry.code === "resource-address-duplicate",
  );
  if (duplicates === true)
    return yield* executionError(
      "resolution",
      "script_address_ambiguous",
      "More than one source declares the exact script address.",
    );
  const entries = catalog.entries
    .filter((entry) => isEntryOfKind(entry, "script"))
    .filter((entry) => resourceAddressIdentity(entry.address) === identity);
  const entry = entries.length === 1 ? entries[0] : undefined;
  if (entry === undefined)
    return yield* executionError(
      "resolution",
      "script_not_found",
      "The exact declared script address is unavailable or quarantined.",
    );
  yield* platform.packageReady(entry.sourcePath, entry.filePath);
  return entry;
});

/**
 * Runs one exact declared script for one target. State is read first so an uninitialized state
 * directory is refused without creating files; every other attempt records intent before
 * resolution or executable work.
 */
const runWithCancellation = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  request: OperatorRunRequest,
  cancellation: import("../../services/execution-platform.ts").RunCancellation,
) {
  const platform = yield* ExecutionPlatform;
  const random = yield* SecureRandom.SecureRandom;
  const runId = yield* random.uuidV4();
  const stateDirectory = yield* resolveStateDirectory(stateOptions);
  const observedState = yield* readInvocationSnapshot(stateOptions).pipe(
    Effect.map((snapshot) => snapshot.state),
    Effect.result,
  );
  if (observedState._tag === "Failure" && observedState.failure._tag === "StateNotInitializedError")
    return emptyResult(
      runId,
      runFailure(
        "resolution",
        "state_not_initialized",
        "Tack is not initialized in the selected state directory. Run `tack state init` first, or check --state-dir and TACK_STATE_DIR.",
        { stateDirectory },
      ),
    );
  const pending: HistoryRecord = {
    version: 1,
    runId,
    status: "pending",
    startedAt: DateTime.formatIso(yield* DateTime.now),
    address: request.address,
  };
  const initial = yield* platform.createHistory(stateDirectory, pending).pipe(Effect.result);
  if (initial._tag === "Failure")
    return emptyResult(runId, executionFailureOutcome(initial.failure));
  let originalInput: Schema.Json | undefined;
  let target: Schema.Json | undefined;
  let diagnostics: Schema.Json | undefined;
  const interrupted = () => cancellation.signal.aborted;
  const attempt = yield* Effect.gen(function* () {
    if (interrupted() === true)
      return emptyResult(
        runId,
        runFailure("execution", "interrupted", "The run was interrupted before executable work."),
      );
    if (request.targetConflict === true)
      return yield* executionError(
        "invocation",
        "run_targets_conflict",
        "Choose exactly one run target.",
      );
    if (
      request.timeoutMs !== undefined &&
      (Number.isFinite(request.timeoutMs) === false ||
        Number.isInteger(request.timeoutMs) === false ||
        request.timeoutMs <= 0)
    )
      return yield* executionError(
        "invocation",
        "timeout_invalid",
        "The run timeout must be a positive duration.",
      );
    originalInput = yield* platform.input(request, cancellation.signal);
    const selected: RunTarget = yield* resolveRunTarget(
      yield* Effect.fromResult(observedState),
      stateOptions,
      request,
    );
    target = Schema.decodeUnknownSync(Schema.Json)(selected);
    const entry = yield* declaredScript(stateOptions, request.address);
    if (interrupted() === true)
      return emptyResult(
        runId,
        runFailure("execution", "interrupted", "The run was interrupted before executable work."),
      );
    const executed = yield* platform.worker({
      signal: cancellation.signal,
      onRepeatSignal: cancellation.onRepeatSignal,
      runId,
      entrypoint: entry.filePath,
      cwd: selected.canonicalPath,
      input: originalInput,
      ...(request.words === undefined ? {} : { words: request.words }),
      stateDirectory,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.quiet === undefined ? {} : { quiet: request.quiet }),
    });
    diagnostics = executed.diagnostics;
    return executed.result;
  }).pipe(Effect.result);
  const result =
    attempt._tag === "Success" ? attempt.success : emptyResult(runId, safeFailure(attempt.failure));
  const completed: HistoryRecord = {
    ...pending,
    status: "complete",
    finishedAt: DateTime.formatIso(yield* DateTime.now),
    result,
    ...(request.words === undefined
      ? originalInput === undefined
        ? {}
        : { originalInput }
      : { originalWords: request.words }),
    ...(target === undefined ? {} : { target }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
  const persisted = yield* platform.finishHistory(stateDirectory, completed).pipe(Effect.result);
  return persisted._tag === "Success"
    ? result
    : ({
        ...result,
        outcome: {
          ...executionFailureOutcome(persisted.failure),
          details: { runOutcome: Schema.decodeUnknownSync(Schema.Json)(result.outcome) },
        },
      } satisfies OperatorRunResult);
});

/** Records and executes a run while owning operator cancellation through terminal history. */
export const runOperatorScript = Effect.fn("execution.runOperatorScript")(function* (
  stateOptions: StateOptions,
  request: OperatorRunRequest,
) {
  return yield* Effect.acquireUseRelease(
    Effect.flatMap(ExecutionPlatform, (platform) => platform.cancellation()),
    (cancellation) => runWithCancellation(stateOptions, request, cancellation),
    (cancellation) => Effect.sync(() => cancellation.close()),
  );
});

/** How long loading a script to read its declarations may take before Tack stops it. */
const describeTimeoutMs = 15_000;

/**
 * Loads one exact declared script in a fresh worker and reports what it declares: its arguments
 * and secrets, with its catalog description and file. The script's `run` never starts.
 */
export const describeScript = Effect.fn("execution.describeScript")(function* (
  stateOptions: StateOptions,
  address: OperatorRunRequest["address"],
) {
  const platform = yield* ExecutionPlatform;
  const random = yield* SecureRandom.SecureRandom;
  const stateDirectory = yield* initializedStateDirectory(stateOptions);
  const entry = yield* declaredScript(stateOptions, address);
  const runId = yield* random.uuidV4();
  const executed = yield* Effect.acquireUseRelease(
    platform.cancellation(),
    (cancellation) =>
      platform.worker({
        runId,
        entrypoint: entry.filePath,
        cwd: entry.sourcePath,
        input: {},
        describe: true,
        stateDirectory,
        timeoutMs: describeTimeoutMs,
        quiet: true,
        signal: cancellation.signal,
      }),
    (cancellation) => Effect.sync(() => cancellation.close()),
  );
  if (executed.described === undefined) {
    const { outcome } = executed.result;
    return yield* executionError(outcome.stage, outcome.code, outcome.message, outcome.details);
  }
  return {
    address: entry.address,
    description: entry.description,
    filePath: entry.filePath,
    sourcePath: entry.sourcePath,
    // A list keeps the declaration order, which the help follows.
    arguments: Object.entries(executed.described.args).map(([name, spec]) => ({ name, ...spec })),
    secrets: executed.described.secrets,
  };
});

/** A well-formed run identifier with no retained record; the caller can choose another run. */
export class HistoryNotFoundError extends Schema.TaggedError<HistoryNotFoundError>()(
  "HistoryNotFoundError",
  { runId: Schema.String },
) {}

/** Resolves history storage only for initialized state, so a mistyped state directory fails. */
const initializedStateDirectory = Effect.fnUntraced(function* (stateOptions: StateOptions) {
  yield* readInvocationSnapshot(stateOptions);
  return yield* resolveStateDirectory(stateOptions);
});

const newestFirst = (left: HistorySummary, right: HistorySummary) =>
  compareCodeUnits(right.startedAt, left.startedAt) || compareCodeUnits(right.runId, left.runId);

/**
 * Lists one newest-first page of retained run summaries without importing script modules.
 * Unreadable or invalid record files are skipped and reported as issues.
 */
export const listScriptHistory = Effect.fn("execution.listScriptHistory")(function* (
  stateOptions: StateOptions,
  page: { readonly limit?: number; readonly offset?: number } = {},
) {
  const limit = page.limit ?? historyListBounds.defaultLimit;
  const offset = page.offset ?? 0;
  const scanned = yield* (yield* ExecutionPlatform).listHistory(
    yield* initializedStateDirectory(stateOptions),
  );
  const runs = [...scanned.runs].sort(newestFirst).slice(offset, offset + limit);
  return {
    runs,
    total: scanned.runs.length,
    offset,
    limit,
    truncated: offset + runs.length < scanned.runs.length,
    issues: [...scanned.issues].sort((left, right) => compareCodeUnits(left.path, right.path)),
  } satisfies HistoryList;
});
/** Reads one retained run with bounded local diagnostic evidence. */
export const showScriptHistory = Effect.fn("execution.showScriptHistory")(function* (
  stateOptions: StateOptions,
  runId: string,
) {
  const record = yield* (yield* ExecutionPlatform).showHistory(
    yield* initializedStateDirectory(stateOptions),
    runId,
  );
  if (record === undefined) return yield* new HistoryNotFoundError({ runId });
  return record;
});
/** The `script history clear` preview: how many run records a clear would remove. */
export const HistoryClearPlanSchema = Schema.Struct({
  kind: Schema.Literal("history-clear-plan"),
  count: Schema.Number,
});

/** The `script history clear` application: how many run records it removed. */
export const HistoryClearApplicationSchema = Schema.Struct({
  kind: Schema.Literal("history-clear-application"),
  removedCount: Schema.Number,
});

/** A history clear preview, plus its application when one ran. */
type HistoryClearExecution = {
  readonly plan: typeof HistoryClearPlanSchema.Type;
  readonly applied?: typeof HistoryClearApplicationSchema.Type;
};

/** Previews the retained record count, then removes every record file when explicitly applied. */
export const clearScriptHistory = Effect.fn("execution.clearScriptHistory")(function* (
  stateOptions: StateOptions,
  apply = false,
) {
  const platform = yield* ExecutionPlatform;
  const directory = yield* initializedStateDirectory(stateOptions);
  const plan = {
    kind: HistoryClearPlanSchema.fields.kind.literal,
    count: yield* platform.countHistory(directory),
  };
  if (apply === false) return { plan } satisfies HistoryClearExecution;
  return {
    plan,
    applied: {
      kind: HistoryClearApplicationSchema.fields.kind.literal,
      removedCount: yield* platform.clearHistory(directory),
    },
  } satisfies HistoryClearExecution;
});
