import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("captures expanded Tack argv, output and individual exit codes through a pipeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "tack-trace-"));
  const executable = join(root, "real-tack");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf "%s\\n" "$*"\nprintf "git fatal\\n" >&2\nexit 7\n',
    { mode: 0o755 },
  );
  const wrapper = join(import.meta.dir, "tack-trace.mjs");
  const script = `T='${executable}'; node '${wrapper}' "$T" catalog --json 2>&1 | head -c 8; node '${wrapper}' "$T" sync --project demo --apply`;
  const result = spawnSync("bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TACK_EVAL_TRACE: join(root, "trace.jsonl") },
  });
  expect(result.status).toBe(7);
  const evidence = (await readFile(join(root, "trace.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(evidence).toEqual([
    {
      argv: ["tack", "catalog", "--json"],
      cwd: await realpath(root),
      exitCode: 7,
      stdout: "catalog --json\n",
      stderr: "git fatal\n",
    },
    {
      argv: ["tack", "sync", "--project", "demo", "--apply"],
      cwd: await realpath(root),
      exitCode: 7,
      stdout: "sync --project demo --apply\n",
      stderr: "git fatal\n",
    },
  ]);
});
