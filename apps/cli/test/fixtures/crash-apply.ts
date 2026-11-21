import { BunCrypto, BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { SecureRandom } from "effect/crypto";
import { agentAdapterDescriptor } from "../../src/domain/agents/agent-adapter.ts";
import { withRecoveredWriter } from "../../src/features/writer/recovered-writer.ts";
import { Destination } from "../../src/services/destination.ts";
import { applyDocsActions, docsPreparedBatchOf } from "../../src/features/docs/docs-links.ts";
import { runPreparedBatch } from "../../src/features/links/link-engine.ts";
import {
  applyReconciliationUnits,
  preparedBatchOfPlan,
  reconciliationResultOf,
} from "../../src/features/reconciliation/reconciliation-application.ts";
import {
  planReconciliation,
  reconciliationNamespaces,
} from "../../src/features/reconciliation/reconciliation.ts";
import { makeDestinationService } from "../../src/platform/filesystem/destination-observation.ts";
import { initializeState, StateStore } from "../../src/services/state-store.ts";
import { makeStateStoreService } from "../../src/platform/state/state.ts";
import { applyCatalogEntries } from "../support/crash-apply-catalog.ts";
import { mixedDocsMounts, mixedDocsPlan } from "../support/crash-mixed-world.ts";

const stateDirectory = process.env["TACK_STATE_DIR"];
const homeDirectory = process.env["HOME"];
const sourcesDirectory = process.env["TACK_TEST_SOURCES"];
const count = Number(process.env["TACK_TEST_COUNT"]);
const crashPoint = process.env["TACK_TEST_CRASH_POINT"];
const mixed = process.env["TACK_TEST_MIXED"] === "1";
if (stateDirectory === undefined || homeDirectory === undefined || sourcesDirectory === undefined) {
  throw new Error("TACK_STATE_DIR, HOME and TACK_TEST_SOURCES are required");
}

/**
 * Applies one plan that creates `count` agent links, and with TACK_TEST_MIXED also `count` docs
 * mounts in the same prepared batch, and kills this process at one point of the batch:
 *
 * - `after-prepare` kills right after the prepare checkpoint, before any link exists;
 * - `after-actions:K` kills right after the K-th link is created, before the settle checkpoint
 *   (K = 0 kills before the first link);
 * - `after-settle` kills right after the settle checkpoint renamed into place.
 */
const program = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = path.join(stateDirectory, "state.json");
  const afterActions = crashPoint?.startsWith("after-actions:")
    ? Number(crashPoint.slice("after-actions:".length))
    : undefined;
  let symlinks = 0;
  let stateWrites = 0;
  let armed = false;
  const crashingFileSystem = {
    ...fileSystem,
    symlink: (fromPath: string, toPath: string) =>
      Effect.gen(function* () {
        if (afterActions === 0) process.kill(process.pid, "SIGKILL");
        yield* fileSystem.symlink(fromPath, toPath);
        symlinks += 1;
        if (symlinks === afterActions) process.kill(process.pid, "SIGKILL");
      }),
    rename: (fromPath: string, toPath: string) =>
      Effect.gen(function* () {
        yield* fileSystem.rename(fromPath, toPath);
        if (toPath !== statePath || !armed) return;
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
  const entries = applyCatalogEntries(sourcesDirectory, count);
  const work = Effect.gen(function* () {
    yield* initializeState(options);
    // Initializing wrote the empty document; the crash points count the apply's own writes.
    armed = true;
    const plan = yield* planReconciliation({
      adapters: [agentAdapterDescriptor("cursor")],
      catalogEntries: entries,
      managedLinks: [],
      namespaces: reconciliationNamespaces(
        [
          {
            namespace: { _tag: "user" },
            resolution: {
              groups: entries.map((entry) => ({
                _tag: "selected" as const,
                members: [entry.address],
              })),
              optionalSkips: [],
              requestBlockers: [],
            },
          },
        ],
        [{ _tag: "user", canonicalPath: homeDirectory }],
      ),
    });
    const docsPlan = mixedDocsPlan(mixedDocsMounts(homeDirectory, sourcesDirectory, count));
    yield* withRecoveredWriter(options, (writer) =>
      runPreparedBatch(
        writer,
        [...preparedBatchOfPlan(plan), ...(mixed ? docsPreparedBatchOf([docsPlan]) : [])],
        (ledger) =>
          Effect.gen(function* () {
            yield* applyReconciliationUnits(ledger, plan).pipe(
              Effect.map((units) => reconciliationResultOf(plan, units)),
            );
            if (mixed) yield* applyDocsActions(ledger, docsPlan);
          }),
      ),
    ).pipe(Effect.provideService(FileSystem.FileSystem, crashingFileSystem));
  });
  return yield* work.pipe(
    Effect.provideService(StateStore, makeStateStoreService(random, crashingFileSystem, path)),
    Effect.provideService(Destination, makeDestinationService(fileSystem, path)),
  );
});

BunRuntime.runMain(program.pipe(Effect.provide([BunServices.layer, BunCrypto.layerSecureRandom])), {
  disableErrorReporting: true,
});
