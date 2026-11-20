import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Duplex } from "node:stream";
import { Schema } from "effect";
import { EncodedRunOutcomeSchema } from "@tackup/core";
import {
  classifyRunFailure,
  executionLimits,
  runFailure,
  type OperatorRunResult,
  type RunFailure,
  type ScriptDeclarations,
} from "../../domain/execution/execution-schema.ts";
import {
  admitFrame,
  encodeFrame,
  FrameDecoder,
  ProtocolFailure,
  type Frame,
  type TerminalPayload,
  type WorkerState,
} from "./protocol.ts";
import { makeRunLogs } from "./logs.ts";
import { resolveRunOutcome } from "./run-outcome.ts";
import {
  minimalWorkerEnvironment,
  prepareSecretLookup,
  redactOwnedJson,
  SecretFailure,
} from "./secrets.ts";
import { signalCommandTree } from "./shell.ts";
import { cliEntryPoint, compiledRelease, releaseSidecar } from "../../release.ts";
import { currentRuntime, workerInvocation } from "./worker-invocation.ts";

/** Validates the encoded contract before exposing safe fields and local diagnostic evidence. */
const projectCore = (
  value: Schema.Json,
  secretValues: ReadonlyArray<string>,
  truncation: ReadonlyArray<Schema.Json> = [],
) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProtocolFailure();
  const core = Schema.decodeUnknownSync(EncodedRunOutcomeSchema, { onExcessProperty: "error" })({
    ...Object.fromEntries(Object.entries(value)),
    logs: [],
    truncation,
  });
  const primaryDiagnostics =
    core.primary.status === "failure" ? core.primary.diagnostics : undefined;
  const cleanupDiagnostics =
    core.finalization.status === "failed" ? core.finalization.diagnostics : undefined;
  const diagnostics = redactOwnedJson(
    {
      primary:
        primaryDiagnostics === undefined
          ? null
          : Schema.decodeUnknownSync(Schema.Json)(primaryDiagnostics),
      cleanup:
        cleanupDiagnostics === undefined
          ? null
          : Schema.decodeUnknownSync(Schema.Json)(cleanupDiagnostics),
    },
    secretValues,
  );
  const safePrimary =
    core.primary.status === "success"
      ? core.primary
      : {
          status: core.primary.status,
          stage: core.primary.stage,
          code: core.primary.code,
          message: core.primary.message,
          ...(core.primary.encoded === undefined ? {} : { encoded: core.primary.encoded }),
          ...(core.primary.encodedFailures === undefined
            ? {}
            : { encodedFailures: core.primary.encodedFailures }),
        };
  const safeFinalization =
    core.finalization.status === "failed"
      ? {
          status: "failed",
          failures: core.finalization.diagnostics.map((item) => ({
            kind: item.kind,
            message: "A cleanup action failed.",
          })),
        }
      : core.finalization;
  const safe = Schema.decodeUnknownSync(Schema.Json)({
    status: core.status,
    stage: core.stage,
    code: core.code,
    primary: safePrimary,
    finalization: safeFinalization,
    truncation: core.truncation,
    ...(core.encodedInput === undefined ? {} : { encodedInput: core.encodedInput }),
  });
  return {
    safe,
    diagnostics,
    outcome: {
      stage: core.stage,
      code: core.code,
      message:
        core.code === "success"
          ? "The script completed."
          : core.primary.status === "failure"
            ? core.primary.message
            : "The script did not complete successfully.",
      classification: classifyRunFailure(core.stage, core.code),
    } satisfies RunFailure,
    finalization:
      core.finalization.status === "not_started" ? ("not-started" as const) : ("complete" as const),
  };
};

