import { encodeStateFixture } from "./support/state-fixture.ts";
import { mkdir, mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Ref, Stdio } from "effect";
import { runCli } from "../src/cli/host/run.ts";
import { Reader, ReaderStartupError, type ReaderService } from "../src/services/reader.ts";
import { makeReaderService } from "../src/platform/reader/reader.ts";
import { TestClock } from "effect/testing";
import { Git } from "../src/services/git.ts";
import { captureStdio } from "./support/host-runner.ts";
import { readerCacheDirectory } from "../src/features/reader/reader-cache.ts";
import { existsSync } from "node:fs";

const unusedGit = Git.of({
  resolveCommonDirectory: () => Effect.die("Reader must not discover project registrations."),
  listWorktrees: () => Effect.die("Reader must not discover other worktrees."),
});

const hostFixture = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  const root = yield* Effect.acquireRelease(
    Effect.promise(async () => realpath(await mkdtemp(join(tmpdir(), "tack-reader-host-")))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
  yield* Effect.promise(() =>
    writeFile(
      join(root, "state.json"),
      encodeStateFixture({
        version: 1,
        data: {
          projects: [{ name: "demo", gitCommonDirectory: join(root, "git"), roots: [root] }],
        },
      }),
    ),
  );
  const registeredArgs = [
    "--state-dir",
    root,
    ...args.filter((value, index) => value !== "--cwd" && args[index - 1] !== "--cwd"),
    "--project",
    "demo",
  ];
  const ready = yield* Deferred.make<void>();
  const { stdio, stdout, stderr } = yield* captureStdio(
    ["--json", ...registeredArgs],
    Deferred.succeed(ready, undefined),
  );
  return { stdout, stderr, ready, stdio, root };
});

it.effect("cancels engine startup before readiness and emits one interruption envelope", () =>
  Effect.gen(function* () {
    const fixture = yield* hostFixture(["docs", "serve"]);
    const started = yield* Deferred.make<void>();
    let aborted = false;
    const underlying = makeReaderService(
      (options) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ url: "http://127.0.0.1:3000", close: async () => undefined }),
            100,
          );
          options.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              aborted = true;
              reject(new DOMException("Startup cancelled", "AbortError"));
            },
            { once: true },
          );
          Deferred.doneUnsafe(started, Effect.void);
        }),
    );
    const reader = Reader.of(underlying);
    const fiber = yield* runCli().pipe(
      Effect.provideService(Reader, reader),
      Effect.provideService(Stdio.Stdio, fixture.stdio),
      Effect.provideService(Git, unusedGit),
      Effect.provide(LiveTestLayer),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(aborted).toBe(true);
    expect(JSON.parse(yield* fixture.stdout)).toMatchObject({
      command: "docs serve",
      classification: "interruption",
      result: null,
    });
    expect((yield* fixture.stdout).trim().split("\n")).toHaveLength(1);
  }),
);

