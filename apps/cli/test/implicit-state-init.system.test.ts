import { afterAll, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeEnvelope, runTackSync } from "./support/tack-process.ts";

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

  const run = (args: ReadonlyArray<string>) => {
    const result = runTackSync(["--json", ...args], { cwd: root, home });
    return { ...result, envelope: decodeEnvelope(result.stdout) };
  };
  const state = join(home, ".tack", "state.json");
  expect(run(["catalog"]).exitCode).not.toBe(0);
  expect(await lstat(state).catch(() => undefined)).toBeUndefined();
  expect(run(["source", "add", join(root, "missing")]).exitCode).not.toBe(0);
  expect(await lstat(state).catch(() => undefined)).toBeUndefined();

  const typo = run(["--state-dir", explicit, "source", "add", source]);
  expect(typo.envelope.classification).toBe("invalid-configuration");
  expect(JSON.stringify(typo.envelope.diagnostics)).toContain("state init");
  expect(await lstat(explicit).catch(() => undefined)).toBeUndefined();

  const first = run(["source", "add", source]);
  expect(first.envelope.classification, JSON.stringify(first)).toBe("success");
  expect(first.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: "state-initialized" }),
  );
  expect(await lstat(state).then(() => true)).toBe(true);

  const second = run(["adapter", "enable", "codex"]);
  expect(second.envelope.classification, JSON.stringify(second)).toBe("success");
  expect(second.envelope.diagnostics).not.toContainEqual(
    expect.objectContaining({ code: "state-initialized" }),
  );
});
