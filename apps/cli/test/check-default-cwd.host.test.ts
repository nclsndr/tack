import { afterAll, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { runTackInProcess } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

let scratch: string | undefined;
afterAll(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

it("checks the current folder when tack check names no path, exactly as tack check .", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tack-check-default-cwd-")));
  scratch = root;
  const home = join(root, "home");
  const source = join(root, "source");
  const plain = join(root, "plain");
  await mkdir(home);
  await mkdir(join(source, "skills", "alpha"), { recursive: true });
  await mkdir(plain);
  await writeFile(
    join(source, "tack.yaml"),
    "version: 1\nname: source\nskills:\n  - path: skills\n",
  );
  await writeFile(
    join(source, "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: Use when checking the default folder.\n---\n\n# Alpha\n",
  );

  const run = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.runPromise(runTackInProcess(args, { cwd, home }));

  // A folder without a tack.yaml is checked as a docs folder, as `tack check .` checks it.
  for (const [cwd, kind] of [
    [source, "source"],
    [plain, "docs"],
  ] as const) {
    const bareJson = await run(cwd, ["--json", "check"]);
    const dotJson = await run(cwd, ["--json", "check", "."]);
    expect(JSON.stringify(decodeEnvelope(bareJson.stdout).diagnostics)).not.toContain(
      "missing-argument",
    );
    expect(bareJson).toEqual(dotJson);
    expect(bareJson.exitCode).toBe(0);
    expect(decodeEnvelope(bareJson.stdout).result).toMatchObject({
      kind: "check-report",
      checks: [{ kind, path: cwd }],
      summary: { errors: 0 },
    });
    const bare = await run(cwd, ["check"]);
    const dot = await run(cwd, ["check", "."]);
    expect(bare).toEqual(dot);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toContain(`${kind} ${cwd}`);
  }
});
