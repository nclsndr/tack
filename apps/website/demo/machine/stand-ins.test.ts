import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Terminal } from "effect";
import { ChildProcess } from "effect/process";
import {
  unavailableExecutionWorker,
  unavailableRunHistory,
  unavailableImportRemote,
  unavailableMessage,
  unavailableReader,
  unavailableReaderCorpus,
  unavailableSpawner,
  nonInteractiveTerminal,
  browserInstallation,
  unavailableBundleScanner,
  pageLockProcess,
  unavailableCompression,
} from "./stand-ins.ts";

describe("in-memory stand-ins", () => {
  it.effect("fails every capability that needs a real machine with one clear message", () =>
    Effect.gen(function* () {
      const failures = yield* Effect.all([
        Effect.flip(unavailableReader.start()),
        Effect.flip(unavailableReaderCorpus.loadProject()),
        Effect.flip(unavailableReaderCorpus.checkFigures()),
        Effect.flip(unavailableImportRemote.probe),
        Effect.flip(unavailableImportRemote.listRefs()),
        Effect.flip(Effect.scoped(unavailableImportRemote.open())),
        Effect.flip(unavailableExecutionWorker.worker()),
        Effect.flip(unavailableExecutionWorker.input()),
        Effect.flip(unavailableExecutionWorker.packageReady()),
        Effect.flip(unavailableRunHistory.createHistory()),
        Effect.flip(unavailableRunHistory.finishHistory()),
      ]);

      expect(
        failures.map((failure) => failure.message.endsWith(unavailableMessage("").slice(1))),
      ).toEqual(failures.map(() => true));
    }),
  );

  it.effect("reads an empty script history and hands out a cancellation that never fires", () =>
    Effect.gen(function* () {
      const cancellation = yield* unavailableExecutionWorker.cancellation();
      cancellation.onRepeatSignal()();
      cancellation.close();

      expect(cancellation.signal.aborted).toBe(false);
      expect(yield* unavailableRunHistory.listHistory()).toEqual({
        runs: [],
        issues: [],
      });
      expect(yield* unavailableRunHistory.countHistory()).toBe(0);
      expect(yield* unavailableRunHistory.showHistory()).toBeUndefined();
      expect(yield* unavailableRunHistory.clearHistory()).toBe(0);
    }),
  );

  it.effect("starts no process and offers a terminal that is never interactive", () =>
    Effect.gen(function* () {
      const spawned = yield* Effect.flip(
        unavailableSpawner.exitCode(ChildProcess.make("git", ["status"])),
      );
      const piped = yield* Effect.flip(
        unavailableSpawner.exitCode(
          ChildProcess.make("git", ["status"]).pipe(ChildProcess.pipeTo(ChildProcess.make("cat"))),
        ),
      );

      expect(spawned.message).toContain(unavailableMessage("Starting git"));
      expect(piped.message).toContain(unavailableMessage("Starting a process"));
      expect(yield* nonInteractiveTerminal.columns).toBe(80);
      expect(yield* nonInteractiveTerminal.rows).toBe(24);
      yield* nonInteractiveTerminal.display("ignored");
      expect(Terminal.isQuitError(yield* Effect.flip(nonInteractiveTerminal.readLine))).toBe(true);
      expect(
        Exit.isFailure(yield* Effect.exit(Effect.scoped(nonInteractiveTerminal.readInput))),
      ).toBe(true);
    }),
  );

  it.effect("installs as npm, never crashes on purpose, and owns every lock it takes", () =>
    Effect.gen(function* () {
      yield* browserInstallation.crashPoint();

      expect(browserInstallation.kind).toBe("npm");
      expect(unavailableBundleScanner.builtinModules).toEqual([]);
      expect(() => unavailableBundleScanner.references()).toThrow(
        unavailableMessage("Scanning profile bundle references"),
      );
      expect([pageLockProcess.pid, pageLockProcess.isGone()]).toEqual([1, false]);
      expect(() => unavailableCompression.gzip()).toThrow(
        unavailableMessage("Writing and reading profile bundles"),
      );
      expect(() => unavailableCompression.gunzip()).toThrow(
        unavailableMessage("Writing and reading profile bundles"),
      );
    }),
  );
});
