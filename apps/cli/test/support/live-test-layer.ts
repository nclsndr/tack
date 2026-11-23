import { BunCrypto, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { SecureRandom } from "effect/crypto";
import { Destination } from "../../src/services/destination.ts";
import { Source, makeSourceService } from "../../src/features/sources/source.ts";
import {
  DestinationLive,
  makeDestinationService,
} from "../../src/platform/filesystem/destination-observation.ts";
import { ImportRemoteLive } from "../../src/platform/git/import-remote.ts";
import { BundleScannerLive } from "../../src/platform/bundles/bundle-scanner.ts";
import { CompressionLive } from "../../src/platform/compression/compression.ts";
import { InstallationLive } from "../../src/platform/installation/installation.ts";
import { Reader } from "../../src/services/reader.ts";
import { ReaderCorpusLive } from "../../src/platform/reader/search.ts";
import { ExecutionWorker } from "../../src/services/execution-platform.ts";
import { RunHistoryLive } from "../../src/platform/execution/execution-platform.ts";
import { StateStore } from "../../src/services/state-store.ts";
import { StateStoreLive, makeStateStoreService } from "../../src/platform/state/state.ts";

/** Supplies the live platform plus feature-facing adapters for integration-focused tests. */
export const LiveTestLayer = Layer.mergeAll(
  DestinationLive,
  // Fixture suites discover only their declared test sources; process tests exercise release assets.
  Layer.effect(
    Source,
    Effect.gen(function* () {
      return makeSourceService(
        yield* SecureRandom.SecureRandom,
        yield* FileSystem.FileSystem,
        yield* Path.Path,
      );
    }),
  ),
  StateStoreLive,
  ImportRemoteLive,
  InstallationLive,
  CompressionLive,
  BundleScannerLive,
  // Run history reads and writes record files in the test's own state directory, so the real
  // store is hermetic; the worker starts processes and needs an explicit replacement.
  RunHistoryLive,
  Layer.succeed(
    ExecutionWorker,
    ExecutionWorker.of({
      cancellation: () => Effect.die("Script execution requires an explicit test replacement."),
      input: () => Effect.die("Script execution requires an explicit test replacement."),
      packageReady: () => Effect.die("Script execution requires an explicit test replacement."),
      worker: () => Effect.die("Script execution requires an explicit test replacement."),
    }),
  ),

  // Docs inspection reads saved local files only, so the real loader is hermetic by default.
  ReaderCorpusLive,
  Layer.succeed(
    Reader,
    Reader.of({ start: () => Effect.die("The reader requires an explicit test replacement.") }),
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunCrypto.layerSecureRandom)));

/** Rebinds every filesystem-backed capability to one test filesystem override. */
export const provideTestFileSystem = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fileSystem: FileSystem.FileSystem,
) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const path = yield* Path.Path;

    return yield* effect.pipe(
      Effect.provideService(Destination, makeDestinationService(fileSystem, path)),
      Effect.provideService(Source, makeSourceService(random, fileSystem, path)),
      Effect.provideService(StateStore, makeStateStoreService(random, fileSystem, path)),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  });
