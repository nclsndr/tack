import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runTackSync, sourceEntrypoint, tackEnvironment } from "./support/tack-process.ts";

async function until(check: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 20_000;
  while ((await check()) === false) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(25);
  }
}

async function reservePort(port = 0) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function directChildren(pid: number): number[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]);
  expect(result.exitCode).toBe(0);
  const rows = result.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  return rows
    .filter((row) => row[1] === pid)
    .flatMap((row) => (row[0] === undefined ? [] : [row[0]]));
}

function descendants(pid: number): number[] {
  return directChildren(pid).flatMap((child) => [child, ...descendants(child)]);
}

async function listening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** The temporary reader themes left in one `TMPDIR`. */
async function themes(temporary: string) {
  return (await readdir(temporary)).filter((name) => name.startsWith("tack-reader-theme-"));
}

/** How a scenario ends the reader: a signal to the CLI, or the engine dying under it. */
type Stop = {
  readonly signal: "SIGINT" | "SIGTERM" | "SIGKILL";
  readonly target: "cli" | "engine";
  readonly edit: boolean;
  readonly exitCode: number;
};

it.each<Stop>([
  { signal: "SIGINT", target: "cli", edit: false, exitCode: 130 },
  { signal: "SIGINT", target: "cli", edit: true, exitCode: 130 },
  { signal: "SIGTERM", target: "cli", edit: false, exitCode: 130 },
  // A crashed engine runs none of its own cleanup.
  { signal: "SIGKILL", target: "engine", edit: false, exitCode: 1 },
])(
  "$signal to the $target releases the real reader and its theme (saved edit: $edit)",
  async ({ signal, target, edit, exitCode }) => {
    // Keep failures inspectable; every CLI and compiler write stays in this disposable fixture.
    const root = await realpath(await mkdtemp(join(tmpdir(), "tack-reader-shutdown-")));
    const home = join(root, "home");
    const state = join(root, "state");
    const temporary = join(root, "tmp");
    const project = join(root, "project");
    const source = join(root, "source");
    await Promise.all(
      [home, state, temporary, project, join(source, "knowledge")].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    const isolation = { home, state, temporary };
    const env = tackEnvironment(isolation);
    const git = Bun.spawnSync(["git", "init", project], { env });
    expect(git.exitCode).toBe(0);
    await writeFile(
      join(source, "tack.yaml"),
      "version: 1\ndocs:\n  - name: handbook\n    path: knowledge\n",
    );
    const document = join(source, "knowledge", "index.md");
    await writeFile(document, "# Handbook\n\nOriginal content.\n");
    for (const args of [
      ["state", "init"],
      ["source", "add", source, "--apply"],
      ["project", "add", "demo", "--repository-cwd", project],
      ["docs", "attach", "handbook", "--project", "demo"],
      ["docs", "configure", "--project", "demo", "--default", "handbook"],
      ["sync", "--no-adapters", "--project", "demo"],
      ["sync", "--no-adapters", "--project", "demo", "--apply"],
    ]) {
      const result = runTackSync(["--json", ...args], { ...isolation, cwd: project });
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    }
    const port = await reservePort();
    // The test signals the live process mid-run, so it keeps its own handle on it.
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        sourceEntrypoint,
        "--json",
        "docs",
        "serve",
        "--project",
        "demo",
        "--no-open",
        "--port",
        String(port),
      ],
      cwd: project,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let stdout = "";
    let stderr = "";
    const consume = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
      for await (const chunk of stream) append(new TextDecoder().decode(chunk));
    };
    const streams = Promise.all([
      consume(child.stdout, (text) => {
        stdout += text;
      }),
      consume(child.stderr, (text) => {
        stderr += text;
      }),
    ]);
    let children: number[] = [];
    try {
      await until(
        () => stdout.includes('"command":"docs serve"') && stdout.includes('"status":"success"'),
        "CLI ready envelope",
      );
      children = descendants(child.pid);
      expect(children.length).toBeGreaterThan(0);
      const revision = async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/__tack/status`, {
            signal: AbortSignal.timeout(1000),
          });
          const body: unknown = await response.json();
          return typeof body === "object" &&
            body !== null &&
            "revision" in body &&
            typeof body.revision === "string"
            ? body.revision
            : undefined;
        } catch {
          return undefined;
        }
      };
      const initial = await revision();
      expect(initial).toBeTypeOf("string");
      if (edit === true) {
        await writeFile(document, "# Handbook\n\nSaved edit.\n");
        // The status revision is published only after the replacement compiler finishes.
        await until(async () => {
          const current = await revision();
          return current !== undefined && current !== initial;
        }, "saved-edit compilation");
        children = [...new Set([...children, ...descendants(child.pid)])];
      }
      expect(await themes(temporary)).toHaveLength(1);
      if (target === "cli") child.kill(signal);
      else {
        // The CLI opens no browser here, so its only direct child is the reader engine.
        const [engine, ...others] = directChildren(child.pid);
        expect(others).toEqual([]);
        if (engine === undefined) throw new Error("Expected the reader engine process");
        process.kill(engine, signal);
      }
      await until(() => child.exitCode !== null, "CLI exit");
      expect(await child.exited).toBe(exitCode);
      await streams;
      await until(() => children.every((pid) => alive(pid) === false), "reader children to exit");
      expect(alive(child.pid)).toBe(false);
      expect(await listening(port)).toBe(false);
      expect(await reservePort(port)).toBe(port);
      expect(stdout + stderr).not.toContain("ObjectRef is not unref");
      expect(await themes(temporary)).toEqual([]);
    } finally {
      if (child.exitCode === null) child.kill("SIGINT");
      await until(() => child.exitCode !== null, "cleanup CLI exit");
      await child.exited;
      for (const pid of children) {
        if (alive(pid) === true) process.kill(pid, "SIGTERM");
      }
      await streams;
    }
  },
  60_000,
);
