import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ReaderConfigurationError } from "./config.ts";
import type { ReaderProjectInput } from "./types.ts";
import { z } from "zod";
import { readerProcesses, type ReaderProcess } from "./host.ts";
import { readerEntry } from "./reader-files.ts";
import { ReaderPortInUseError } from "./startup-error.ts";

const compiledRelease = import.meta.url.includes("$bunfs");
const enginePath = compiledRelease
  ? join(dirname(dirname(realpathSync(process.execPath))), "packages/reader/src/engine.ts")
  : readerEntry("engine");

export type ReaderOptions = {
  input: ReaderProjectInput;
  /** The Tack release stamp the reader shows; the reader package cannot read the CLI's own. */
  version?: string;
  /**
   * A directory this session holds alone, such as one its caller locked for the project. The engine
   * builds its theme in `theme`, removed on exit, and keeps Rspack's build cache in `build`, so the
   * next session at the same path reuses it. Rspack keys that cache on absolute paths, so only a
   * stable directory lets it hit. Without one, the session builds in a private temporary theme,
   * from a cold cache.
   */
  cacheDirectory?: string;
  port?: number;
  open?: boolean;
  diagnostic?: (message: string) => void;
  signal?: AbortSignal;
};
export type ReaderServer = { url: string; close: () => Promise<void>; closed: Promise<void> };
const readyMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), url: z.string() }),
  z.object({
    type: z.literal("error"),
    name: z.string(),
    message: z.string(),
    port: z.number().int().min(0).max(65535).optional(),
  }),
]);
/** What the engine process sends once it starts: its URL, or why it could not start. */
export type EngineStartMessage = z.input<typeof readyMessage>;

/** Where one session builds: its theme, removed once the engine exits, and Rspack's build cache. */
type BuildDirectories = { theme: string; buildCache: string };

/**
 * Prepares an empty theme in the session's cache directory, or a private temporary one that also
 * holds its build cache, so both go together.
 */
async function buildDirectories(cacheDirectory: string | undefined): Promise<BuildDirectories> {
  if (cacheDirectory === undefined) {
    const theme = await mkdtemp(join(tmpdir(), "tack-reader-theme-"));
    return { theme, buildCache: join(theme, "build") };
  }
  const theme = join(cacheDirectory, "theme");
  // A session that could not clean up leaves its theme, whose page proxies no longer match.
  await rm(theme, { recursive: true, force: true });
  await mkdir(theme, { recursive: true });
  return { theme, buildCache: join(cacheDirectory, "build") };
}

/** Spawns the engine that builds into `directories`; its IPC settles `ready` with the URL or a failure. */
function spawnEngine(
  options: ReaderOptions,
  directories: BuildDirectories,
  ready: PromiseWithResolvers<string>,
): ReaderProcess {
  return readerProcesses.spawn({
    cmd: [
      process.execPath,
      enginePath,
      JSON.stringify({
        input: options.input,
        port: options.port ?? 4173,
        ...directories,
        ...(options.version === undefined ? {} : { version: options.version }),
      }),
    ],
    cwd: options.input.project.root,
    env: compiledRelease ? { ...process.env, BUN_BE_BUN: "1" } : process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ipc(message) {
      const parsed = readyMessage.safeParse(message);
      if (parsed.success === false) return;
      if (parsed.data.type === "ready") ready.resolve(parsed.data.url);
      else {
        const error =
          parsed.data.name === "ReaderConfigurationError"
            ? new ReaderConfigurationError(parsed.data.message)
            : parsed.data.name === "ReaderPortInUseError" && parsed.data.port !== undefined
              ? new ReaderPortInUseError(parsed.data.port)
              : new Error(parsed.data.message);
        ready.reject(error);
      }
    },
  });
}

/**
 * Starts one isolated Rspress process with logs separated from Tack's public stdout. The engine
 * loads the corpus itself, and reports a corpus it cannot serve through its startup error.
 */
export async function startReader(options: ReaderOptions): Promise<ReaderServer> {
  options.signal?.throwIfAborted();
  let stopping = false;
  const ready = Promise.withResolvers<string>();
  const diagnostic = options.diagnostic ?? ((message) => process.stderr.write(message));
  // The server owns the engine's generated theme: the engine can stop without its own cleanup (a
  // crash, or Rsbuild's forced exit on a signal), so the theme goes once the engine has exited.
  const directories = await buildDirectories(options.cacheDirectory);
  const { theme } = directories;
  const removeTheme = () =>
    rm(theme, { recursive: true, force: true }).catch((error: unknown) => {
      diagnostic(
        `Could not remove the reader theme ${theme}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  let worker: ReaderProcess;
  try {
    // An abort while the theme was created spawns no engine.
    options.signal?.throwIfAborted();
    worker = spawnEngine(options, directories, ready);
  } catch (error) {
    await removeTheme();
    throw error;
  }
  const forward = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const next = await reader.read();
      if (next.done === true) break;
      diagnostic(decoder.decode(next.value, { stream: true }));
    }
  };
  const outputs = Promise.all([forward(worker.stdout), forward(worker.stderr)]);
  const closed = worker.exited.then(async (code) => {
    await outputs;
    await removeTheme();
    if (stopping === false) {
      const error = new Error(`Reader engine stopped (exit ${code}).`);
      ready.reject(error);
      throw error;
    }
  });
  void closed.catch(() => undefined);
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stopping = true;
      options.signal?.removeEventListener("abort", abort);
      worker.kill("SIGTERM");
      await worker.exited;
      await outputs;
      // The exit outcome is observed through closed; cleanup still waits for its settlement.
      await closed.catch(() => undefined);
    })());
  const abort = () => {
    void close();
    ready.reject(
      options.signal?.reason ?? new DOMException("Reader startup interrupted.", "AbortError"),
    );
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    ready.reject(new Error("Reader engine did not become ready within 60 seconds."));
    void close();
  }, 60_000);
  timer.unref();
  try {
    const url = await ready.promise;
    if (options.open !== false) {
      try {
        const command =
          process.platform === "darwin"
            ? (["open", url] as const)
            : process.platform === "win32"
              ? (["cmd", "/c", "start", "", url] as const)
              : (["xdg-open", url] as const);
        const browser = readerProcesses.spawn({
          cmd: command,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        void browser.exited.then((code) => {
          if (code !== 0) diagnostic(`Open ${url} in your browser.\n`);
        });
      } catch {
        diagnostic(`Open ${url} in your browser.\n`);
      }
    }
    return {
      url,
      close,
      closed,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains both failures; the startup failure remains the primary cause.
      throw new AggregateError([error, cleanupError], "Reader startup and cleanup failed.", {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
