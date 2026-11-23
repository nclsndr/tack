import { afterAll, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { runTackInProcess } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

let scratch: string | undefined;
afterAll(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

it("initializes default state once after a valid mutation and guards explicit state paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "tack-implicit-init-"));
  scratch = root;
  const home = join(root, "home");
  const source = join(root, "source");
  const explicit = join(root, "mistyped-state");
  await mkdir(home);
  await mkdir(source);
  await writeFile(join(source, "tack.yaml"), "version: 1\n");

  const run = async (args: ReadonlyArray<string>) => {
    const result = await Effect.runPromise(
      runTackInProcess(["--json", ...args], { cwd: root, home }),
    );
    return { ...result, envelope: decodeEnvelope(result.stdout) };
  };
  const state = join(home, ".tack", "state.json");
  expect((await run(["catalog"])).exitCode).not.toBe(0);
  expect(await lstat(state).catch(() => undefined)).toBeUndefined();
  expect((await run(["source", "add", join(root, "missing"), "--apply"])).exitCode).not.toBe(0);
  expect(await lstat(state).catch(() => undefined)).toBeUndefined();

  const typo = await run(["--state-dir", explicit, "source", "add", source, "--apply"]);
  expect(typo.envelope.classification).toBe("invalid-configuration");
  expect(JSON.stringify(typo.envelope.diagnostics)).toContain("state init");
  expect(await lstat(explicit).catch(() => undefined)).toBeUndefined();

  const first = await run(["source", "add", source, "--apply"]);
  expect(first.envelope.classification, JSON.stringify(first)).toBe("success");
  expect(first.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: "state-initialized" }),
  );
  expect(await lstat(state).then(() => true)).toBe(true);

  const second = await run(["adapter", "enable", "codex"]);
  expect(second.envelope.classification, JSON.stringify(second)).toBe("success");
  expect(second.envelope.diagnostics).not.toContainEqual(
    expect.objectContaining({ code: "state-initialized" }),
  );
});
