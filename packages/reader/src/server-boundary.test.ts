import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readerProcesses, type ReaderProcess } from "./host.ts";
import { startReader as startProjectReader } from "./server.ts";
import type { ReaderProjectInput } from "./types.ts";

const fixtures: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp("/tmp/tack-reader-boundary-");
  fixtures.push(root);
  await mkdir(join(root, "pages"));
  await writeFile(
    join(root, "pages", "index.mdx"),
    "---\ntitle: Lifecycle boundary\n---\n# Lifecycle boundary\n",
  );
  await writeFile(
    join(root, "tack.reader.yaml"),
    stringify({
      version: 1,
      content: [{ root: "pages", include: ["*.mdx"], exclude: [] }],
      navigation: { preset: "folders" },
      layouts: { preset: "reader" },
      components: { preset: "standard" },
      metadata: { preset: "working-docs" },
    }),
  );
  return root;
}
function readerInput(root: string): ReaderProjectInput {
  return {
    project: { name: "Reader fixture", root },
    resources: [
      {
        sourceRegistrationId: "reader-fixture",

        name: "docs",
        sourcePath: root,
        directoryPath: root,
        readerConfig: { kind: "file", path: "tack.reader.yaml" },
      },
    ],
    issues: [],
  };
}
function startReader(options: {
  worktree: string;
  port?: number;
  open?: boolean;
  diagnostic?: (message: string) => void;
  signal?: AbortSignal;
}) {
  const { worktree, ...rest } = options;
  return startProjectReader({ input: readerInput(worktree), ...rest });
}
const readyUrl = "http://127.0.0.1:4310";
const ready = { type: "ready", url: readyUrl };

/** Models only the subprocess operations owned by the server, without starting browsers or sockets. */
function engine(
  plan: {
    messages?: unknown[];
    exitBeforeReady?: number;
    opener?: "success" | "failure" | "throw" | "pending";
    waitForShutdown?: boolean;
    killFailure?: Error;
  } = {},
) {
  const spawned = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number>();
  const opened = Promise.withResolvers<number>();
  const commands: unknown[] = [];
  const textStream = (value: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(value));
        controller.close();
      },
    });
  const worker = {
    stdout: textStream("engine output\n"),
    stderr: textStream("engine diagnostic\n"),
    exited: exited.promise,
    kill: vi.fn(() => {
      if (plan.waitForShutdown !== true) exited.resolve(0);
      if (plan.killFailure !== undefined) throw plan.killFailure;
    }),
  };
  const browser = {
    exited:
      plan.opener === "pending"
        ? opened.promise
        : Promise.resolve(plan.opener === "failure" ? 1 : 0),
  };
  vi.spyOn(readerProcesses, "spawn").mockImplementation((input: unknown) => {
    if (typeof input !== "object" || input === null) throw new Error("Expected subprocess options");
    if ("cmd" in input) commands.push(input.cmd);
    if ("ipc" in input && typeof input.ipc === "function") {
      const ipc = input.ipc;
      queueMicrotask(() => {
        (plan.messages ?? [ready]).forEach((message) => ipc(message, worker));
        if (plan.exitBeforeReady !== undefined) exited.resolve(plan.exitBeforeReady);
      });
      spawned.resolve();
      return worker;
    }
    if (plan.opener === "throw") throw new Error("Browser opener unavailable");
    // Browser helpers expose only their exit result to the server.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The native browser process mock needs only its exit promise.
    return browser as unknown as ReaderProcess;
  });
  return { spawned: spawned.promise, exited, opened, commands, kill: worker.kill };
}

