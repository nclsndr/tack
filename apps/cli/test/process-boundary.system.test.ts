import { isMinimalRecoveryState } from "../src/features/removal/removal-apply.ts";
import { pendingRemovalsOf } from "../src/domain/links/link-record-schema.ts";
import { mutateStateFixture } from "./support/state-fixture.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { ManagedLinkEvidence } from "../src/domain/links/managed-link-schema.ts";
import { readState } from "../src/services/state-store.ts";
import {
  runTack,
  successfulEnvelope,
  type TackWorld,
  withTackWorld,
} from "./support/tack-world.ts";
import { decodeEnvelope, sourceEntrypoint, tackEnvironment } from "./support/tack-process.ts";

/** Many links in one directory: the apply is fast, so a long batch gives the kill a window. */
const interruptionLinkCount = 2000;

const interruptionEvidence = Effect.fnUntraced(function* (fixture: TackWorld) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const state = yield* readState(fixture.options);
  const registration = state.data.sources?.[0];
  if (registration === undefined) {
    return yield* Effect.die("The system fixture must have one registered skill source.");
  }
  const sourceDirectoryPath = yield* fileSystem.realPath(
    path.join(fixture.sourceDirectory, "skills", "valid"),
  );
  const targetRoot = path.join(path.dirname(fixture.stateDirectory), "interruption-target");
  const destinationDirectory = path.join(targetRoot, ".agents", "skills");
  yield* fileSystem.makeDirectory(destinationDirectory, { recursive: true });

  return yield* Effect.forEach(
    Array.from({ length: interruptionLinkCount }, (_, index) => index),
    (index) =>
      Effect.gen(function* () {
        const name = `skill-${index.toString().padStart(4, "0")}`;
        yield* fileSystem.symlink(
          path.relative(destinationDirectory, sourceDirectoryPath),
          path.join(destinationDirectory, name),
        );
        return {
          adapter: "codex",
          address: { kind: "skill", name, sourceRegistrationId: registration.id },
          sourceDirectoryPath,
          sourceRegistrationId: registration.id,
          target: { _tag: "user", canonicalPath: targetRoot },
        } satisfies ManagedLinkEvidence;
      }),
    { concurrency: "unbounded" },
  );
});

/** How many of the interrupted reset's links are still on disk. */
const linksOnDisk = (fixture: TackWorld) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fileSystem.readDirectory(
      path.join(path.dirname(fixture.stateDirectory), "interruption-target", ".agents", "skills"),
    );
    return entries.length;
  });

const interruptResetAt = Effect.fnUntraced(function* (
  fixture: TackWorld,
  remainingThreshold: number,
) {
  const evidence = yield* interruptionEvidence(fixture);
  yield* mutateStateFixture(fixture.options, (state) => ({
    ...state,
    data: { ...state.data, managedLinks: evidence },
  }));

  const process = yield* ChildProcess.make(
    globalThis.process.execPath,
    [sourceEntrypoint, "--json", "state", "reset", "--apply"],
    {
      cwd: fixture.primaryRoot,
      env: tackEnvironment({ home: fixture.homeDirectory, state: fixture.stateDirectory }),
    },
  );
  const stdoutFiber = yield* process.stdout.pipe(
    Stream.decodeText,
    Stream.mkString,
    Effect.forkChild({ startImmediately: true }),
  );
  const stderrFiber = yield* process.stderr.pipe(
    Stream.decodeText,
    Stream.mkString,
    Effect.forkChild({ startImmediately: true }),
  );
  // A reset writes the state twice, so progress shows on disk: wait until it has begun unlinking.
  const observedOnDisk = yield* Effect.repeat(linksOnDisk(fixture), {
    times: 200_000,
    until: (count) => count > 0 && count <= remainingThreshold,
  });
  expect(observedOnDisk).toBeGreaterThan(0);
  expect(observedOnDisk).toBeLessThanOrEqual(remainingThreshold);

  yield* process.kill({ forceKillAfter: "5 seconds", killSignal: "SIGINT" });
  const result = yield* Effect.all(
    {
      exitCode: process.exitCode,
      stderr: Fiber.join(stderrFiber),
      stdout: Fiber.join(stdoutFiber),
    },
    { concurrency: "unbounded" },
  );
  expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(130));
  expect(result.stderr).toBe("");
  expect(decodeEnvelope(result.stdout)).toMatchObject({
    classification: "interruption",
    command: "state reset",
    status: "failure",
  });

  // The interruption settled what completed: the unlinked links are gone from the record, and
  // every link that is still on disk still owes its removal.
  const interruptedState = yield* readState(fixture.options);
  const retainedPending = pendingRemovalsOf(interruptedState.data.links);
  expect(isMinimalRecoveryState(interruptedState)).toBe(true);
  expect(retainedPending.length).toBeGreaterThan(0);
  expect(retainedPending.length).toBeLessThan(interruptionLinkCount);
  const fileSystem = yield* FileSystem.FileSystem;
  expect(retainedPending.length).toBeGreaterThanOrEqual(yield* linksOnDisk(fixture));

  const recovered = successfulEnvelope(yield* runTack(fixture, ["state", "reset", "--apply"]));
  expect(recovered.applied).toMatchObject({ pending: [] });
  const path = yield* Path.Path;
  expect(yield* fileSystem.exists(path.join(fixture.stateDirectory, "state.json"))).toBe(false);
});

it.layer(LiveTestLayer)("process boundary", (boundaryIt) => {
  boundaryIt.effect(
    "settles the completed unlinks of an early and a mid-reset interruption before a later reset converges",
    () =>
      // Unlinks run one at a time, and the one in flight when the signal lands stays owed even
      // when it is already gone from disk. Two gone from disk therefore settle at least one.
      Effect.forEach([interruptionLinkCount - 2, interruptionLinkCount / 2], (threshold) =>
        withTackWorld((fixture) => interruptResetAt(fixture, threshold)),
      ),
    { timeout: 60_000 },
  );
});
