import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const binary = process.argv[2];
const launcher = process.argv[3];
if (binary === undefined || launcher === undefined || !isAbsolute(binary) || !isAbsolute(launcher))
  throw new Error("Pass absolute paths to the release executable and launcher main.js.");
const scratch = await mkdtemp(join(tmpdir(), "tack-benchmark-"));
try {
  const home = join(scratch, "home");
  await mkdir(home);
  const env = { HOME: home, TACK_STATE_DIR: join(scratch, "state"), PATH: "/usr/bin:/bin" };
  const measure = (command: string[], expectedExitCode = 0) => {
    const start = performance.now();
    const result = Bun.spawnSync({
      cmd: command,
      cwd: scratch,
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    if (result.exitCode !== expectedExitCode)
      throw new Error(`${command[0]} exited ${result.exitCode}.`);
    return performance.now() - start;
  };
  measure([binary, "--json", "state", "init"]);
  const stats = (samples: number[]) => {
    const sorted = [...samples].sort((left, right) => left - right);
    return {
      median: sorted[Math.floor(sorted.length / 2)] ?? Infinity,
      p90: sorted[Math.ceil(sorted.length * 0.9) - 1] ?? Infinity,
    };
  };
  for (const args of [["--help"], ["status", "--user"]]) {
    const releaseCommand = [binary, "--json", ...args];
    const launcherCommand = [process.execPath, launcher, "--json", ...args];
    const expectedExitCode = args[0] === "--help" ? 0 : 1;
    for (let index = 0; index < 3; index++) {
      measure(releaseCommand, expectedExitCode);
      measure(launcherCommand, expectedExitCode);
    }
    const releaseSamples: number[] = [];
    const launcherSamples: number[] = [];
    for (let index = 0; index < 41; index++) {
      if (index % 2 === 0) {
        releaseSamples.push(measure(releaseCommand, expectedExitCode));
        launcherSamples.push(measure(launcherCommand, expectedExitCode));
      } else {
        launcherSamples.push(measure(launcherCommand, expectedExitCode));
        releaseSamples.push(measure(releaseCommand, expectedExitCode));
      }
    }
    const releaseStats = stats(releaseSamples);
    const launcherStats = stats(launcherSamples);
    process.stdout.write(
      `${args.join(" ")}: release median ${releaseStats.median.toFixed(1)} ms, p90 ${releaseStats.p90.toFixed(1)} ms; launcher median ${launcherStats.median.toFixed(1)} ms, p90 ${launcherStats.p90.toFixed(1)} ms\n`,
    );
    if (releaseStats.median >= launcherStats.median * 0.85) process.exitCode = 1;
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
