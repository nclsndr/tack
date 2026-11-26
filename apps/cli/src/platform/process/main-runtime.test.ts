import { Deferred, Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interruptSignals, runMain } from "./main-runtime.ts";

const listenersOf = () => interruptSignals.map((signal) => new Set(process.listeners(signal)));

/** Replaces `process.exit` for one test; the promise settles with the code it was asked for. */
const stubExit = () => {
  const exited = Promise.withResolvers<number | string | null | undefined>();
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    exited.resolve(code);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stub returns where the real exit never does.
    return undefined as never;
  });
  return { exit, exited: exited.promise };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI main runtime", () => {
  it.each(interruptSignals)(
    "interrupts the main fiber on %s, runs its finalizers and exits 130",
    async (signal) => {
      const before = listenersOf();
      const { exited } = stubExit();
      const finalized = Promise.withResolvers<void>();
      runMain(Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => finalized.resolve()))), {
        disableErrorReporting: true,
      });
      const added = interruptSignals.map((name, index) =>
        process.listeners(name).filter((listener) => before[index]?.has(listener) === false),
      );
      // One listener serves every interrupt signal.
      expect(added.map((listeners) => listeners.length)).toEqual(interruptSignals.map(() => 1));
      expect(new Set(added.flat()).size).toBe(1);
      process.emit(signal, signal);
      await finalized.promise;
      expect(await exited).toBe(130);
      expect(listenersOf()).toEqual(before);
    },
  );

  it("leaves a successful program's exit to the event loop and detaches its listeners", async () => {
    const before = listenersOf();
    const { exit } = stubExit();
    const done = await Effect.runPromise(Deferred.make<void>());
    runMain(Deferred.succeed(done, undefined));
    await Effect.runPromise(Deferred.await(done));
    await vi.waitFor(() => expect(listenersOf()).toEqual(before));
    expect(exit).not.toHaveBeenCalled();
  });
});
