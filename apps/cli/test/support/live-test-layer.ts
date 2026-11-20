import { BunServices } from "@effect/platform-bun";
import { Crypto, Effect, FileSystem, Layer, Path } from "effect";
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
import { ExecutionPlatform } from "../../src/services/execution-platform.ts";
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
        yield* Crypto.Crypto,
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
  Layer.succeed(
    ExecutionPlatform,
    ExecutionPlatform.of({
      cancellation: () => Effect.die("Script execution requires an explicit test replacement."),
      input: () => Effect.die("Script execution requires an explicit test replacement."),
      packageReady: () => Effect.die("Script execution requires an explicit test replacement."),
      createHistory: () => Effect.die("Script execution requires an explicit test replacement."),
      finishHistory: () => Effect.die("Script execution requires an explicit test replacement."),
      listHistory: () => Effect.die("Script execution requires an explicit test replacement."),
      countHistory: () => Effect.die("Script execution requires an explicit test replacement."),
      showHistory: () => Effect.die("Script execution requires an explicit test replacement."),
      clearHistory: () => Effect.die("Script execution requires an explicit test replacement."),
      worker: () => Effect.die("Script execution requires an explicit test replacement."),
    }),
  ),

  // Docs inspection reads saved local files only, so the real loader is hermetic by default.
  ReaderCorpusLive,
  Layer.succeed(
    Reader,
    Reader.of({ start: () => Effect.die("The reader requires an explicit test replacement.") }),
  ),
).pipe(Layer.provideMerge(BunServices.layer));

/** Rebinds every filesystem-backed capability to one test filesystem override. */
export const provideTestFileSystem = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fileSystem: FileSystem.FileSystem,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;

    return yield* effect.pipe(
      Effect.provideService(Destination, makeDestinationService(fileSystem, path)),
      Effect.provideService(Source, makeSourceService(crypto, fileSystem, path)),
      Effect.provideService(StateStore, makeStateStoreService(crypto, fileSystem, path)),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  });
