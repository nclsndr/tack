import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Builds `apps/cli/dist` once before any test file starts. Test files share that directory, so
 * builds from parallel files removed `dist/builtins` while another build or a test was using it.
 */
export default function buildCli() {
  const result = spawnSync("bun", ["run", "--filter", "@tackup/cli", "build"], {
    cwd: resolve(import.meta.dirname, "../../../.."),
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`The CLI build failed.\n${result.stdout}${result.stderr}`);
}
