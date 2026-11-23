import { mutateStateFixture } from "../support/state-fixture.ts";
import { BunCrypto, BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { SecureRandom } from "effect/crypto";
import { initializeState, StateStore } from "../../src/services/state-store.ts";
import { makeStateStoreService } from "../../src/platform/state/state.ts";

const stateDirectory = process.env["TACK_STATE_DIR"];
if (stateDirectory === undefined) throw new Error("TACK_STATE_DIR is required");
const crashAt = Number(process.env["TACK_TEST_CRASH_AT"]);
const crashPoint = process.env["TACK_TEST_CRASH_POINT"];
let writes = 0;

const program = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crashingFileSystem = {
    ...fileSystem,
    rename: (fromPath: string, toPath: string) =>
      Effect.gen(function* () {
        const isStateWrite =
          fromPath.startsWith(`${path.join(stateDirectory, "state.json")}.tmp-`) &&
          toPath === path.join(stateDirectory, "state.json");
        if (isStateWrite) {
          writes += 1;
          if (writes === crashAt && crashPoint === "before-rename") {
            process.kill(process.pid, "SIGKILL");
          }
        }
        yield* fileSystem.rename(fromPath, toPath);
        if (isStateWrite && writes === crashAt && crashPoint === "after-rename") {
          process.kill(process.pid, "SIGKILL");
        }
      }),
  } satisfies FileSystem.FileSystem;
  const options = {
    environment: { TACK_STATE_DIR: stateDirectory },
    homeDirectory: stateDirectory,
  };
  const work = Effect.gen(function* () {
    yield* initializeState(options);
    for (const enabledAdapters of [
      ["claude"],
      ["codex"],
      ["cursor"],
      ["claude", "codex"],
    ] as const) {
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: { ...state.data, enabledAdapters },
      }));
    }
  });
  return yield* work.pipe(
    Effect.provideService(StateStore, makeStateStoreService(random, crashingFileSystem, path)),
  );
});

BunRuntime.runMain(program.pipe(Effect.provide([BunServices.layer, BunCrypto.layerSecureRandom])), {
  disableErrorReporting: true,
});
