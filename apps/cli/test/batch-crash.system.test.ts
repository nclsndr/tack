import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/process";
import { agentAdapterDescriptor } from "../src/domain/agents/agent-adapter.ts";
import { managedLinkDestinationPath } from "../src/domain/agents/agent-layout.ts";
import {
  planReconciliation,
  reconciliationNamespaces,
} from "../src/features/reconciliation/reconciliation.ts";
import { initializeState, readState, type StateOptions } from "../src/services/state-store.ts";
import { type State } from "../src/domain/state/state-schema.ts";
import { managedLinksOf, pendingRemovalsOf } from "../src/domain/links/link-record-schema.ts";
import type { ManagedLinkEvidence } from "../src/domain/links/managed-link-schema.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { repositoryRoot, tackEnvironment, type TackIsolation } from "./support/tack-process.ts";
import { mutateState } from "./support/state-fixture.ts";
import { retryPendingRemovals } from "./support/removal.ts";
import { planAndApplyReconciliation } from "./support/reconciliation.ts";
import { applyCatalogEntries, crashApplyRegistrationId } from "./support/crash-apply-catalog.ts";
import {
  mixedDocsMounts,
  mixedDocsPlan,
  mixedDocsSource,
  mixedProjectRoot,
} from "./support/crash-mixed-world.ts";
import { managedDocsLinksOf } from "../src/domain/docs/docs-schema.ts";
import { applyDocsActions, docsPreparedBatchOf } from "../src/features/docs/docs-links.ts";
import { runPreparedBatch } from "../src/features/links/link-engine.ts";
import {
  applyReconciliationUnits,
  preparedBatchOfPlan,
} from "../src/features/reconciliation/reconciliation-application.ts";
import { withRecoveredWriter } from "../src/features/writer/recovered-writer.ts";

/*
 * A real SIGKILL at each point of one prepared batch, for an apply and for a removal. Whatever
 * point it hits, the next writer settles the journal by observation and ends where an apply that
 * was never killed ends, with no link on disk that the ledger does not own and no owned link
 * missing from disk.
 */

const count = 8;
const stuck = "SIGKILL";

type Variant = {
  readonly name: string;
  /** The crash point handed to the fixture; absent for the uninterrupted control. */
  readonly crashPoint?: string;
  /** What the killed process left in the journal and on disk, before anyone recovers it. */
  readonly journaled: number;
  readonly linksOnDisk: number;
  readonly ledgerLinks: number;
};

/** Starts one crash fixture as an isolated Tack process, kept live so its kill can be observed. */
const spawnFixture = (
  fixture: string,
  isolation: TackIsolation,
  environment: Readonly<Record<string, string>>,
  cwd: string,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* ChildProcess.make(
      process.execPath,
      [path.join(repositoryRoot, "apps/cli/test/fixtures", fixture)],
      { cwd, env: tackEnvironment(isolation, environment) },
    );
  });

const expectKilled = (child: { readonly exitCode: Effect.Effect<unknown, unknown> }) =>
  Effect.flip(child.exitCode).pipe(
    Effect.tap((error) =>
      Effect.sync(() =>
        expect(error).toMatchObject({
          reason: { cause: expect.objectContaining({ message: expect.stringContaining(stuck) }) },
        }),
      ),
    ),
  );

/** Everything that identifies a state, with the variant's own directory made comparable. */
const normalized = (state: State, root: string) =>
  JSON.parse(JSON.stringify(state.data).replaceAll(root, "<world>")) as unknown;

const applyVariants: ReadonlyArray<Variant> = [
  { name: "control", journaled: 0, linksOnDisk: count, ledgerLinks: count },
  {
    name: "after-prepare",
    crashPoint: "after-prepare",
    journaled: count,
    linksOnDisk: 0,
    ledgerLinks: 0,
  },
  ...[0, 1, count / 2, count].map((k): Variant => ({
    name: `after-actions:${k}`,
    crashPoint: `after-actions:${k}`,
    journaled: count,
    linksOnDisk: k,
    ledgerLinks: 0,
  })),
  {
    name: "after-settle",
    crashPoint: "after-settle",
    journaled: 0,
    linksOnDisk: count,
    ledgerLinks: count,
  },
];