/** One supervised worker owns execution; this host boundary owns signals, pipes, logs, and escalation. */
export const superviseWorker = async (options: {
  readonly runId: string;
  readonly entrypoint: string;
  readonly cwd: string;
  readonly input: Schema.Json;
  readonly words?: ReadonlyArray<string>;
  /** Load the script and report what it declares instead of running it. */
  readonly describe?: true;
  readonly stateDirectory: string;
  readonly timeoutMs?: number;
  /**
   * Arms the run deadline and returns its canceller. The default is a wall-clock timer started when
   * the worker is spawned; tests substitute a latch so the deadline fires only once the script runs.
   */
  readonly scheduleDeadline?: (fire: () => void, ms: number) => () => void;
  readonly quiet?: boolean;
  /** The caller's cancellation; the supervisor registers no process signal handlers itself. */
  readonly signal: AbortSignal;
  readonly onRepeatSignal?: (listener: () => void) => () => void;
  readonly environment?: NodeJS.ProcessEnv;
  readonly workerPath?: string;
  readonly graceMs?: number;
  readonly mirror?: (content: string) => void;
}): Promise<{
  readonly result: OperatorRunResult;
  readonly diagnostics?: Schema.Json;
  readonly described?: ScriptDeclarations;
}> => {
  const logs = makeRunLogs(
    options.quiet === true
      ? () => undefined
      : (options.mirror ??
          ((content) => {
            process.stderr.write(content);
          })),
  );
  const environment = options.environment ?? process.env;
  const secrets = await prepareSecretLookup(options.stateDirectory, environment);
  if (options.signal.aborted === true)
    return {
      result: {
        runId: options.runId,
        outcome: runFailure(
          "execution",
          "interrupted",
          "The run was interrupted before worker startup.",
        ),
        ...logs.snapshot(),
        finalization: "not-started",
        termination: { reason: "user-interruption", forced: false },
      },
    };
  const worker = workerInvocation({
    compiled: compiledRelease,
    runtime: currentRuntime(),
    entryPoint: cliEntryPoint,
    sidecar: releaseSidecar("worker.js"),
    ...(options.workerPath === undefined ? {} : { workerPath: options.workerPath }),
  });
  // Coverage skip: only a compiled release, which tests run as a subprocess, has a worker sidecar.
  /* v8 ignore next -- @preserve */
  if (compiledRelease && !existsSync(releaseSidecar("worker.js")))
    return {
      result: {
        runId: options.runId,
        outcome: runFailure("worker", "worker_spawn_failed", "The worker could not start."),
        ...logs.snapshot(),
        finalization: "not-started",
      },
    };
  return new Promise((resolve) => {
    let lastStage = "worker";
    let state: WorkerState = "starting";
    let failure: RunFailure | undefined;
    let terminal: TerminalPayload | undefined;
    let termination: OperatorRunResult["termination"];
    let grace: ReturnType<typeof setTimeout> | undefined;
    let cancelDeadline: (() => void) | undefined;
    let removeRepeated: (() => void) | undefined;
    let settled = false;
    let terminalWatchdog: ReturnType<typeof setTimeout> | undefined;
    let drainDeadline: ReturnType<typeof setTimeout> | undefined;
    let orphanedActivity = false;
    const groups = new Set<number>();
    const decoder = new FrameDecoder();
    let child: ReturnType<typeof spawn>;
    const settle = () => {
      if (settled === true) return;
      settled = true;
      if (grace !== undefined) clearTimeout(grace);
      cancelDeadline?.();
      if (terminalWatchdog !== undefined) clearTimeout(terminalWatchdog);
      if (drainDeadline !== undefined) clearTimeout(drainDeadline);
      removeRepeated?.();
      options.signal.removeEventListener("abort", interrupt);
      for (const pid of groups) {
        try {
          signalCommandTree(pid, "SIGKILL");
        } catch {
          /* Termination is already classified by the enclosing worker outcome. */
        }
      }
      let coreProjection;
      try {
        if (terminal?.core !== undefined)
          coreProjection = projectCore(terminal.core, secrets.knownValues, terminal.coreTruncation);
      } catch {
        failure = runFailure(
          "worker",
          "protocol_failure",
          "The worker sent invalid terminal data.",
        );
      }
      if (terminal?.coreTruncation !== undefined && terminal.coreTruncation.length > 0)
        logs.truncate("worker_log_limit");
      const resolved = resolveRunOutcome({
        failure,
        core: coreProjection,
        workerFailure:
          terminal?.failure === undefined
            ? undefined
            : runFailure(terminal.failure.stage, terminal.failure.code, terminal.failure.message),
        termination,
        orphanedActivity,
        lastStage,
      });
      // Admission takes a description only as the one terminal report of a worker still loading.
      const described = options.describe === true ? terminal?.described : undefined;
      resolve({
        ...(described === undefined ? {} : { described }),
        result: {
          runId: options.runId,
          outcome: resolved.outcome,
          ...(coreProjection === undefined ? {} : { core: coreProjection.safe }),
          ...logs.snapshot(),
          finalization: resolved.finalization,
          ...(termination === undefined ? {} : { termination }),
        },
        ...(coreProjection === undefined && terminal?.diagnostics === undefined
          ? {}
          : {
              diagnostics:
                coreProjection?.diagnostics ??
                redactOwnedJson(terminal?.diagnostics ?? null, secrets.knownValues),
            }),
      });
    };
    const kill = () => {
      if (termination !== undefined) termination = { ...termination, forced: true };
      for (const pid of groups) {
        try {
          signalCommandTree(pid, "SIGKILL");
        } catch {
          /* Keep the initiating reason. */
        }
      }
      if (child.pid !== undefined) {
        try {
          signalCommandTree(child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    };
    const send = (kind: Frame["kind"], payload: Schema.Json) => {
      const writer = child.stdio[3];
      if (writer instanceof Duplex === false || writer.destroyed === true)
        throw new ProtocolFailure();
      writer.write(encodeFrame({ version: 1, runId: options.runId, kind, payload }));
    };
    const cancel = (reason: "timeout" | "user-interruption") => {
      if (settled === true || state === "terminal") return;
      if (termination !== undefined) {
        kill();
        return;
      }
      termination = { reason, forced: false };
      logs.add(
        "supervisor",
        reason === "timeout"
          ? "Run timeout requested interruption.\n"
          : "Operator requested interruption.\n",
      );
      try {
        send("cancel", {});
      } catch {
        kill();
      }
      grace = setTimeout(kill, options.graceMs ?? executionLimits.graceMs);
    };
    function interrupt() {
      cancel("user-interruption");
    }
    const fail = (outcome: RunFailure) => {
      failure = outcome;
      kill();
    };
    /**
     * A private pipe error. Once the supervisor has initiated termination, a broken pipe is a
     * consequence of it (killing a worker that holds unread input resets the pipe on Linux), so it
     * escalates to a kill and the initiating reason stays the outcome.
     */
    // Coverage skip: a pipe error needs the host to reset a private pipe; Bun destroys it silently.
    /* v8 ignore start -- @preserve */
    const pipeFailed = (message: string) => {
      if (termination === undefined) fail(runFailure("worker", "protocol_failure", message));
      else kill();
    };
    /* v8 ignore stop -- @preserve */
    try {
      child = spawn(process.execPath, [...worker.args], {
        cwd: options.cwd,
        detached: true,
        env: { ...minimalWorkerEnvironment(environment), ...worker.environment },
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      });
    } catch {
      failure = runFailure("worker", "worker_spawn_failed", "The worker could not start.");
      settle();
      return;
    }
    for (const [source, stream] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ] as const) {
      const streamDecoder = new StringDecoder("utf8");
      stream?.on("data", (chunk: Buffer) => {
        const content = streamDecoder.write(chunk);
        if (content.length > 0) logs.add(source, content);
      });
      stream?.on("end", () => {
        const content = streamDecoder.end();
        if (content.length > 0) logs.add(source, content);
      });
    }
    child.once("error", () => {
      failure = runFailure("worker", "worker_spawn_failed", "The worker could not start.");
    });
    child.once("exit", () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 0);
          orphanedActivity = true;
          signalCommandTree(child.pid, "SIGKILL");
        } catch {
          /* An empty owned process group needs no further cleanup. */
        }
      }
      // Exit and stream closure are distinct: descendants can retain inherited pipe endpoints.
      drainDeadline = setTimeout(() => {
        // Coverage skip: close always follows exit and settling clears this timer first.
        /* v8 ignore next -- @preserve */
        if (settled === true) return;
        orphanedActivity = true;
        for (const stream of child.stdio) stream?.destroy();
        settle();
      }, options.graceMs ?? executionLimits.graceMs);
    });
    child.once("close", () => {
      try {
        decoder.end();
      } catch {
        if (failure === undefined && termination === undefined)
          failure = runFailure(
            "worker",
            "protocol_failure",
            "The worker ended an incomplete protocol frame.",
          );
      }
      settle();
    });
    const reader = child.stdio[4];
    if (reader instanceof Duplex === false) {
      fail(runFailure("worker", "protocol_failure", "The private worker pipes are unavailable."));
      return;
    }
    reader.on("data", (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (frame.runId !== options.runId) throw new ProtocolFailure();
          const admitted = admitFrame(state, frame);
          if (admitted.kind === "stage" || admitted.kind === "requirements") {
            state = admitted.next;
            lastStage = admitted.lastStage;
          }
          if (admitted.kind === "requirements")
            // Only the lookup's rejection is a secret failure; a failed send is a protocol failure.
            void secrets.lookup(admitted.requirements.secrets).then(
              (values) => {
                if (settled === false && failure === undefined) {
                  state = "prepared";
                  try {
                    send("capabilities", { secrets: values });
                  } catch {
                    fail(
                      runFailure(
                        "worker",
                        "protocol_failure",
                        "The capabilities could not reach the worker.",
                      ),
                    );
                  }
                }
              },
              (error: unknown) => {
                fail(
                  error instanceof SecretFailure
                    ? runFailure("preflight", error.code, error.message, {
                        names: [...error.names],
                      })
                    : runFailure(
                        "preflight",
                        "secret_configuration_failed",
                        "The declared secrets could not be provided.",
                      ),
                );
              },
            );
          else if (admitted.kind === "log") logs.add(admitted.log.source, admitted.log.content);
          else if (admitted.kind === "shell-start") groups.add(admitted.pid);
          else if (admitted.kind === "shell-end") groups.delete(admitted.pid);
          else if (admitted.kind === "terminal") {
            state = admitted.next;
            terminal = admitted.terminal;
            const control = child.stdio[3];
            if (control instanceof Duplex) control.end();
            terminalWatchdog = setTimeout(() => {
              failure = runFailure(
                "cleanup",
                "cleanup_failed",
                "The worker retained activity after finalization.",
              );
              kill();
            }, options.graceMs ?? executionLimits.graceMs);
          }
        }
      } catch {
        fail(
          runFailure(
            "worker",
            "protocol_failure",
            "The worker sent invalid private protocol traffic.",
          ),
        );
      }
    });
    // Coverage skip: a pipe error needs the host to reset a private pipe; Bun destroys it silently.
    /* v8 ignore start -- @preserve */
    reader.once("error", () => pipeFailed("The private worker pipe failed."));
    const writer = child.stdio[3];
    if (writer instanceof Duplex)
      writer.on("error", () => {
        if (state !== "terminal" && settled === false)
          pipeFailed("The worker control pipe failed.");
      });
    /* v8 ignore stop -- @preserve */
    removeRepeated = options.onRepeatSignal?.(interrupt);
    options.signal.addEventListener("abort", interrupt, { once: true });
    try {
      send("start", {
        entrypoint: options.entrypoint,
        cwd: options.cwd,
        input: options.input,
        ...(options.words === undefined ? {} : { words: [...options.words] }),
        ...(options.describe === undefined ? {} : { describe: true }),
      });
    } catch {
      // Coverage skip: the pipe check above already refused a spawn without open private pipes.
      /* v8 ignore next -- @preserve */
      fail(runFailure("worker", "protocol_failure", "The run request could not reach the worker."));
    }
    if (options.timeoutMs !== undefined) {
      const fire = () => cancel("timeout");
      if (options.scheduleDeadline === undefined) {
        const timer = setTimeout(fire, options.timeoutMs);
        cancelDeadline = () => clearTimeout(timer);
      } else cancelDeadline = options.scheduleDeadline(fire, options.timeoutMs);
    }
    if (options.signal.aborted === true) interrupt();
  });
};
