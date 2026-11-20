import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";
import { Reader, type ReaderOptions } from "../../services/reader.ts";
import { currentVersionReport } from "../../version.ts";
import { ReaderLive, makeReaderService, type ReaderStarter } from "./reader.ts";

const projectInput = { project: { name: "demo", root: "/worktree" }, resources: [], issues: [] };

const liveStart = vi.hoisted(() =>
  vi.fn<
    (
      options: ReaderOptions & {
        readonly diagnostic: (message: string) => void;
        readonly version: string;
      },
    ) => ReturnType<ReaderStarter>
  >(),
);
vi.mock("@tackup/reader/server", () => ({ startReader: liveStart }));

it.effect("loads the live engine lazily and preserves diagnostic chunks on stderr", () =>
  Effect.gen(function* () {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      liveStart.mockImplementation(async (options) => {
        options.diagnostic("Reader engine ");
        options.diagnostic("is starting.\n");
        return { url: "http://127.0.0.1:1234", close: async () => undefined };
      });
      const reader = yield* Reader;
      const session = yield* reader.start({
        input: projectInput,
        open: false,
      });
      expect(session.url).toBe("http://127.0.0.1:1234");
      expect(liveStart.mock.calls[0]?.[0].version).toBe(currentVersionReport().stamp);
      expect(stderr.mock.calls.map(([chunk]) => chunk).join("")).toBe(
        "Reader engine is starting.\n",
      );
      yield* session.close;
    } finally {
      stderr.mockRestore();
      liveStart.mockReset();
    }
  }).pipe(Effect.provide(ReaderLive)),
);

it.effect("adapts the reader resource and preserves the explicit startup options", () =>
  Effect.gen(function* () {
    let closed = 0;
    const options = {
      input: projectInput,
      port: 0,
      open: false,
    };
    const service = makeReaderService(async (received) => {
      expect(received).toMatchObject(options);
      expect(received.signal).toBeInstanceOf(AbortSignal);
      return {
        url: "http://127.0.0.1:1234",
        close: async () => {
          closed += 1;
        },
      };
    });
    const session = yield* service.start(options);
    expect(session.url).toBe("http://127.0.0.1:1234");
    expect(session.closed).toBeUndefined();
    yield* session.close;
    expect(closed).toBe(1);
  }),
);

it.effect("classifies configuration errors and retains actionable startup messages", () =>
  Effect.gen(function* () {
    const inputs = [
      {
        error: Object.assign(new Error("missing config"), { name: "ReaderConfigurationError" }),
        kind: "configuration",
        message: "missing config",
      },
      {
        error: { _tag: "ReaderConfigurationError" },
        kind: "configuration",
        message: "The reader engine could not start.",
      },
      { error: new Error("port in use"), kind: "engine", message: "port in use" },
      {
        error: Object.assign(new Error("Reader port 4173 is already in use. Use --port 0."), {
          name: "ReaderPortInUseError",
        }),
        kind: "port-in-use",
        message: "Reader port 4173 is already in use. Use --port 0.",
      },
      { error: undefined, kind: "engine", message: "The reader engine could not start." },
    ] as const;
    for (const input of inputs) {
      const service = makeReaderService(() => Promise.reject(input.error));
      expect(yield* Effect.flip(service.start({ input: projectInput, open: false }))).toMatchObject(
        { kind: input.kind, message: input.message },
      );
    }
  }),
);

it.effect("observes reader termination and preserves failures after startup", () =>
  Effect.gen(function* () {
    for (const failure of [undefined, new Error("worker failed"), "worker failed"] as const) {
      const service = makeReaderService(async () => ({
        url: "http://127.0.0.1:1234",
        close: async () => undefined,
        closed: failure === undefined ? Promise.resolve() : Promise.reject(failure),
      }));
      const session = yield* service.start({
        input: projectInput,
        open: false,
      });
      expect(session.closed).toBeDefined();
      if (session.closed === undefined) return yield* Effect.die("missing closed effect");
      if (failure === undefined) yield* session.closed;
      else
        expect(yield* Effect.flip(session.closed)).toMatchObject({
          kind: "engine",
          message:
            failure instanceof Error ? failure.message : "The reader engine stopped unexpectedly.",
        });
    }
    return undefined;
  }),
);