it.layer(LiveTestLayer)("a killed apply converges on the next writer", (crashIt) => {
  crashIt.effect(
    "ends where an uninterrupted apply ends, after a kill at every point of the batch",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const world = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-batch-crash-" }),
        );
        const sources = path.join(world, "sources");
        const entries = applyCatalogEntries(sources, count);
        yield* Effect.forEach(entries, (entry) =>
          fileSystem.makeDirectory(entry.directoryPath, { recursive: true }),
        );

        const results = new Map<string, { readonly state: unknown; readonly disk: unknown }>();
        for (const variant of applyVariants) {
          const home = path.join(world, variant.name, "home");
          const stateDirectory = path.join(world, variant.name, "state");
          yield* fileSystem.makeDirectory(home, { recursive: true });
          const options = {
            environment: { TACK_STATE_DIR: stateDirectory },
            homeDirectory: home,
          } satisfies StateOptions;
          const child = yield* spawnFixture(
            "crash-apply.ts",
            { home, state: stateDirectory },
            {
              TACK_TEST_COUNT: String(count),
              TACK_TEST_SOURCES: sources,
              ...(variant.crashPoint === undefined
                ? {}
                : { TACK_TEST_CRASH_POINT: variant.crashPoint }),
            },
            world,
          );
          if (variant.crashPoint === undefined) {
            expect(yield* child.exitCode).toBe(0);
          } else {
            yield* expectKilled(child);
          }

          // The killed process left exactly what its crash point says.
          const skills = path.join(home, ".cursor", "skills");
          const onDisk = (yield* fileSystem.exists(skills))
            ? yield* fileSystem.readDirectory(skills)
            : [];
          const left = yield* readState(options);
          expect(left.data.journal?.length ?? 0, `${variant.name} journal`).toBe(variant.journaled);
          expect(onDisk.length, `${variant.name} links`).toBe(variant.linksOnDisk);
          expect(left.data.links.length, `${variant.name} ledger`).toBe(variant.ledgerLinks);

          // The next writer recovers the journal, then plans and applies what remains.
          yield* planAndApplyReconciliation(options, (state) =>
            planReconciliation({
              adapters: [agentAdapterDescriptor("cursor")],
              catalogEntries: entries,
              managedLinks: managedLinksOf(state.data.links),
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
                [{ _tag: "user", canonicalPath: home }],
              ),
            }),
          );

          const settled = yield* readState(options);
          const names = yield* fileSystem.readDirectory(skills);
          const targets = yield* Effect.forEach(names.toSorted(), (name) =>
            fileSystem.readLink(path.join(skills, name)),
          );
          expect(settled.data.journal, `${variant.name} journal after`).toBeUndefined();
          // No link is foreign and none is missing: the ledger and the disk name the same links.
          expect(
            managedLinksOf(settled.data.links)
              .map((link) => path.basename(managedLinkDestinationPath(link)))
              .toSorted(),
          ).toEqual(names.toSorted());
          expect(
            managedLinksOf(settled.data.links).map((link) => link.address.sourceRegistrationId),
          ).toEqual(Array.from({ length: count }, () => crashApplyRegistrationId));
          results.set(variant.name, {
            state: normalized(settled, path.join(world, variant.name)),
            disk: { names: names.toSorted(), targets },
          });
        }

        const control = results.get("control");
        for (const variant of applyVariants) {
          expect(results.get(variant.name), variant.name).toEqual(control);
        }
      }),
    { timeout: 120_000 },
  );
});

const removalVariants: ReadonlyArray<Variant> = [
  { name: "control", journaled: 0, linksOnDisk: 0, ledgerLinks: 0 },
  {
    name: "after-prepare",
    crashPoint: "after-prepare",
    journaled: count,
    linksOnDisk: count,
    ledgerLinks: count,
  },
  ...[1, count / 2, count].map((k): Variant => ({
    name: `after-unlinks:${k}`,
    crashPoint: `after-unlinks:${k}`,
    journaled: count,
    linksOnDisk: count - k,
    ledgerLinks: count,
  })),
  {
    name: "after-settle",
    crashPoint: "after-settle",
    journaled: 0,
    linksOnDisk: 0,
    ledgerLinks: 0,
  },
];

