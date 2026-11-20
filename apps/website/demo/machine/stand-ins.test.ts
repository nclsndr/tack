import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Terminal } from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  unavailableExecutionPlatform,
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
  webCrypto,
} from "./stand-ins.ts";

describe("in-memory stand-ins", () => {
  it.effect("hashes and draws random bytes through Web Crypto", () =>
    Effect.gen(function* () {
      const digest = yield* webCrypto.digest("SHA-256", new TextEncoder().encode("abc"));
      const bytes = yield* webCrypto.randomBytes(8);

      expect(Buffer.from(digest).toString("hex")).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
      expect(bytes).toHaveLength(8);
    }),
  );

  it.effect("reports a digest the platform refuses as a platform error", () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test feeds Web Crypto an algorithm the type rules out.
      const error = yield* Effect.flip(webCrypto.digest("MD5" as "SHA-1", new Uint8Array()));

      expect(error.reason._tag).toBe("Unknown");
    }),
  );

  it.effect("fails every capability that needs a real machine with one clear message", () =>
    Effect.gen(function* () {
      const failures = yield* Effect.all([
        Effect.flip(unavailableReader.start()),
        Effect.flip(unavailableReaderCorpus.loadProject()),
        Effect.flip(unavailableReaderCorpus.checkFigures()),
        Effect.flip(unavailableImportRemote.probe),
        Effect.flip(unavailableImportRemote.listRefs()),
        Effect.flip(Effect.scoped(unavailableImportRemote.open())),
        Effect.flip(unavailableExecutionPlatform.worker()),
        Effect.flip(unavailableExecutionPlatform.input()),
        Effect.flip(unavailableExecutionPlatform.packageReady()),
        Effect.flip(unavailableExecutionPlatform.createHistory()),
        Effect.flip(unavailableExecutionPlatform.finishHistory()),
      ]);

      expect(
        failures.map((failure) => failure.message.endsWith(unavailableMessage("").slice(1))),
      ).toEqual(failures.map(() => true));
    }),
  );

  it.effect("reads an empty script history and hands out a cancellation that never fires", () =>
    Effect.gen(function* () {
      const cancellation = yield* unavailableExecutionPlatform.cancellation();
      cancellation.onRepeatSignal()();
      cancellation.close();

      expect(cancellation.signal.aborted).toBe(false);
      expect(yield* unavailableExecutionPlatform.listHistory()).toEqual({
        runs: [],
        issues: [],
      });
      expect(yield* unavailableExecutionPlatform.countHistory()).toBe(0);
      expect(yield* unavailableExecutionPlatform.showHistory()).toBeUndefined();
      expect(yield* unavailableExecutionPlatform.clearHistory()).toBe(0);
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
