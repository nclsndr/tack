import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { Effect } from "effect";
import { ShellFailure, type ShellService, type ShellResult, type ShellCommand } from "@tackup/core";
import { executionLimits } from "../../domain/execution/execution-schema.ts";

/** Signals an independently owned command tree, tolerating an already exited group. */
export const signalCommandTree = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw new ShellFailure({
      operation: "termination",
      message: "The command tree could not be terminated.",
    });
  }
};

/** Creates captured non-interactive Shell calls owned by their individual Effect lifetimes. */
export const makeLiveShell = (options: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onOutput: (content: string) => void;
  readonly onStart: (pid: number) => void;
  readonly onEnd: (pid: number) => void;
}): ShellService => ({
  execute: (command: ShellCommand) =>
    Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const child = spawn(command.executable, [...command.args], {
            cwd: command.cwd ?? options.cwd,
            env: { ...options.environment, ...command.env },
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const pid = child.pid;
          if (pid !== undefined) options.onStart(pid);
          const stdoutDecoder = new StringDecoder("utf8");
          const stderrDecoder = new StringDecoder("utf8");
          let stdout = Buffer.alloc(0);
          let stderr = Buffer.alloc(0);
          let stdoutTruncated = false;
          let stderrTruncated = false;
          let closed = false;
          let failure: ShellFailure | undefined;
          const completion = new Promise<ShellResult>((resolve, reject) => {
            child.stdout.on("data", (chunk: Buffer) => {
              const decoded = stdoutDecoder.write(chunk);
              if (decoded.length > 0) options.onOutput(decoded);
              const remaining = executionLimits.valueBytes - stdout.length;
              if (chunk.length > remaining) stdoutTruncated = true;
              if (remaining > 0) stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
            });
            child.stderr.on("data", (chunk: Buffer) => {
              const decoded = stderrDecoder.write(chunk);
              if (decoded.length > 0) options.onOutput(decoded);
              const remaining = executionLimits.valueBytes - stderr.length;
              if (chunk.length > remaining) stderrTruncated = true;
              if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
            });
            // Coverage skip: the host must fail reading a live child's pipe, which cannot be provoked.
            /* v8 ignore start -- @preserve */
            const ioFailure = () => {
              failure = new ShellFailure({
                operation: "io",
                message: "The command streams could not be read.",
              });
              if (pid !== undefined) {
                try {
                  signalCommandTree(pid, "SIGKILL");
                } catch (error) {
                  if (error instanceof ShellFailure) failure = error;
                }
              }
            };
            /* v8 ignore stop -- @preserve */
            child.stdout.once("error", ioFailure);
            child.stderr.once("error", ioFailure);
            child.once("error", () => {
              failure = new ShellFailure({
                operation: "spawn",
                message: "The command could not be started.",
              });
            });
            child.once("close", (exitCode) => {
              closed = true;
              for (const tail of [stdoutDecoder.end(), stderrDecoder.end()]) {
                if (tail.length > 0) options.onOutput(tail);
              }
              if (failure !== undefined) reject(failure);
              else if (exitCode === null)
                reject(
                  new ShellFailure({
                    operation: "termination",
                    message: "The command terminated without an exit status.",
                  }),
                );
              else
                resolve({
                  stdout: new StringDecoder("utf8").write(stdout),
                  stderr: new StringDecoder("utf8").write(stderr),
                  exitCode,
                  ...(stdoutTruncated === true ? { stdoutTruncated } : {}),
                  ...(stderrTruncated === true ? { stderrTruncated } : {}),
                });
            });
          });
          // Attach rejection handling immediately; interruption may win before the use phase awaits it.
          void completion.catch(() => undefined);
          return { completion, pid, closed: () => closed };
        },
        catch: () =>
          new ShellFailure({ operation: "spawn", message: "The command could not be started." }),
      }),
      (owned) =>
        Effect.tryPromise({
          try: () => owned.completion,
          catch: (error) =>
            error instanceof ShellFailure
              ? error
              : new ShellFailure({
                  operation: "io",
                  message: "The command streams could not be read.",
                }),
        }),
      (owned) =>
        Effect.tryPromise({
          try: async () => {
            if (owned.pid === undefined) {
              await owned.completion.catch(() => undefined);
              return;
            }
            const pid = owned.pid;
            if (owned.closed() === true) {
              signalCommandTree(pid, "SIGKILL");
              options.onEnd(pid);
              return;
            }
            signalCommandTree(pid, "SIGTERM");
            options.onOutput("Command interruption requested.\n");
            let escalationFailure: unknown;
            const escalation = setTimeout(() => {
              try {
                signalCommandTree(pid, "SIGKILL");
              } catch (error) {
                // Coverage skip: signalling this call's own process group fails only with ESRCH.
                /* v8 ignore next -- @preserve */
                escalationFailure = error;
              }
            }, 1000);
            try {
              await owned.completion.catch(() => undefined);
            } finally {
              clearTimeout(escalation);
              signalCommandTree(pid, "SIGKILL");
              options.onEnd(pid);
            }
            // Coverage skip: signalling this call's own process group fails only with ESRCH.
            /* v8 ignore next -- @preserve */
            if (escalationFailure !== undefined) throw escalationFailure;
          },
          // Coverage skip: signalling this call's own process group fails only with ESRCH.
          /* v8 ignore next -- @preserve */
          catch: () =>
            new ShellFailure({
              operation: "termination",
              message: "The command tree could not be terminated.",
            }),
        }),
    ),
});
