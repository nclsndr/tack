import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { Effect, Layer } from "effect";
import {
  ExecutionError,
  ExecutionPlatform,
  executionError,
  type RunCancellation,
} from "../../services/execution-platform.ts";
import {
  createPendingHistory,
  finishHistory,
  listHistory,
  countHistory,
  readHistory,
  clearHistory,
  HistoryFailure,
} from "./history.ts";
import { readRunInput, InputFailure } from "./input.ts";
import { superviseWorker } from "./supervisor.ts";
import { SecretFailure } from "./secrets.ts";

const toError = (error: unknown): ExecutionError => {
  if (error instanceof ExecutionError) return error;
  if (error instanceof InputFailure)
    return executionError(error.outcome.stage, error.outcome.code, error.message);
  if (error instanceof HistoryFailure)
    return executionError("history", `history_${error.operation}_failed`, error.message);
  if (error instanceof SecretFailure) return executionError("preflight", error.code, error.message);
  return executionError(
    "worker",
    "worker_failure",
    "The execution host could not complete the run.",
  );
};
const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toError });
const inspectPackage = async (sourcePath: string, entrypoint: string): Promise<void> => {
  let manifest: unknown;
  try {
    // A source with no package.json has no dependencies: a script-API script needs none.
    manifest = JSON.parse(
      await readFile(join(sourcePath, "package.json"), "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return "{}";
        throw error;
      }),
    );
  } catch {
    throw executionError(
      "preflight",
      "package_manifest_unavailable",
      "The source must provide a readable valid package.json before execution.",
    );
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest))
    throw executionError(
      "preflight",
      "package_manifest_invalid",
      "The source package manifest must be an object.",
    );
  let canonical: string;
  try {
    canonical = await realpath(entrypoint);
  } catch {
    throw executionError(
      "preflight",
      "entrypoint_unavailable",
      "The declared entrypoint is unavailable.",
    );
  }
  const childPath = relative(sourcePath, canonical);
  if (
    entrypoint.endsWith(".ts") === false ||
    childPath === ".." ||
    childPath.startsWith("../") ||
    isAbsolute(childPath)
  )
    throw executionError(
      "preflight",
      "entrypoint_unsupported",
      "Only declared TypeScript entrypoints within the source can run.",
    );
  const dependencies = "dependencies" in manifest ? manifest.dependencies : undefined;
  if (
    dependencies !== undefined &&
    (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies))
  )
    throw executionError(
      "preflight",
      "package_manifest_invalid",
      "The source dependencies must be a package mapping.",
    );
  for (const dependency of Object.keys(dependencies ?? {})) {
    let ancestor = sourcePath;
    let found = false;
    for (;;) {
      try {
        found = (await stat(join(ancestor, "node_modules", dependency, "package.json"))).isFile();
      } catch {
        /* Continue through source package resolution ancestors. */
      }
      if (found === true || dirname(ancestor) === ancestor) break;
      ancestor = dirname(ancestor);
    }
    if (found === false)
      throw executionError(
        "preflight",
        "dependency_unavailable",
        `A declared source dependency is unavailable: ${dependency}. Install the source dependencies before running it.`,
      );
  }
};
/** Owns operator signals before asynchronous history, resolution, or preflight begins. */
export const makeRunCancellation = (): RunCancellation => {
  const controller = new AbortController();
  const repeated = new Set<() => void>();
  const interrupt = () => {
    if (controller.signal.aborted === false) controller.abort();
    else for (const listener of repeated) listener();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  return {
    signal: controller.signal,
    onRepeatSignal: (listener) => {
      repeated.add(listener);
      return () => {
        repeated.delete(listener);
      };
    },
    close: () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      repeated.clear();
    },
  };
};
/** Production adapters selected only by the CLI composition root. */
export const ExecutionPlatformLive = Layer.succeed(ExecutionPlatform, {
  cancellation: () => Effect.sync(makeRunCancellation),
  input: (request, signal) => promise(() => readRunInput(request, process.stdin, signal)),
  packageReady: (sourcePath, entrypoint) => promise(() => inspectPackage(sourcePath, entrypoint)),
  createHistory: (directory, record) => promise(() => createPendingHistory(directory, record)),
  finishHistory: (directory, record) => promise(() => finishHistory(directory, record)),
  listHistory: (directory) => promise(() => listHistory(directory)),
  countHistory: (directory) => promise(() => countHistory(directory)),
  showHistory: (directory, runId) => promise(() => readHistory(directory, runId)),
  clearHistory: (directory) => promise(() => clearHistory(directory)),
  worker: (request) => promise(() => superviseWorker(request)),
});
