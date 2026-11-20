import { spawn } from "node:child_process";
import { appendFileSync, statSync } from "node:fs";

// The image launcher supplies the real binary separately, preserving Tack's public argv.
const [executable, ...args] = process.argv.slice(2);
const trace = process.env.TACK_EVAL_TRACE;
const child = spawn(executable, args, { stdio: ["inherit", "pipe", "pipe"] });
const stdout = [];
const stderr = [];
let bytes = 0;
const limit = 4 * 1024 * 1024;
let truncated = false;
const capture = (chunks, destination, chunk) => {
  const remaining = Math.max(0, limit - bytes);
  chunks.push(chunk.subarray(0, remaining));
  bytes += chunk.length;
  truncated ||= bytes > limit;
  destination.write(chunk);
};
// A downstream head may close early. Continue observing the real process without inventing success.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
child.stdout.on("data", (chunk) => capture(stdout, process.stdout, chunk));
child.stderr.on("data", (chunk) => capture(stderr, process.stderr, chunk));
child.on("error", (error) => {
  process.stderr.write(String(error));
});
child.on("close", (code) => {
  if (trace !== undefined) {
    let size = 0;
    try {
      size = statSync(trace).size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (size < 16 * 1024 * 1024)
      appendFileSync(
        trace,
        JSON.stringify({
          argv: ["tack", ...args],
          cwd: process.cwd(),
          exitCode: code ?? 137,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          ...(truncated ? { truncated: true } : {}),
        }) + "\n",
      );
  }
  process.exitCode = code ?? 137;
});
