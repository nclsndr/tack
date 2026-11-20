import { pendingRemovalsOf } from "../../domain/links/link-record-schema.ts";
import { stallAt } from "../../../test/support/faults.ts";
import {
  evidenceFor,
  mutateStateFixture,
  runtimeFixture,
  setupLink,
  targetUser,
  withStateFixture,
} from "../../../test/support/state-fixture.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, FileSystem, Fiber, Path } from "effect";

import { disableAdapter } from "./adapter-disablement.ts";
import { resetTack } from "./selected-removal.ts";
import { readState, type StateOptions } from "../../services/state-store.ts";

/**
 * The maintenance commands that unlink a cursor link, and the state each leaves once settled. Each
 * run drops its result, so both cases share one effect type.
 */
const entryPoints = [
  {
    entry: "reset",
    cause: "reset" as const,
    run: (options: StateOptions) =>
      resetTack(options, { apply: true }).pipe(Effect.asVoid, Effect.orDie),
    // Reset drops every adapter up front and deletes the state once its last removal settles.
    enabledAdapters: [],
    settled: undefined,
  },
  {
    entry: "adapter disablement",
    cause: "adapter-disable" as const,
    run: (options: StateOptions) =>
      disableAdapter(options, "cursor", { apply: true }).pipe(Effect.asVoid, Effect.orDie),
    enabledAdapters: ["codex"],
    settled: runtimeFixture({ version: 1, data: { enabledAdapters: ["codex"] } }).data,
  },
];

it.layer(LiveTestLayer)("maintenance interruption", (interruptIt) => {
  interruptIt.effect.each(entryPoints)(
    "$entry records its cleanup before unlink and keeps it retryable when interrupted",
    ({ cause, enabledAdapters, run, settled }) =>
      withStateFixture(({ options, root, statePath }) =>
        Effect.gen(function* () {
          const liveFileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const userRootPath = path.join(root, "user");
          const sourcePath = path.join(root, "source");
          yield* liveFileSystem.makeDirectory(userRootPath, { recursive: true });
          yield* liveFileSystem.makeDirectory(sourcePath, { recursive: true });
          const evidence = evidenceFor(
            "cursor",
            targetUser(yield* liveFileSystem.realPath(userRootPath)),
            yield* liveFileSystem.realPath(sourcePath),
            "alpha",
          );
          const destinationPath = yield* setupLink(evidence);
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              enabledAdapters: ["codex", "cursor"],
              managedLinks: [evidence],
            },
          }));
          const lockPath = path.join(path.dirname(statePath), "state.lock");
          const stall = yield* stallAt("remove", destinationPath);
          const fiber = yield* provideTestFileSystem(run(options), stall.fileSystem).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(stall.entered);

          // The obligation is on disk, under the writer lock, before the unlink starts.
          expect(yield* liveFileSystem.exists(lockPath)).toBe(true);
          const checkpoint = yield* readState(options);
          expect(checkpoint.data.enabledAdapters).toEqual(enabledAdapters);
          expect(pendingRemovalsOf(checkpoint.data.links)).toMatchObject([{ cause, evidence }]);

          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);

          expect(Exit.hasInterrupts(exit)).toBe(true);
          const interrupted = yield* readState(options);
          expect(interrupted.data.enabledAdapters).toEqual(enabledAdapters);
          expect(pendingRemovalsOf(interrupted.data.links)).toMatchObject([
            {
              cause,
              evidence,
              lastResult: { _tag: "interrupted", message: "Cleanup was interrupted." },
            },
          ]);
          expect(yield* liveFileSystem.exists(destinationPath)).toBe(true);
          expect(yield* liveFileSystem.exists(lockPath)).toBe(false);

          // Running the same command again settles the obligation.
          yield* run(options);
          const left = yield* readState(options).pipe(
            Effect.map((state) => state.data),
            Effect.catchTag("StateNotInitializedError", () => Effect.succeed(undefined)),
          );
          expect(left).toEqual(settled);
          expect(yield* liveFileSystem.exists(destinationPath)).toBe(false);
        }),
      ),
  );
});