it.layer(LiveTestLayer)("a killed removal converges on the next writer", (crashIt) => {
  crashIt.effect(
    "ends where an uninterrupted removal ends, after a kill at every point of the batch",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const world = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-batch-crash-" }),
        );
        const source = path.join(world, "source");
        yield* fileSystem.makeDirectory(source, { recursive: true });

        const results = new Map<string, unknown>();
        for (const variant of removalVariants) {
          const home = path.join(world, variant.name, "home");
          const stateDirectory = path.join(world, variant.name, "state");
          const projectRoot = path.join(world, variant.name, "project");
          const skills = path.join(projectRoot, ".agents", "skills");
          yield* fileSystem.makeDirectory(skills, { recursive: true });
          yield* fileSystem.makeDirectory(home, { recursive: true });
          const options = {
            environment: { TACK_STATE_DIR: stateDirectory },
            homeDirectory: home,
          } satisfies StateOptions;
          const canonicalRoot = yield* fileSystem.realPath(projectRoot);
          const canonicalSource = yield* fileSystem.realPath(source);
          const names = Array.from(
            { length: count },
            (_, index) => `skill-${String(index).padStart(3, "0")}`,
          );
          yield* Effect.forEach(names, (name) =>
            fileSystem.symlink(path.relative(skills, canonicalSource), path.join(skills, name)),
          );
          const evidence = names.map((name): ManagedLinkEvidence => ({
            adapter: "codex",
            address: { kind: "skill", name, sourceRegistrationId: crashApplyRegistrationId },
            sourceDirectoryPath: canonicalSource,
            sourceRegistrationId: crashApplyRegistrationId,
            target: {
              _tag: "project-root",
              canonicalPath: canonicalRoot,
              projectName: "workspace",
            },
          }));
          yield* initializeState(options);
          yield* mutateState(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              managedLinks: evidence,
              projects: [
                {
                  gitCommonDirectory: `${canonicalRoot}/.git`,
                  name: "workspace",
                  roots: [canonicalRoot],
                },
              ],
            },
          }));

          const child = yield* spawnFixture(
            "crash-removal.ts",
            { home, state: stateDirectory },
            {
              TACK_TEST_PROJECT: "workspace",
              TACK_TEST_PROJECT_ROOT: canonicalRoot,
              ...(variant.crashPoint === undefined
                ? {}
                : { TACK_TEST_CRASH_POINT: variant.crashPoint }),
            },
            canonicalRoot,
          );
          if (variant.crashPoint === undefined) {
            expect(yield* child.exitCode).toBe(0);
          } else {
            yield* expectKilled(child);
          }

          const left = yield* readState(options);
          const onDisk = yield* fileSystem.readDirectory(skills);
          expect(left.data.journal?.length ?? 0, `${variant.name} journal`).toBe(variant.journaled);
          expect(onDisk.length, `${variant.name} links`).toBe(variant.linksOnDisk);
          // Every unlink that has not been settled still owes its removal, so nothing is lost.
          expect(pendingRemovalsOf(left.data.links).length, `${variant.name} obligations`).toBe(
            variant.name === "control" || variant.name === "after-settle" ? 0 : count,
          );

          yield* retryPendingRemovals(options, { apply: true });

          const settled = yield* readState(options);
          expect(settled.data.journal, `${variant.name} journal after`).toBeUndefined();
          expect(settled.data.links).toEqual([]);
          expect(yield* fileSystem.readDirectory(skills)).toEqual([]);
          results.set(variant.name, normalized(settled, path.join(world, variant.name)));
        }

        const control = results.get("control");
        for (const variant of removalVariants) {
          expect(results.get(variant.name), variant.name).toEqual(control);
        }
      }),
    { timeout: 120_000 },
  );
});

/** The links each kind has on disk, which the crash point decides. */
type MixedVariant = {
  readonly name: string;
  readonly crashPoint?: string;
  readonly journaled: number;
  readonly agentOnDisk: number;
  readonly docsOnDisk: number;
  readonly ledgerLinks: number;
};

const mixedVariants: ReadonlyArray<MixedVariant> = [
  { name: "control", journaled: 0, agentOnDisk: count, docsOnDisk: count, ledgerLinks: 2 * count },
  {
    name: "after-prepare",
    crashPoint: "after-prepare",
    journaled: 2 * count,
    agentOnDisk: 0,
    docsOnDisk: 0,
    ledgerLinks: 0,
  },
  // The agent links come first, so killing after count + 1 links leaves every agent link and one mount.
  ...[1, count, count + 1, 2 * count].map((k): MixedVariant => ({
    name: `after-actions:${k}`,
    crashPoint: `after-actions:${k}`,
    journaled: 2 * count,
    agentOnDisk: Math.min(k, count),
    docsOnDisk: Math.max(k - count, 0),
    ledgerLinks: 0,
  })),
  {
    name: "after-settle",
    crashPoint: "after-settle",
    journaled: 0,
    agentOnDisk: count,
    docsOnDisk: count,
    ledgerLinks: 2 * count,
  },
];

