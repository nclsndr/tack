import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * The runtime gate. It runs one Tack command, a source run or an installed package under Node or
 * Bun, through the operations a user needs from an unrelated directory that holds a hostile `.env`
 * and `bunfig.toml`, with a temporary `HOME` and state. It records every check instead of stopping
 * at the first failure, prints one JSON report, and exits 1 when a check failed.
 *
 * Usage: bun scripts/gate-runtime.ts <label> -- <command...>
 * `GATE_PATH` replaces `PATH` for the command, so a Node lane can prove it needs no Bun.
 * `GATE_ROOT` names the directory for the scratch tree; it defaults to the system temporary directory.
 * `GATE_RUNTIME` (`node` or `bun`) fails the script check when the worker ran under another runtime.
 * `GATE_PACKAGE=1` checks that an installed package links its built-ins from `~/.tack/builtins`.
 * `GATE_TSC` (a `tsc`) checks that `tack types --apply` lets it type a script.
 */
const [label, separator, ...command] = process.argv.slice(2);
const [executable, ...prefix] = command;
if (label === undefined || separator !== "--" || executable === undefined)
  throw new Error("Usage: bun scripts/gate-runtime.ts <label> -- <command...>");

const scratch = realpathSync(
  await mkdtemp(join(process.env["GATE_ROOT"] ?? tmpdir(), `tack-runtime-gate-${label}-`)),
);
const home = join(scratch, "home");
const hostile = join(scratch, "hostile");
const source = join(scratch, "fixture/source");
const project = join(scratch, "fixture/project");
const environment: NodeJS.ProcessEnv = {
  HOME: home,
  PATH: process.env["GATE_PATH"] ?? process.env["PATH"],
  TMPDIR: join(scratch, "tmp"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  NO_PROXY: "127.0.0.1,localhost",
  TACK_API_TOKEN: "gate-s3cret",
};
const plain = join(scratch, "fixture/plain");

type Envelope = Readonly<Record<string, unknown>>;
/** A JSON object's fields, or none for any other value. */
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
type CheckResult = { readonly check: string; readonly ok: boolean; readonly detail?: unknown };
const results: Array<CheckResult> = [];

const tack = (args: ReadonlyArray<string>, cwd = hostile): Envelope => {
  const run = spawnSync(executable, [...prefix, "--json", ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 120_000,
  });
  try {
    const envelope: unknown = JSON.parse(run.stdout);
    return record(envelope);
  } catch {
    throw new Error(`No JSON envelope from ${args.join(" ")}: ${run.stdout}${run.stderr}`);
  }
};
const succeed = (args: ReadonlyArray<string>, cwd = hostile) => {
  const envelope = tack(args, cwd);
  if (envelope["classification"] !== "success")
    throw new Error(`${args.join(" ")}: ${JSON.stringify(envelope["diagnostics"] ?? envelope)}`);
  return envelope;
};
const check = async (name: string, body: () => unknown) => {
  try {
    const detail = await body();
    results.push({ check: name, ok: true, ...(detail === undefined ? {} : { detail }) });
  } catch (error) {
    results.push({ check: name, ok: false, detail: String(error).slice(0, 4000) });
  }
};
const git = (cwd: string, args: ReadonlyArray<string>) => {
  const run = spawnSync(
    "git",
    ["-c", "user.name=Tack", "-c", "user.email=tack@example.test", ...args],
    {
      cwd,
      env: environment,
      encoding: "utf8",
    },
  );
  if (run.status !== 0) throw new Error(run.stderr);
};

const writeFixture = async () => {
  for (const path of [home, hostile, project, join(scratch, "tmp"), join(source, "scripts")])
    await mkdir(path, { recursive: true });
  await mkdir(join(source, "handbook"), { recursive: true });
  await writeFile(join(hostile, ".env"), `TACK_STATE_DIR=${join(scratch, "poisoned")}\n`);
  await writeFile(join(hostile, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  await writeFile(
    join(hostile, "preload.ts"),
    `require("node:fs").writeFileSync(${JSON.stringify(join(scratch, "preloaded"))}, "");\n`,
  );
  await writeFile(
    join(source, "tack.yaml"),
    [
      "version: 1",
      "name: source",
      "scripts:",
      "  - name: gate",
      "    path: scripts/gate.ts",
      "    description: Prove the worker runs.",
      "  - name: shell",
      "    path: scripts/shell.ts",
      "    description: Prove the Shell capability runs.",
      "docs:",
      "  - name: handbook",
      "    path: handbook",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(source, "handbook/index.md"),
    "---\ntitle: Handbook\n---\n# Handbook\n\nSource ownership.\n",
  );
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "runtime-gate-source", private: true, type: "module" }),
  );
  await writeFile(
    join(source, "scripts/gate.ts"),
    `import { defineScript } from "@tackup/cli";
export default defineScript({ run: () => "worker-ran:" + ("Bun" in globalThis ? "bun" : "node") });
`,
  );
  await writeFile(
    join(source, "scripts/shell.ts"),
    `import { defineScript } from "@tackup/cli";
export default defineScript({ run: async ({ exec }) => (await exec("echo", ["shell-ran"])).stdout.trim() });
`,
  );
  // A script-API source installs nothing; a decoy under the API's name must never load.
  await mkdir(join(plain, "scripts"), { recursive: true });
  await mkdir(join(plain, "node_modules/@tackup/cli"), { recursive: true });
  await writeFile(
    join(plain, "node_modules/@tackup/cli/package.json"),
    JSON.stringify({ name: "@tackup/cli", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(plain, "node_modules/@tackup/cli/index.js"),
    'throw new Error("The installed decoy loaded.");\n',
  );
  await writeFile(
    join(plain, "tack.yaml"),
    "version: 1\nname: plain\nscripts:\n  - name: hello\n    path: scripts/hello.ts\n    description: Prove the script API.\n  - name: dialect\n    path: scripts/dialect.ts\n    description: Prove the TypeScript dialect.\n",
  );
  await writeFile(
    join(plain, "scripts/hello.ts"),
    `import { defineScript } from "@tackup/cli";
export default defineScript({
  args: { name: { type: "string" }, times: { type: "number", default: 1 } },
  secrets: ["API_TOKEN"],
  run: async ({ args, secrets, exec, fs, log }) => {
    log("token", secrets.API_TOKEN);
    const echoed = (await exec("echo", ["exec-ran"])).stdout.trim();
    await fs.writeJson("gate-out/hello.json", { name: args.name });
    return {
      greeting: "Hello, " + args.name,
      times: args.times,
      echoed,
      written: await fs.list("gate-out/*.json"),
      token: secrets.API_TOKEN,
      runtime: "Bun" in globalThis ? "bun" : "node",
    };
  },
});
`,
  );
  // Bun's TypeScript dialect, which Node's own type stripping refuses.
  await writeFile(
    join(plain, "scripts/shape.ts"),
    "export type Shape = { readonly tone: string };\n",
  );
  await writeFile(join(plain, "scripts/data.json"), '{ "from": "json" }\n');
  await writeFile(
    join(plain, "scripts/dialect.ts"),
    `import { defineScript } from "@tackup/cli";
import { Shape } from "./shape";
import data from "./data.json";
enum Tone { Warm = "warm", Dry = "dry" }
class Greeter { constructor(private readonly tone: Tone) {} shape(): Shape { return { tone: this.tone }; } }
export default defineScript({ run: () => ({ ...new Greeter(Tone.Dry).shape(), ...data }) });
`,
  );
  git(scratch, ["init", "--quiet", project]);
  git(project, ["commit", "--quiet", "--allow-empty", "-m", "init"]);
};

/** Serves the docs on a free port, fetches the index page, then stops the reader it started. */
const readerServesPage = () =>
  new Promise<unknown>((resolve, reject) => {
    const started = performance.now();
    const child = spawn(
      executable,
      [...prefix, "--json", "docs", "serve", "--project", "gate", "--no-open", "--port", "0"],
      { cwd: hostile, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    let output = "";
    let errors = "";
    let finished = false;
    const finish = (error: Error | undefined, value?: unknown) => {
      if (finished === true) return;
      finished = true;
      clearTimeout(timer);
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      } catch {
        // The reader already exited.
      }
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const timer = setTimeout(
      () => finish(new Error(`The reader did not start in time: ${output}${errors.slice(-3000)}`)),
      120_000,
    );
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("\n") === false) return;
      void (async () => {
        try {
          const session: unknown = JSON.parse(output.trim().split("\n")[0] ?? "");
          const url = record(record(session)["result"])["url"];
          if (typeof url !== "string") throw new Error(`No reader session: ${output}`);
          const response = await fetch(url);
          if (response.status !== 200) throw new Error(`The reader returned ${response.status}.`);
          finish(undefined, { readyMs: Math.round(performance.now() - started) });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
    child.on("exit", (code) =>
      finish(new Error(`The reader exited with ${code}: ${output}${errors.slice(-3000)}`)),
    );
  });

await writeFixture();
await check("version", () => {
  return { stamp: record(succeed(["--version"])["result"])["stamp"] };
});
await check("init", () => {
  succeed(["state", "init"]);
});
await check("caller-configuration", () => {
  if (existsSync(join(scratch, "poisoned/state.json")) || existsSync(join(scratch, "preloaded")))
    throw new Error("The caller's directory configured Tack.");
});
await check("catalog", () => {
  const resources = JSON.stringify(record(succeed(["catalog"])["result"])["resources"]);
  for (const skill of ["use-tack", "manage-tack-sources"])
    if (resources.includes(`"name":"${skill}"`) === false) throw new Error(`No built-in ${skill}.`);
});
await check("reconcile-user", () => {
  succeed(["adapter", "enable", "claude"]);
  succeed(["sync", "--user", "--apply"]);
  for (const skill of ["use-tack", "manage-tack-sources"]) {
    const file = join(home, ".claude/skills", skill, "SKILL.md");
    if (
      existsSync(file) === false ||
      readFileSync(file, "utf8").includes(`name: ${skill}`) === false
    )
      throw new Error(`The delivered ${skill} link has no readable SKILL.md.`);
  }
  const target = realpathSync(join(home, ".claude/skills/use-tack"));
  // A package copies its built-ins out of the package manager's tree, into ~/.tack/builtins/<stamp>.
  if (
    process.env["GATE_PACKAGE"] === "1" &&
    target.startsWith(join(home, ".tack/builtins/")) === false
  )
    throw new Error(`The built-in skills link into ${target}, not ~/.tack/builtins.`);
  return { useTack: target };
});
if (process.env["GATE_PACKAGE"] === "1")
  await check("builtins-prune", () => {
    // Copies left by other versions: an old one, an old one a link still uses, a newer previous one.
    const builtins = join(home, ".tack/builtins");
    const copy = (version: string, seconds: number) => {
      mkdirSync(join(builtins, version, "skills/probe"), { recursive: true });
      writeFileSync(join(builtins, version, ".tack-complete"), "");
      utimesSync(join(builtins, version, ".tack-complete"), seconds, seconds);
    };
    copy("0.0.1+gold", 1000);
    copy("0.0.2+glinked", 2000);
    copy("0.0.3+gprevious", 3000);
    mkdirSync(join(home, ".agents/skills"), { recursive: true });
    symlinkSync(
      join(builtins, "0.0.2+glinked/skills/probe"),
      join(home, ".agents/skills/linked-probe"),
    );
    succeed(["sync", "--user", "--apply"]);
    const left = readdirSync(builtins).toSorted();
    if (
      left.includes("0.0.1+gold") ||
      ["0.0.2+glinked", "0.0.3+gprevious"].some((version) => left.includes(version) === false)
    )
      throw new Error(`Unexpected built-ins copies after sync: ${left.join(", ")}`);
    return left;
  });
await check("source-add", () => {
  succeed(["source", "add", source, "--apply"]);
  succeed(["project", "add", "gate"], project);
});
await check("script-run", () => {
  const output = JSON.stringify(succeed(["script", "run", "gate", "--user", "--input-json", "{}"]));
  const ran = /worker-ran:(node|bun)/.exec(output)?.[1];
  if (ran === undefined) throw new Error(`The script produced no output: ${output}`);
  const expected = process.env["GATE_RUNTIME"];
  if (expected !== undefined && ran !== expected)
    throw new Error(`The worker ran under ${ran}, not ${expected}.`);
  return `worker-ran:${ran}`;
});
await check("script-shell", () => {
  const output = JSON.stringify(
    succeed(["script", "run", "shell", "--user", "--input-json", "{}"]),
  );
  if (output.includes("shell-ran") === false) throw new Error(`No Shell output: ${output}`);
});
await check("script-api", () => {
  succeed(["source", "add", plain, "--apply"]);
  const envelope = succeed([
    "script",
    "run",
    "hello",
    "--user",
    "--input-json",
    JSON.stringify({ name: "Ada" }),
  ]);
  const output = JSON.stringify(envelope);
  for (const expected of [
    '"greeting":"Hello, Ada"',
    '"times":1',
    '"echoed":"exec-ran"',
    '"written":["gate-out/hello.json"]',
    '"token":"<redacted>"',
  ])
    if (output.includes(expected) === false) throw new Error(`No ${expected} in ${output}`);
  if (output.includes("gate-s3cret")) throw new Error("A secret value reached the result.");
  const runtime = /"runtime":"(node|bun)"/.exec(output)?.[1];
  const expected = process.env["GATE_RUNTIME"];
  if (expected !== undefined && runtime !== expected)
    throw new Error(`The script ran under ${runtime}, not ${expected}.`);
  return `script-api-ran:${runtime}`;
});
await check("script-dialect", () => {
  const output = JSON.stringify(
    succeed(["script", "run", "dialect", "--user", "--input-json", "{}"]),
  );
  if (output.includes('"tone":"dry"') === false || output.includes('"from":"json"') === false)
    throw new Error(`The dialect script did not run: ${output}`);
});
const tsc = process.env["GATE_TSC"];
if (tsc !== undefined)
  await check("script-api-types", async () => {
    // The command under test writes the stub and a tsconfig.json, which tsc then has to honor.
    succeed(["types", plain, "--apply"]);
    await writeFile(
      join(plain, "scripts/misuse.ts"),
      `import { defineScript } from "@tackup/cli";
export default defineScript({
  args: { name: { type: "string" } },
  run: async ({ args, secrets, fs }) => {
    void args.nmae;
    void secrets.UNDECLARED;
    await fs.write("x", 1);
  },
});
`,
    );
    const run = spawnSync(tsc, ["-p", "."], { cwd: plain, encoding: "utf8" });
    const errors = run.stdout.split("\n").filter((line) => line.includes("error TS"));
    if (
      errors.length !== 3 ||
      errors.some((line) => line.startsWith("scripts/misuse.ts") === false)
    )
      throw new Error(`Expected exactly the 3 planted errors in misuse.ts:\n${run.stdout}`);
    return errors.map((line) => line.replace(/^.*error /, ""));
  });
await check("reader-search", () => {
  succeed(["docs", "attach", "handbook", "--project", "gate"]);
  succeed(["sync", "--project", "gate", "--apply"]);
  const hits = record(
    succeed(["docs", "search", "ownership", "--project", "gate", "--limit", "1"])["result"],
  )["hits"];
  if (Array.isArray(hits) === false || hits.length !== 1) throw new Error("No search hit.");
});
await check("reader-http", readerServesPage);

const failed = results.filter((result) => result.ok === false);
process.stdout.write(
  `${JSON.stringify({ label, path: environment["PATH"]?.split(delimiter), scratch, results }, null, 1)}\n`,
);
process.stdout.write(
  `SUMMARY ${label} passed=${results.length - failed.length}/${results.length}${failed.length === 0 ? "" : ` failed=${failed.map((result) => result.check).join(",")}`}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