it.effect.each([
  { cache: "held by this session", busy: false },
  { cache: "busy with another session", busy: true },
])(
  "emits readiness once, waits in the foreground, and closes on interruption (cache $cache)",
  ({ busy }) =>
    Effect.gen(function* () {
      const fixture = yield* hostFixture([
        "docs",
        "serve",
        "--cwd",
        "/tmp/worktree",
        "--port",
        "0",
        "--no-open",
      ]);
      const project = { name: "demo", root: fixture.root };
      // The project's cache lives under the state directory; a live process may already hold it.
      const cacheDirectory = readerCacheDirectory(fixture.root, project);
      const lock = join(cacheDirectory, "session.lock");
      if (busy === true) {
        yield* Effect.promise(async () => {
          await mkdir(cacheDirectory, { recursive: true });
          await writeFile(lock, `${process.pid}\n`);
        });
      }
      const closed = yield* Ref.make(0);
      const requests = yield* Ref.make<ReadonlyArray<Parameters<ReaderService["start"]>[0]>>([]);
      const reader = Reader.of({
        start: (request) =>
          Effect.gen(function* () {
            yield* Ref.update(requests, (previous) => [...previous, request]);
            return {
              url: "http://127.0.0.1:3000",
              close: Ref.update(closed, (count) => count + 1),
            };
          }),
      });
      const fiber = yield* runCli().pipe(
        Effect.provideService(Reader, reader),
        Effect.provideService(Stdio.Stdio, fixture.stdio),
        Effect.provideService(Git, unusedGit),
        Effect.provide(LiveTestLayer),
        Effect.forkChild,
      );
      yield* Deferred.await(fixture.ready);
      expect(JSON.parse(yield* fixture.stdout)).toMatchObject({
        command: "docs serve",
        classification: "success",
        result: {
          kind: "reader-session",
          url: "http://127.0.0.1:3000",
          project: { name: "demo", root: fixture.root },
        },
      });
      // A busy cache leaves the reader to build from a private one; the session starts anyway.
      expect(yield* Ref.get(requests)).toEqual([
        {
          input: { project, resources: [], issues: [] },
          ...(busy === true ? {} : { cacheDirectory }),
          port: 0,
          open: false,
        },
      ]);
      expect(existsSync(lock)).toBe(true);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(yield* Ref.get(closed)).toBe(1);
      // The session releases only its own hold.
      expect(existsSync(lock)).toBe(busy);
      expect((yield* fixture.stdout).trim().split("\n")).toHaveLength(1);
    }),
);

it.effect(
  "ends an unexpectedly stopped reader after readiness without a second JSON envelope",
  () =>
    Effect.gen(function* () {
      for (const failureMessage of ["Reader worker exited unexpectedly.", undefined]) {
        const fixture = yield* hostFixture(["docs", "serve"]);
        const closed = yield* Ref.make(0);
        const reader = Reader.of({
          start: () =>
            Effect.succeed({
              url: "http://127.0.0.1:3000",
              close: Ref.update(closed, (count) => count + 1),
              closed:
                failureMessage !== undefined
                  ? Effect.fail(
                      new ReaderStartupError({
                        kind: "engine",
                        message: failureMessage,
                      }),
                    )
                  : Effect.void,
            }),
        });
        const exit = yield* runCli().pipe(
          Effect.provideService(Reader, reader),
          Effect.provideService(Stdio.Stdio, fixture.stdio),
          Effect.provideService(Git, unusedGit),
          Effect.provide(LiveTestLayer),
          Effect.exit,
          Effect.timeout("100 millis"),
          TestClock.withLive,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* Ref.get(closed)).toBe(1);
        expect((yield* fixture.stdout).trim().split("\n")).toHaveLength(1);
        expect(yield* fixture.stderr).toBe(
          failureMessage !== undefined
            ? "Reader worker exited unexpectedly.\n"
            : "The reader engine stopped unexpectedly.\n",
        );
      }
    }),
);

it.effect("renders actionable reader startup failures without initializing state", () =>
  Effect.gen(function* () {
    for (const kind of ["configuration", "port-in-use", "engine"] as const) {
      const fixture = yield* hostFixture(["docs", "serve"]);
      const reader = Reader.of({
        start: () =>
          Effect.fail(
            new ReaderStartupError({
              kind,
              message: "Required reader configuration is missing: reader/handbook.yaml",
            }),
          ),
      });
      yield* Effect.exit(
        runCli().pipe(
          Effect.provideService(Reader, reader),
          Effect.provideService(Stdio.Stdio, fixture.stdio),
          Effect.provideService(Git, unusedGit),
          Effect.provide(LiveTestLayer),
        ),
      );
      expect(JSON.parse(yield* fixture.stdout)).toMatchObject({
        command: "docs serve",
        classification: kind === "configuration" ? "invalid-configuration" : "domain",
        diagnostics: [
          {
            code:
              kind === "configuration"
                ? "reader-configuration"
                : kind === "port-in-use"
                  ? "reader-port-in-use"
                  : "reader-startup",
            message: "Required reader configuration is missing: reader/handbook.yaml",
          },
        ],
      });
    }
  }),
);
