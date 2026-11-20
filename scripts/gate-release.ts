import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * The artifact half of the release gate. It proves a built release works from an unrelated
 * directory that holds a hostile `.env` and `bunfig.toml`, with a temporary `HOME` and state and no
 * Bun on `PATH`. The last line of its output names the failed check, or lists the passed ones.
 */
const [release, stamp, operatorHome] = process.argv.slice(2);
if (
  release === undefined ||
  stamp === undefined ||
  operatorHome === undefined ||
  !isAbsolute(release) ||
  !isAbsolute(operatorHome)
)
  throw new Error("Pass the absolute release directory, expected stamp, and operator home.");

class GateFailure extends Error {
  readonly check: string;

  constructor(check: string, detail: string) {
    super(detail);
    this.check = check;
  }
}

// The reader runs on this machine, so a proxy that is down must not fail its check.
process.env["NO_PROXY"] = "127.0.0.1,localhost";

/** The skills every release delivers to user skill directories. */
const builtInSkills = ["use-tack", "manage-tack-sources"] as const;

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

const scratch = await realpath(await mkdtemp(join(tmpdir(), "tack-gate-")));
const home = join(scratch, "home");
const hostile = join(scratch, "hostile");
const poisonedState = join(scratch, "poisoned");
const preloaded = join(scratch, "preloaded");
const fixture = join(scratch, "fixture");
const source = join(fixture, "source");
const project = join(fixture, "project");
const executable = join(release, "bin/tack");
const gitDirectory = dirname(Bun.which("git") ?? "/usr/bin/git");
const environment = {
  HOME: home,
  PATH: `${join(release, "bin")}:${gitDirectory}:/usr/bin:/bin`,
};

