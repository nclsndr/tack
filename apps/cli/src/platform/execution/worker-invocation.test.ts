import { describe, expect, it } from "vitest";
import { workerInvocation } from "./worker-invocation.ts";

const entryPoint = "/tack/apps/cli/src/main.ts";
const sidecar = "/release/worker.js";

describe("worker invocation", () => {
  it("re-runs the CLI entry point behind the hidden worker argument under Bun, refusing the caller's .env", () => {
    expect(workerInvocation({ compiled: false, runtime: "bun", entryPoint, sidecar })).toEqual({
      args: ["--no-env-file", entryPoint, "__tack-worker"],
      environment: {},
    });
  });

  it("re-runs the CLI entry point under Node with no flag, since the worker compiles TypeScript", () => {
    expect(workerInvocation({ compiled: false, runtime: "node", entryPoint, sidecar })).toEqual({
      args: [entryPoint, "__tack-worker"],
      environment: {},
    });
  });

  it("starts a compiled release's worker sidecar as Bun", () => {
    expect(workerInvocation({ compiled: true, runtime: "bun", entryPoint, sidecar })).toEqual({
      args: ["--no-env-file", sidecar],
      environment: { BUN_BE_BUN: "1" },
    });
  });

  it("starts a worker file a caller names instead of the entry point", () => {
    expect(
      workerInvocation({
        compiled: false,
        runtime: "bun",
        entryPoint,
        sidecar,
        workerPath: "/fixtures/worker.ts",
      }),
    ).toEqual({ args: ["--no-env-file", "/fixtures/worker.ts"], environment: {} });
  });
});
