import { BunCrypto, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, ConfigProvider, Effect, FileSystem, Path, Stdio, Stream } from "effect";
import { mutateState, type StateOptions } from "../../src/services/state-store.ts";
import { StateStoreLive } from "../../src/platform/state/state.ts";

const program = Effect.gen(function* () {
  const provider = ConfigProvider.fromEnv({ preserveEmptyStrings: true });
  const homeDirectory = yield* Config.String("HOME").parse(provider);
  const stateDirectory = yield* Config.String("TACK_STATE_DIR").parse(provider);
  const options = { stateDirectory, homeDirectory } satisfies StateOptions;

  yield* mutateState(options, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stdio = yield* Stdio.Stdio;
      yield* fileSystem.writeFileString(path.join(stateDirectory, "holder-ready"), "ready");
      yield* Stream.succeed("ready\n").pipe(Stream.run(stdio.stdout()));
      return yield* Effect.never;
    }),
  );
});

BunRuntime.runMain(
  program.pipe(
    Effect.provide(StateStoreLive),
    Effect.provide([BunServices.layer, BunCrypto.layerSecureRandom]),
  ),
  {
    disableErrorReporting: true,
  },
);