it.layer(LiveTestLayer)(
  "a killed mixed apply of agent links and docs mounts converges",
  (crashIt) => {
    crashIt.effect(
      "ends where an uninterrupted mixed apply ends, after a kill at every point of the batch",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const world = yield* fileSystem.realPath(
            yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-mixed-crash-" }),
          );
          const sources = path.join(world, "sources");
          const entries = applyCatalogEntries(sources, count);
          yield* Effect.forEach(entries, (entry) =>
            fileSystem.makeDirectory(entry.directoryPath, { recursive: true }),
          );
          yield* Effect.forEach(
            Array.from({ length: count }, (_, index) => index),
            (index) =>
              fileSystem.makeDirectory(mixedDocsSource(sources, index), { recursive: true }),
          );

          const results = new Map<string, { readonly state: unknown; readonly disk: unknown }>();
          for (const variant of mixedVariants) {
            const home = path.join(world, variant.name, "home");
            const stateDirectory = path.join(world, variant.name, "state");
            yield* fileSystem.makeDirectory(mixedProjectRoot(home), { recursive: true });
            const options = {
              environment: { TACK_STATE_DIR: stateDirectory },
              homeDirectory: home,
            } satisfies StateOptions;
            const child = yield* spawnFixture(
              "crash-apply.ts",
              { home, state: stateDirectory },
              {
                TACK_TEST_COUNT: String(count),
                TACK_TEST_MIXED: "1",
                TACK_TEST_SOURCES: sources,
                ...(variant.crashPoint === undefined
                  ? {}
                  : { TACK_TEST_CRASH_POINT: variant.crashPoint }),
              },
              world,
            );
            if (variant.crashPoint === undefined) {
              expect(yield* child.exitCode).toBe(0);
            } else {
              yield* expectKilled(child);
            }

            // The killed process left exactly what its crash point says, for both kinds.
            const skills = path.join(home, ".cursor", "skills");
            const docsDirectory = path.join(
              mixedProjectRoot(home),
              ".tack",
              "docs",
              crashApplyRegistrationId,
            );
            const listed = (directory: string) =>
              Effect.gen(function* () {
                return (yield* fileSystem.exists(directory))
                  ? yield* fileSystem.readDirectory(directory)
                  : [];
              });
            const left = yield* readState(options);
            expect(left.data.journal?.length ?? 0, `${variant.name} journal`).toBe(
              variant.journaled,
            );
            expect((yield* listed(skills)).length, `${variant.name} agent links`).toBe(
              variant.agentOnDisk,
            );
            expect((yield* listed(docsDirectory)).length, `${variant.name} docs mounts`).toBe(
              variant.docsOnDisk,
            );
            expect(left.data.links.length, `${variant.name} ledger`).toBe(variant.ledgerLinks);

            // The next writer recovers the journal of both kinds, then plans and applies what remains.
            const mounts = mixedDocsMounts(home, sources, count);
            yield* withRecoveredWriter(options, (writer) =>
              Effect.gen(function* () {
                const state = writer.current();
                const plan = yield* planReconciliation({
                  adapters: [agentAdapterDescriptor("cursor")],
                  catalogEntries: entries,
                  managedLinks: managedLinksOf(state.data.links),
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
                    [{ _tag: "user", canonicalPath: home }],
                  ),
                });
                const owned = new Set(
                  managedDocsLinksOf(state.data.links).map((link) => link.destinationPath),
                );
                const docsPlan = mixedDocsPlan(
                  mounts,
                  (mount) => !owned.has(mount.destinationPath),
                );
                yield* runPreparedBatch(
                  writer,
                  [...preparedBatchOfPlan(plan), ...docsPreparedBatchOf([docsPlan])],
                  (ledger) =>
                    Effect.gen(function* () {
                      yield* applyReconciliationUnits(ledger, plan);
                      yield* applyDocsActions(ledger, docsPlan);
                    }),
                );
              }),
            );

            const settled = yield* readState(options);
            const agentNames = yield* fileSystem.readDirectory(skills);
            const docsNames = yield* fileSystem.readDirectory(docsDirectory);
            expect(settled.data.journal, `${variant.name} journal after`).toBeUndefined();
            // No link is foreign and none is missing: the ledger and the disk name the same links.
            expect(
              managedLinksOf(settled.data.links)
                .map((link) => path.basename(managedLinkDestinationPath(link)))
                .toSorted(),
            ).toEqual(agentNames.toSorted());
            expect(
              managedDocsLinksOf(settled.data.links)
                .map((link) => path.basename(link.destinationPath))
                .toSorted(),
            ).toEqual(docsNames.toSorted());
            expect(docsNames).toHaveLength(count);
            results.set(variant.name, {
              state: normalized(settled, path.join(world, variant.name)),
              disk: { agentNames: agentNames.toSorted(), docsNames: docsNames.toSorted() },
            });
          }

          const control = results.get("control");
          for (const variant of mixedVariants) {
            expect(results.get(variant.name), variant.name).toEqual(control);
          }
        }),
      { timeout: 180_000 },
    );
  },
);