describe("reader subprocess boundary", () => {
  it("ignores malformed IPC and forwards engine output to the default stderr diagnostic", async () => {
    const root = await fixture();
    const mock = engine({
      messages: [null, { type: "ready", url: 12 }, { type: "unknown" }, ready],
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const server = await startReader({ worktree: root, open: false });
    try {
      expect(server.url).toBe(readyUrl);
      expect(stderr).toHaveBeenCalledWith("engine output\n");
      expect(stderr).toHaveBeenCalledWith("engine diagnostic\n");
      expect(mock.commands).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it.each(["ReaderConfigurationError", "Error"])(
    "reports the worker's %s startup message",
    async (name) => {
      const root = await fixture();
      engine({ messages: [{ type: "error", name, message: "Actionable startup failure" }] });
      await expect(
        startReader({ worktree: root, open: false, diagnostic: () => undefined }),
      ).rejects.toMatchObject({ name, message: "Actionable startup failure" });
    },
  );

  it("reports an engine exit before readiness", async () => {
    const root = await fixture();
    engine({ messages: [], exitBeforeReady: 7 });
    await expect(
      startReader({ worktree: root, open: false, diagnostic: () => undefined }),
    ).rejects.toThrow("Reader engine stopped (exit 7).");
  });

  it("preserves the port failure when the worker exits immediately and removes its abort listener", async () => {
    const root = await fixture();
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    engine({
      messages: [
        { type: "error", name: "ReaderPortInUseError", message: "vendor error", port: 4173 },
      ],
      exitBeforeReady: 1,
    });
    await expect(
      startReader({
        worktree: root,
        open: false,
        signal: controller.signal,
        diagnostic: () => undefined,
      }),
    ).rejects.toMatchObject({
      name: "ReaderPortInUseError",
      port: 4173,
      message: expect.stringContaining("--port"),
    });
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("keeps unexpected startup diagnostics and the original failure on an immediate exit", async () => {
    const root = await fixture();
    engine({
      messages: [{ type: "error", name: "TypeError", message: "Plugin initialization failed" }],
      exitBeforeReady: 1,
    });
    const diagnostics: string[] = [];
    await expect(
      startReader({ worktree: root, open: false, diagnostic: (text) => diagnostics.push(text) }),
    ).rejects.toThrow("Plugin initialization failed");
    expect(diagnostics.join("")).toContain("engine diagnostic");
  });

  it("retains both startup and cleanup failures", async () => {
    const root = await fixture();
    const cleanupError = new Error("Could not terminate reader");
    engine({
      messages: [{ type: "error", name: "Error", message: "Plugin initialization failed" }],
      killFailure: cleanupError,
    });
    await expect(
      startReader({ worktree: root, open: false, diagnostic: () => undefined }),
    ).rejects.toMatchObject({
      name: "AggregateError",
      cause: expect.objectContaining({ message: "Plugin initialization failed" }),
      errors: [expect.objectContaining({ message: "Plugin initialization failed" }), cleanupError],
    });
  });

  it("reports an unexpected exit after readiness through closed", async () => {
    const root = await fixture();
    const mock = engine();
    const server = await startReader({ worktree: root, open: false, diagnostic: () => undefined });
    mock.exited.resolve(9);
    await expect(server.closed).rejects.toThrow("Reader engine stopped (exit 9).");
    await server.close().catch(() => undefined);
  });

  it("aborts an already spawned engine and waits for its termination", async () => {
    const root = await fixture();
    const mock = engine({ messages: [] });
    const controller = new AbortController();
    const pending = startReader({
      worktree: root,
      open: false,
      signal: controller.signal,
      diagnostic: () => undefined,
    });
    await mock.spawned;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("times out startup and terminates an engine that never reports readiness", async () => {
    const root = await fixture();
    const mock = engine({ messages: [] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = startReader({ worktree: root, open: false, diagnostic: () => undefined });
    const failure = expect(pending).rejects.toThrow(
      "Reader engine did not become ready within 60 seconds.",
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await mock.spawned;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(mock.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps concurrent close calls pending until the worker exits", async () => {
    const root = await fixture();
    const mock = engine({ waitForShutdown: true });
    const server = await startReader({ worktree: root, open: false, diagnostic: () => undefined });
    let settled = false;
    const first = server.close();
    const second = server.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    mock.exited.resolve(0);
    await Promise.all([first, second]);
    expect(settled).toBe(true);
  });

  it.each(["darwin", "win32", "linux"] as const)(
    "uses the %s browser opener without waiting for it",
    async (platform) => {
      const root = await fixture();
      const mock = engine({ opener: "pending" });
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      if (descriptor === undefined) throw new Error("Expected a process platform descriptor");
      Object.defineProperty(process, "platform", { value: platform });
      try {
        const server = await startReader({ worktree: root, diagnostic: () => undefined });
        expect(mock.commands[1]).toEqual(
          platform === "darwin"
            ? ["open", readyUrl]
            : platform === "win32"
              ? ["cmd", "/c", "start", "", readyUrl]
              : ["xdg-open", readyUrl],
        );
        mock.opened.resolve(0);
        await server.close();
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    },
  );

  it.each(["failure", "throw"] as const)(
    "prints a usable URL when the browser opener reports %s",
    async (opener) => {
      const root = await fixture();
      engine({ opener });
      const messages: string[] = [];
      const server = await startReader({
        worktree: root,
        diagnostic: (message) => messages.push(message),
      });
      try {
        expect(messages).toContain(`Open ${readyUrl} in your browser.\n`);
      } finally {
        await server.close();
      }
    },
  );
});
