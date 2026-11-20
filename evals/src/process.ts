import { spawn } from "node:child_process";
import type { DriverId } from "./plan.ts";

export type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  stopped: "timed-out" | "output-limit" | "cancelled" | null;
};
export type ProcessOptions = {
  timeoutMs: number;
  outputBytes: number;
  stdin?: string;
  /**
   * Keeps the input open after `stdin` and is called with each complete stdout line: text to
   * write to the input, `null` to close it, or `undefined` to wait.
   */
  respond?: (line: string) => string | null | undefined;
  signal?: AbortSignal;
};
/** Spawn argv without a shell, bounded by time and combined output; reap its process group. */
export async function runProcess(
  argv: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const [executable, ...args] = argv;
  if (executable === undefined) throw new Error("Empty argv");
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stopped: ProcessResult["stopped"] = null;
    let size = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stop = (reason: NonNullable<ProcessResult["stopped"]>) => {
      if (stopped !== null) return;
      stopped = reason;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) reject(error);
        }
      }
    };
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, options.outputBytes - size);
      target.push(chunk.subarray(0, remaining));
      size += chunk.length;
      if (size > options.outputBytes) stop("output-limit");
    };
    let pending = "";
    const answer = (chunk: Buffer) => {
      const respond = options.respond;
      if (respond === undefined) return;
      const lines = (pending + chunk.toString("utf8")).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (stopped !== null) return;
        const reply = respond(line);
        if (reply === null) child.stdin.end();
        else if (reply !== undefined) child.stdin.write(reply);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      capture(stdout, chunk);
      answer(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    const timeout = setTimeout(() => stop("timed-out"), options.timeoutMs);
    const abort = () => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) abort();
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      resolve({
        exitCode: code ?? 137,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        stopped,
      });
    });
    child.stdin.on("error", () => {
      /* Child may exit before reading the prompt. */
    });
    if (options.respond === undefined) child.stdin.end(options.stdin ?? "");
    else child.stdin.write(options.stdin ?? "");
  });
}
const hardened = [
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--pids-limit=128",
  "--memory=2g",
  "--cpus=2",
  "--init",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,size=256m",
  "--tmpfs",
  "/session:rw,nosuid,nodev,uid=1000,gid=1000,size=64m",
];
/**
 * Build the sole task-world mount, without network, credentials, host sockets or source code.
 * `builtins` is the trial's copy of Tack's built-ins: mounted read-only at `/instructions` for the
 * agent to read, and over the image's own built-ins so that `tack` links the same files.
 */
export function taskContainerArgs(
  name: string,
  image: string,
  world: string,
  builtins?: string,
): string[] {
  return [
    "run",
    "-d",
    "--name",
    name,
    ...hardened,
    "--network",
    "none",
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "--mount",
    `type=bind,source=${world},target=/world`,
    ...(builtins === undefined
      ? []
      : ["/instructions", "/opt/tack/builtins"].flatMap((target) => [
          "--mount",
          `type=bind,source=${builtins},target=${target},readonly`,
        ])),
    "--env",
    "HOME=/world/home",
    "--workdir",
    "/world",
    image,
  ];
}
/** Build a separate control container; only its dedicated eval auth volume is persistent. */
export function agentContainerArgs(
  name: string,
  image: string,
  driver: DriverId,
  environment: Readonly<Record<string, string>>,
  options: { auth?: boolean } = {},
): string[] {
  return [
    "run",
    "--name",
    name,
    ...hardened,
    ...(options.auth === false
      ? []
      : ["--mount", `type=volume,source=tack-evals-auth-${driver},target=/auth`]),
    ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    image,
  ];
}
/** Execute a bounded Docker control command with no forwarded provider secrets. */
export async function docker(
  args: readonly string[],
  options: Partial<ProcessOptions> = {},
): Promise<ProcessResult> {
  return await runProcess(["docker", ...args], {
    timeoutMs: 30000,
    outputBytes: 4194304,
    ...options,
  });
}
/** Require a successful control operation; failed setup cannot masquerade as a task result. */
export function successful(result: ProcessResult): string {
  if (result.exitCode !== 0 || result.stopped !== null)
    throw new Error(
      `Container operation failed (${result.stopped ?? result.exitCode}): ${result.stderr.slice(0, 1000)}`,
    );
  return result.stdout.trim();
}
