import { afterAll, expect, it } from "vitest";
import {
  cp,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The skills the built-in source ships. */
const builtinSkillNames = [
  "use-tack",
  "manage-tack-sources",
  "write-reader-figures",
  "author-tack-profiles",
  "prepare-tack-checkout",
] as const;
const repository = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return Object.fromEntries(Object.entries(value));
};
const run = (cmd: string[], cwd: string, env: Record<string, string> = {}) => {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: text(result.stdout), stderr: text(result.stderr) };
};
const json = (result: ReturnType<typeof run>) => {
  expect(result.stdout, result.stderr).not.toBe("");
  const value: unknown = JSON.parse(result.stdout);
  return record(value);
};

let scratch: string | undefined;
afterAll(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
}, 120_000);

it("builds a movable release from a clean export and runs its complete flow", async () => {
  scratch = await mkdtemp(join(tmpdir(), "tack-release-"));
  const exportRoot = join(scratch, "export");
  const release = join(scratch, "release");
  const moved = join(scratch, "moved");
  const home = join(scratch, "home");
  const state = join(scratch, "state");
  const hostile = join(scratch, "hostile");
  for (const path of [exportRoot, home, hostile]) await mkdir(path, { recursive: true });
  for (const path of [
    "package.json",
    "bun.lock",
    "scripts/build-release.ts",
    "apps/cli/package.json",
    "apps/cli/src",
    "packages/core/package.json",
    "packages/core/src",
    "packages/reader/package.json",
    "packages/reader/src",
  ]) {
    await mkdir(dirname(join(exportRoot, path)), { recursive: true });
    await cp(join(repository, path), join(exportRoot, path), {
      recursive: true,
      filter: (name) => !/\.test\.[cm]?[jt]sx?$/.test(name),
    });
  }
  expect(run([process.execPath, "install", "--frozen-lockfile"], exportRoot).code).toBe(0);
  expect(
    run([process.execPath, "scripts/build-release.ts", release], exportRoot, {
      TACK_BUILD_COMMIT: "abcdef0",
    }).code,
  ).toBe(0);
  expect(await lstat(join(exportRoot, ".git")).catch(() => undefined)).toBeUndefined();

  const manifestPath = join(exportRoot, "package.json");
  const manifest = await readFile(manifestPath, "utf8");
  const manifestValue: unknown = JSON.parse(manifest);
  const packageVersion = record(manifestValue)["version"];
  if (typeof packageVersion !== "string") throw new Error("Missing package version.");
  await writeFile(
    manifestPath,
    manifest.replace(/"packageManager": "bun@[^"]+"/, '"packageManager": "bun@0.0.0"'),
  );
  const mismatch = run(
    [process.execPath, "scripts/build-release.ts", join(scratch, "bad")],
    exportRoot,
    {
      TACK_BUILD_COMMIT: "abcdef0",
    },
  );
  expect(mismatch.code).not.toBe(0);
  expect(mismatch.stderr).toContain("Release requires bun@0.0.0");
  await writeFile(manifestPath, manifest);

  const gateHome = join(scratch, "gate-operator-home");
  const gateState = join(gateHome, ".tack/state.json");
  await mkdir(dirname(gateState), { recursive: true });
  const gate = () =>
    run(
      [
        process.execPath,
        join(repository, "scripts/gate-release.ts"),
        release,
        `${packageVersion}+gabcdef0`,
        gateHome,
      ],
      exportRoot,
      { HOME: join(dirname(exportRoot), "unrelated-home") },
    );
  const stateFixtures = join(repository, "apps/cli/src/domain/state/fixtures");
  /** The gate reads a copy of the operator's file: the file itself keeps its bytes and its time. */
  const expectUntouched = async (bytes: Buffer, before: Awaited<ReturnType<typeof stat>>) => {
    expect(await readFile(gateState)).toEqual(bytes);
    expect((await stat(gateState)).mtimeMs).toBe(before.mtimeMs);
  };

  // A machine with no state file has nothing to read: the candidate passes and writes none.
  const withoutState = gate();
  expect(withoutState.code, withoutState.stderr).toBe(0);
  expect(await lstat(gateState).catch(() => undefined)).toBeUndefined();

  const current = await readFile(join(stateFixtures, "format-1/empty.state"));
  await writeFile(gateState, current);
  const beforeCurrent = await stat(gateState);
  const accepted = gate();
  expect(accepted.code, accepted.stderr).toBe(0);
  await expectUntouched(current, beforeCurrent);

  // A candidate that refuses to read a current-format file fails the gate.
  await writeFile(gateState, current);
  const beforeStub = await stat(gateState);
  const candidate = join(release, "bin/tack");
  await rename(candidate, `${candidate}.real`);
  await writeFile(
    candidate,
    `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = status ]; then\n    printf '%s\\n' '{"classification":"persistence","diagnostics":[{"code":"state-corrupt"}]}'\n    exit 3\n  fi\ndone\nexec "$0.real" "$@"\n`,
  );
  await chmod(candidate, 0o755);
  const rejected = gate();
  expect(rejected.code).not.toBe(0);
  expect(rejected.stdout).toContain('"failed":"state-compatibility"');
  expect(rejected.stdout).toContain("state-corrupt");
  await expectUntouched(current, beforeStub);
  await rm(candidate);
  await rename(`${candidate}.real`, candidate);

  await rename(release, moved);
  const binary = join(moved, "bin/tack");
  const checked = run([binary, "--json", "check", join(moved, "builtins")], hostile, {
    HOME: home,
    TACK_STATE_DIR: state,
  });
  expect(checked.code, checked.stderr).toBe(0);
  expect(json(checked)["result"]).toMatchObject({
    kind: "check-report",
    checks: [
      expect.objectContaining({
        kind: "source",
        details: expect.arrayContaining([`skill: ${builtinSkillNames.length}`]),
      }),
    ],
    findings: [],
  });

  const link = join(scratch, "tack-link");
  await symlink(binary, link);
  const gitDirectory = dirname(Bun.which("git") ?? "/usr/bin/git");
  const env = {
    HOME: home,
    TACK_STATE_DIR: state,
    PATH: `${join(moved, "bin")}:${gitDirectory}:/usr/bin:/bin`,
  };
  expect(run(["/bin/sh", "-c", "command -v bun"], hostile, env).code).not.toBe(0);
  await writeFile(join(hostile, ".env"), `TACK_STATE_DIR=${join(scratch, "poisoned")}\n`);
  await writeFile(join(hostile, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  await writeFile(
    join(hostile, "preload.ts"),
    `await Bun.write(${JSON.stringify(join(scratch, "preloaded"))}, "yes");\n`,
  );
  const invoke = (args: string[], cwd = hostile) => run([link, "--json", ...args], cwd, env);
  expect(json(invoke(["--help"]))["classification"]).toBe("success");
  const version = record(json(invoke(["--version"]))["result"]);
  expect(version).toMatchObject({
    version: packageVersion,
    commit: "abcdef0",
    stamp: `${packageVersion}+gabcdef0`,
    sourceRun: false,
  });
  expect(json(invoke(["--version"]))["result"]).toEqual(version);
  const defaultHome = join(scratch, "default-home");
  await mkdir(defaultHome);
  const defaultInit = run([binary, "--json", "state", "init"], hostile, {
    HOME: defaultHome,
    PATH: env.PATH,
  });
  expect(json(defaultInit)["classification"]).toBe("success");
  expect(await lstat(join(defaultHome, ".tack/state.json")).then(() => true)).toBe(true);
  expect(await lstat(join(scratch, "poisoned")).catch(() => undefined)).toBeUndefined();
  expect(await lstat(join(scratch, "preloaded")).catch(() => undefined)).toBeUndefined();
  expect(json(invoke(["state", "init"]))["classification"]).toBe("success");
  expect(await lstat(join(state, "state.json")).then(() => true)).toBe(true);
  expect(await lstat(join(scratch, "poisoned")).catch(() => undefined)).toBeUndefined();
  expect(await lstat(join(scratch, "preloaded")).catch(() => undefined)).toBeUndefined();
  expect(json(invoke(["catalog"]))["classification"]).toBe("success");
  expect(json(invoke(["adapter", "enable", "claude"]))["classification"]).toBe("success");
  expect(json(invoke(["sync", "--user", "--apply"]))["classification"]).toBe("success");
  for (const name of builtinSkillNames)
    expect((await lstat(join(home, ".claude/skills", name))).isSymbolicLink()).toBe(true);

  const fixture = join(scratch, "fixture");
  const source = join(fixture, "source");
  const project = join(fixture, "project");
  await mkdir(join(source, "scripts"), { recursive: true });
  await mkdir(join(source, "handbook"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(
    join(source, "tack.yaml"),
    "version: 1\nscripts:\n  - name: check\n    path: scripts/check.ts\n    description: Check nested Tack.\ndocs:\n  - name: handbook\n    path: handbook\n",
  );
  await writeFile(
    join(source, "handbook/index.md"),
    "---\ntitle: Handbook\n---\n# Handbook\n\nSource ownership.\n",
  );
  // A script-API script installs nothing: the release provides "@tackup/cli" itself.
  await writeFile(
    join(source, "scripts/check.ts"),
    `
import { defineScript } from "@tackup/cli";

export default defineScript({
  run: async ({ exec }) => {
    const result = await exec("/bin/sh", ["-c", "echo \${BUN_BE_BUN-absent}; tack --json --version"]);
    return result.stdout.trim();
  },
});
`,
  );
  expect(run(["git", "init", "--quiet", project], scratch).code).toBe(0);
  expect(
    run(
      [
        "git",
        "-C",
        project,
        "-c",
        "user.name=Tack",
        "-c",
        "user.email=tack@example.test",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "init",
      ],
      scratch,
    ).code,
  ).toBe(0);
  expect(json(invoke(["source", "add", source]))["classification"]).toBe("success");
  const projectAdd = invoke(["project", "add", "demo"], project);
  expect(json(projectAdd)["classification"], projectAdd.stdout).toBe("success");
  const script = json(invoke(["script", "run", "check", "--user", "--input-json", "{}"]));
  expect(script["classification"]).toBe("success");
  const encoded = record(record(record(script["result"])["core"])["primary"])["encoded"];
  if (typeof encoded !== "string") throw new Error("Missing script output.");
  expect(encoded.startsWith("absent\n")).toBe(true);
  expect(encoded).toContain(`"stamp":"${packageVersion}+gabcdef0"`);
  expect(json(invoke(["docs", "attach", "handbook", "--project", "demo"]))["classification"]).toBe(
    "success",
  );
  expect(
    json(invoke(["sync", "--no-adapters", "--project", "demo", "--apply"]))["classification"],
  ).toBe("success");
  const search = json(invoke(["docs", "search", "ownership", "--project", "demo", "--limit", "1"]));
  expect(search["classification"]).toBe("success");
  const hits = record(search["result"])["hits"];
  expect(Array.isArray(hits) ? hits.length : undefined).toBe(1);

  const normalize = (value: unknown) => {
    const normalizedText = JSON.stringify(value)
      .replaceAll(realpathSync(join(moved, "builtins")), "<builtins>")
      .replaceAll(realpathSync(join(exportRoot, "apps/cli/src/builtins")), "<builtins>");
    const parsedValue: unknown = JSON.parse(normalizedText);
    const parsed = record(parsedValue);
    const result = parsed["result"];
    const resources = result === undefined ? undefined : record(result)["resources"];
    if (Array.isArray(resources))
      resources.sort((left, right) => {
        const leftAddress = record(record(left)["address"]);
        const rightAddress = record(record(right)["address"]);
        return `${String(leftAddress["owner"])}/${String(leftAddress["kind"])}/${String(leftAddress["name"])}`.localeCompare(
          `${String(rightAddress["owner"])}/${String(rightAddress["kind"])}/${String(rightAddress["name"])}`,
        );
      });
    return JSON.stringify(parsed);
  };
  for (const args of [["--help"], ["pick", "include", "--help"], ["catalog"], ["adapter"]]) {
    const sourceRun = run(
      [process.execPath, "run", "--silent", "--cwd", exportRoot, "tack", "--json", ...args],
      hostile,
      env,
    );
    expect(sourceRun.code, `${args.join(" ")}: ${sourceRun.stderr}`).toBe(0);
    expect(normalize(json(invoke(args)))).toBe(normalize(json(sourceRun)));
  }

  const child = Bun.spawn({
    cmd: [binary, "--json", "docs", "serve", "--project", "demo", "--no-open", "--port", "0"],
    cwd: hostile,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    let output = "";
    const deadline = Date.now() + 30_000;
    while (!output.includes("\n") && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Reader startup timed out.")), 30_000),
        ),
      ]);
      if (next.done) break;
      output += text(next.value);
    }
    const sessionValue: unknown = JSON.parse(output.trim());
    const session = record(sessionValue);
    expect(session["classification"]).toBe("success");
    const url = record(session["result"])["url"];
    if (typeof url !== "string") throw new Error("Missing reader URL.");
    expect((await fetch(url)).status).toBe(200);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }

  const worker = join(moved, "worker.js");
  await rename(worker, `${worker}.missing`);
  expect(
    json(invoke(["script", "run", "check", "--user", "--input-json", "{}"]))["diagnostics"],
  ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "worker_spawn_failed" })]));
  await rename(`${worker}.missing`, worker);

  const engine = join(moved, "packages/reader/src/engine.ts");
  await rename(engine, `${engine}.missing`);
  expect(
    json(invoke(["docs", "serve", "--project", "demo", "--no-open", "--port", "0"]))["diagnostics"],
  ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "reader-startup" })]));
  await rename(`${engine}.missing`, engine);

  const builtins = join(moved, "builtins");
  await rename(builtins, `${builtins}.missing`);
  expect(record(json(invoke(["catalog"]))["result"])["issues"]).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "source-missing" })]),
  );
  await rename(`${builtins}.missing`, builtins);

  const defaultState = { HOME: home, PATH: env.PATH };
  const sourceCommand = (extra: string[] = [], overrides = defaultState) =>
    json(
      run(
        [process.execPath, "run", "--silent", "--cwd", exportRoot, "tack", "--json", ...extra],
        hostile,
        overrides,
      ),
    );
  expect(sourceCommand(["state", "init"])["classification"]).toBe("success");
  expect(record(sourceCommand(["--version"])["result"])["stamp"]).toBe(`${packageVersion}+dev`);
  // A source run always uses the checkout's built-ins, whichever state it reads.
  const checkoutBuiltins = realpathSync(join(exportRoot, "apps/cli/src/builtins"));
  for (const extra of [[], ["--state-dir", state]]) {
    const catalog = record(sourceCommand([...extra, "catalog"])["result"]);
    expect(JSON.stringify(catalog["resources"])).toContain(checkoutBuiltins);
  }
}, 120_000);