const passed: Array<string> = [];
const tack = (check: string, args: ReadonlyArray<string>, cwd = hostile) => {
  const result = Bun.spawnSync({
    cmd: [executable, "--json", ...args],
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const stdout = text(result.stdout);
  try {
    const parsed: unknown = JSON.parse(stdout);
    return record(parsed);
  } catch {
    throw new GateFailure(check, `No JSON envelope: ${stdout}${text(result.stderr)}`);
  }
};
const expectSuccess = (check: string, args: ReadonlyArray<string>, cwd = hostile) => {
  const envelope = tack(check, args, cwd);
  if (envelope["classification"] !== "success")
    throw new GateFailure(check, JSON.stringify(envelope["diagnostics"]));
  return envelope;
};
const git = (cwd: string, args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync({
    cmd: ["git", "-c", "user.name=Tack", "-c", "user.email=tack@example.test", ...args],
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new GateFailure("fixture", text(result.stderr));
};
const check = async (name: string, body: () => void | Promise<void>) => {
  await body();
  passed.push(name);
};

const writeFixture = async () => {
  for (const path of [home, hostile, project, join(source, "scripts"), join(source, "handbook")])
    await mkdir(path, { recursive: true });
  await Bun.write(join(hostile, ".env"), `TACK_STATE_DIR=${poisonedState}\n`);
  await Bun.write(join(hostile, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  await Bun.write(
    join(hostile, "preload.ts"),
    `await Bun.write(${JSON.stringify(preloaded)}, "");\n`,
  );
  await Bun.write(
    join(source, "tack.yaml"),
    "version: 1\nscripts:\n  - name: gate\n    path: scripts/gate.ts\n    description: Prove the worker runs.\ndocs:\n  - name: handbook\n    path: handbook\n",
  );
  await Bun.write(
    join(source, "handbook/index.md"),
    "---\ntitle: Handbook\n---\n# Handbook\n\nSource ownership.\n",
  );
  // A script-API script installs nothing: the release provides "@tackup/cli" itself.
  await Bun.write(
    join(source, "scripts/gate.ts"),
    `
import { defineScript } from "@tackup/cli";
export default defineScript({ run: () => "worker-ran" });
`,
  );
  git(scratch, ["init", "--quiet", project]);
  git(project, ["commit", "--quiet", "--allow-empty", "-m", "init"]);
};

const readerReturnsPage = async () => {
  const child = Bun.spawn({
    cmd: [executable, "--json", "docs", "serve", "--project", "gate", "--no-open", "--port", "0"],
    cwd: hostile,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.write(join(scratch, "reader.pid"), String(child.pid));
  try {
    const reader = child.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new GateFailure("reader-http", "The reader did not start in time.")),
        60_000,
      );
    });
    let output = "";
    while (!output.includes("\n")) {
      const next = await Promise.race([reader.read(), timedOut]);
      if (next.done) break;
      output += text(next.value);
    }
    clearTimeout(timer);
    let url: unknown;
    try {
      const session: unknown = JSON.parse(output.trim());
      url = record(record(session)["result"])["url"];
    } catch {
      throw new GateFailure("reader-http", `No reader session: ${output}`);
    }
    if (typeof url !== "string") throw new GateFailure("reader-http", output);
    const status = await fetch(url).then(
      (response) => response.status,
      (error: unknown) => String(error),
    );
    if (status !== 200) throw new GateFailure("reader-http", `The reader returned ${status}.`);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
};

const gate = async () => {
  await writeFixture();
  await check("version", async () => {
    const result = record(expectSuccess("version", ["--version"])["result"]);
    if (result["stamp"] !== stamp)
      throw new GateFailure("version", `Expected ${stamp}, found ${String(result["stamp"])}.`);
    const format = record(await Bun.file(join(release, "state-format.json")).json());
    if (typeof result["stateFormat"] !== "number")
      throw new GateFailure("version", "The candidate did not report its state format.");
    if (result["stateFormat"] !== format["stateFormat"])
      throw new GateFailure(
        "version",
        "The release record disagrees with the candidate's state format.",
      );
  });
  // The candidate must read the operator's state file. A copy is read, never the file itself.
  await check("state-compatibility", async () => {
    const currentPath = join(operatorHome, ".tack", "state.json");
    if (!(await Bun.file(currentPath).exists())) return;
    const directory = join(scratch, "state-compatibility");
    await mkdir(directory);
    await Bun.write(join(directory, "state.json"), Bun.file(currentPath));
    const envelope = tack("state-compatibility", ["--state-dir", directory, "status", "--all"]);
    if (envelope["result"] !== null && envelope["result"] !== undefined) return;
    throw new GateFailure(
      "state-compatibility",
      `Candidate cannot read current state: ${JSON.stringify(envelope["diagnostics"])}`,
    );
  });
  await check("init", () => {
    expectSuccess("init", ["state", "init"]);
  });
  await check("caller-configuration", async () => {
    const ignored = await Promise.all(
      [poisonedState, preloaded].map((path) => Bun.file(join(path, "state.json")).exists()),
    );
    const preloadRan = await Bun.file(preloaded).exists();
    if (ignored.includes(true) || preloadRan)
      throw new GateFailure("caller-configuration", "The caller's directory configured Tack.");
  });
  await check("catalog", () => {
    const result = record(expectSuccess("catalog", ["catalog"])["result"]);
    if (result["complete"] !== true) throw new GateFailure("catalog", "The catalog is incomplete.");
    for (const skill of builtInSkills)
      if (!JSON.stringify(result["resources"]).includes(`"name":"${skill}"`))
        throw new GateFailure("catalog", `The catalog does not list the built-in ${skill} skill.`);
  });
  await check("reconcile-user", async () => {
    expectSuccess("reconcile-user", ["adapter", "enable", "claude"]);
    expectSuccess("reconcile-user", ["sync", "--user", "--apply"]);
    for (const name of builtInSkills) {
      const skill = Bun.file(join(home, ".claude/skills", name, "SKILL.md"));
      if (!(await skill.exists()) || !(await skill.text()).includes(`name: ${name}`))
        throw new GateFailure(
          "reconcile-user",
          `The delivered ${name} link has no readable SKILL.md.`,
        );
    }
  });
  await check("script-run", () => {
    expectSuccess("script-run", ["source", "add", source]);
    expectSuccess("script-run", ["project", "add", "gate"], project);
    const envelope = expectSuccess("script-run", [
      "script",
      "run",
      "gate",
      "--user",
      "--input-json",
      "{}",
    ]);
    if (!JSON.stringify(envelope["result"]).includes("worker-ran"))
      throw new GateFailure("script-run", "The script produced no output.");
  });
  await check("reader-search", () => {
    expectSuccess("reader-search", ["docs", "attach", "handbook", "--project", "gate"]);
    expectSuccess("reader-search", ["sync", "--project", "gate", "--apply"]);
    const result = record(
      expectSuccess("reader-search", [
        "docs",
        "search",
        "ownership",
        "--project",
        "gate",
        "--limit",
        "1",
      ])["result"],
    );
    if (!Array.isArray(result["hits"]) || result["hits"].length !== 1)
      throw new GateFailure("reader-search", "Reader search did not find the fixture document.");
  });
  await check("reader-http", readerReturnsPage);
};

let failure: GateFailure | undefined;
try {
  await gate();
} catch (error) {
  failure =
    error instanceof GateFailure
      ? error
      : new GateFailure("gate", error instanceof Error ? error.message : String(error));
}
await rm(scratch, { recursive: true, force: true });
if (failure !== undefined) {
  process.stdout.write(`${JSON.stringify({ failed: failure.check, detail: failure.message })}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ passed })}\n`);
