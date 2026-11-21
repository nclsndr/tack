import { BunCrypto, BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { SecureRandom } from "effect/crypto";
import { withRecoveredWriter } from "../../src/features/writer/recovered-writer.ts";
import { Destination } from "../../src/services/destination.ts";
import { applyRemovalWithWriter } from "../../src/features/removal/removal-apply.ts";
import { planRemovalFromState } from "../../src/features/removal/removal-plan.ts";
import { makeDestinationService } from "../../src/platform/filesystem/destination-observation.ts";
import { makeStateStoreService } from "../../src/platform/state/state.ts";
import { readState, StateStore } from "../../src/services/state-store.ts";

const stateDirectory = process.env["TACK_STATE_DIR"];
const homeDirectory = process.env["HOME"];
const projectName = process.env["TACK_TEST_PROJECT"];
const projectRoot = process.env["TACK_TEST_PROJECT_ROOT"];
const crashPoint = process.env["TACK_TEST_CRASH_POINT"];
if (stateDirectory === undefined || homeDirectory === undefined) {
  throw new Error("TACK_STATE_DIR and HOME are required");
}
if (projectName === undefined || projectRoot === undefined) {
  throw new Error("TACK_TEST_PROJECT and TACK_TEST_PROJECT_ROOT are required");
}

/**
 * Removes every link of one project root and kills this process at one point of the batch:
 *
 * - `before-unlink` leaves the first link on disk with its journal prepared, and `after-unlink`
 *   leaves it absent before the evidence is settled;
 * - `after-prepare` kills right after the prepare checkpoint, before any unlink;
 * - `after-unlinks:K` kills right after the K-th unlink, before the settle checkpoint;
 * - `after-settle` kills right after the settle checkpoint renamed into place.
 */
const program = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = path.join(stateDirectory, "state.json");
  let unlinks = 0;
  let stateWrites = 0;
  const afterUnlinks = crashPoint?.startsWith("after-unlinks:")
    ? Number(crashPoint.slice("after-unlinks:".length))
    : undefined;
  const crashingFileSystem = {
    ...fileSystem,
    remove: (target: string, options?: Parameters<FileSystem.FileSystem["remove"]>[1]) =>
      Effect.gen(function* () {
        const isLink = target.startsWith(path.join(projectRoot, ".agents"));
        if (isLink && crashPoint === "before-unlink") process.kill(process.pid, "SIGKILL");
        yield* fileSystem.remove(target, options);
        if (isLink) unlinks += 1;
        if (isLink && crashPoint === "after-unlink") process.kill(process.pid, "SIGKILL");
        if (isLink && unlinks === afterUnlinks) process.kill(process.pid, "SIGKILL");
      }),
    rename: (fromPath: string, toPath: string) =>
      Effect.gen(function* () {
        yield* fileSystem.rename(fromPath, toPath);
        if (toPath !== statePath) return;
        stateWrites += 1;
        if (stateWrites === 1 && crashPoint === "after-prepare")
          process.kill(process.pid, "SIGKILL");
        if (stateWrites === 2 && crashPoint === "after-settle")
          process.kill(process.pid, "SIGKILL");
      }),
  } satisfies FileSystem.FileSystem;
  const options = {
    environment: { TACK_STATE_DIR: stateDirectory },
    homeDirectory,
  };
  const work = Effect.gen(function* () {
    const state = yield* readState(options);
    const plan = yield* planRemovalFromState(state, {
      scope: {
        _tag: "selected-targets",
        targets: [{ _tag: "project-root", canonicalPath: projectRoot, projectName }],
      },
    });
    yield* withRecoveredWriter(options, (writer) => applyRemovalWithWriter(writer, plan)).pipe(
      Effect.provideService(FileSystem.FileSystem, crashingFileSystem),
    );
  });
  return yield* work.pipe(
    Effect.provideService(StateStore, makeStateStoreService(random, crashingFileSystem, path)),
    Effect.provideService(Destination, makeDestinationService(fileSystem, path)),
  );
});

BunRuntime.runMain(program.pipe(Effect.provide([BunServices.layer, BunCrypto.layerSecureRandom])), {
  disableErrorReporting: true,
});
