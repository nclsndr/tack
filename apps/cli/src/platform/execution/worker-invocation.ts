import { workerCommand } from "../../release.ts";

/** The JavaScript runtime that runs Tack, as far as starting a worker is concerned. */
export type WorkerRuntime = "bun" | "node";

/** The runtime of this process. */
export const currentRuntime = (): WorkerRuntime =>
  process.versions.bun !== undefined ? "bun" : "node";

/**
 * Runtime flags for the worker. Bun would otherwise load the `.env` of the caller's directory. Node
 * needs none: the worker's load hook compiles scripts' TypeScript itself on every supported version.
 */
const runtimeFlags = {
  bun: ["--no-env-file"],
  node: [],
} as const satisfies Record<WorkerRuntime, ReadonlyArray<string>>;

/**
 * How the supervisor starts a worker with `process.execPath`. A compiled release starts its worker
 * sidecar as Bun. Any other Tack re-runs its own entry point behind the hidden worker argument, so
 * nothing ships beside it. A caller may name a worker file instead, which tests use for fakes.
 */
export const workerInvocation = (options: {
  readonly compiled: boolean;
  readonly runtime: WorkerRuntime;
  readonly entryPoint: string;
  readonly sidecar: string;
  readonly workerPath?: string;
}): { readonly args: ReadonlyArray<string>; readonly environment: Record<string, string> } =>
  options.compiled === true
    ? { args: ["--no-env-file", options.sidecar], environment: { BUN_BE_BUN: "1" } }
    : {
        args: [
          ...runtimeFlags[options.runtime],
          ...(options.workerPath === undefined
            ? [options.entryPoint, workerCommand]
            : [options.workerPath]),
        ],
        environment: {},
      };
