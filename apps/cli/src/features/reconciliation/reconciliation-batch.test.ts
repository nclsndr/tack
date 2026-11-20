import { expect, it } from "@effect/vitest";
import { stallAt } from "../../../test/support/faults.ts";
import { Deferred, Effect, Fiber, FileSystem, Path, PlatformError } from "effect";
import { agentAdapterDescriptor } from "../../domain/agents/agent-adapter.ts";
import {
  initializeState,
  readState,
  StateStorageError,
  type StateOptions,
} from "../../services/state-store.ts";
import { agentLink, managedLinksOf } from "../../domain/links/link-record-schema.ts";
import type { ManagedLinkEvidence } from "../../domain/links/managed-link-schema.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { mutateState } from "../../../test/support/state-fixture.ts";
import type { ChoiceNamespace } from "../../domain/choices/choice-schema.ts";
import type { DependencyResolution } from "../../domain/choices/dependency-resolution.ts";
import { withRecoveredWriter } from "../writer/recovered-writer.ts";
import type { SkillCatalogEntry } from "../../domain/sources/catalog-schema.ts";
import { Destination } from "../../services/destination.ts";
import { applyReconciliationWithWriter } from "./reconciliation-application.test-support.ts";
import {
  planReconciliation,
  reconciliationNamespaces,
  type NamespaceDependencyResolution,
} from "./reconciliation.ts";
import type { ReconciliationPlan } from "../../domain/reconciliation/reconciliation-schema.ts";

/** The address of a skill, as a catalog entry carries it. */
type SkillAddress = SkillCatalogEntry["address"];

/*
 * The write path of one apply: it writes the state document a fixed number of times, however many
 * links the plan holds, and every action still proves its destination right before it changes it.
 */

const registrationId = "00000000-0000-4000-8000-000000000001";
const userNamespace = { _tag: "user" } satisfies ChoiceNamespace;

const address = (name: string): SkillAddress => ({
  kind: "skill",
  name,
  sourceRegistrationId: registrationId,
});

const catalogEntry = (name: string, directoryPath: string): SkillCatalogEntry => ({
  activation: "default",
  address: address(name),
  dependencies: [],
  description: `${name} description`,
  directoryPath,
  frontmatter: { description: `${name} description`, name },
  projects: [],
  skillFilePath: `${directoryPath}/SKILL.md`,
  sourcePath: "/sources/shared",
  sourceRegistrationId: registrationId,
});

const namespaceResolution = (
  addresses: ReadonlyArray<SkillAddress>,
): NamespaceDependencyResolution => ({
  namespace: userNamespace,
  resolution: {
    groups: addresses.map((member) => ({ _tag: "selected", members: [member] })),
    optionalSkips: [],
    requestBlockers: [],
  } satisfies DependencyResolution,
});

/** Counts the writes of `state.json` and tells what an apply did, in order. */
const makeRecorder = () => {
  const events: Array<string> = [];
  let stateWrites = 0;
  return {
    events,
    options: (stateDirectory: string, homeDirectory: string): StateOptions => ({
      environment: { TACK_STATE_DIR: stateDirectory },
      homeDirectory,
      observer: {
        wrote: () => {
          stateWrites += 1;
          events.push("state-write");
        },
        initialized: () => undefined,
      },
    }),
    stateWrites: () => stateWrites,
    reset: () => {
      stateWrites = 0;
      events.length = 0;
    },
  };
};

type World = {
  readonly home: string;
  readonly stateDirectory: string;
  readonly options: StateOptions;
  readonly recorder: ReturnType<typeof makeRecorder>;
  readonly sources: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<SkillCatalogEntry>;
};

/** A temporary home, state and `count` skill sources, with initialized state. */
const withWorld = <A, E, R>(count: number, use: (world: World) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-batch-test-" }),
    );
    const home = path.join(root, "home");
    const sources = Array.from({ length: count }, (_, index) =>
      path.join(root, "sources", `skill-${String(index).padStart(4, "0")}`),
    );
    yield* fileSystem.makeDirectory(home, { recursive: true });
    yield* Effect.forEach(sources, (source) =>
      fileSystem.makeDirectory(source, { recursive: true }),
    );
    const recorder = makeRecorder();
    const stateDirectory = path.join(root, "state");
    const options = recorder.options(stateDirectory, home);
    yield* initializeState(options);
    recorder.reset();
    return yield* use({
      entries: sources.map((source) => catalogEntry(path.basename(source), source)),
      home,
      options,
      recorder,
      sources,
      stateDirectory,
    });
  });

const planFor = (
  world: World,
  entries: ReadonlyArray<SkillCatalogEntry>,
  state?: ManagedLinkEvidence[],
) =>
  planReconciliation({
    adapters: [agentAdapterDescriptor("cursor")],
    catalogEntries: entries,
    managedLinks: state ?? [],
    namespaces: reconciliationNamespaces(
      [namespaceResolution(entries.map((entry) => entry.address))],
      [{ _tag: "user", canonicalPath: world.home }],
    ),
  });

const applyPlan = (world: World, plan: ReconciliationPlan) =>
  withRecoveredWriter(world.options, (writer) => applyReconciliationWithWriter(writer, plan));

const platformError = (method: string) =>
  PlatformError.badArgument({ module: "reconciliation-batch-test", method });

it.layer(LiveTestLayer)("one apply is one prepared batch", (batchIt) => {
  for (const count of [100, 200, 400, 800]) {
    batchIt.effect(
      `writes state exactly twice to create ${count} links, and never for a no-op`,
      () =>
        withWorld(count, (world) =>
          Effect.gen(function* () {
            const plan = yield* planFor(world, world.entries);
            const result = yield* applyPlan(world, plan);

            expect(result.units.map((unit) => unit.status)).toEqual(["success"]);
            expect(world.recorder.stateWrites()).toBe(2);
            const settled = yield* readState(world.options);
            expect(managedLinksOf(settled.data.links)).toHaveLength(count);
            expect(settled.data.journal).toBeUndefined();

            // Converged: a second plan has no action, and applying it writes nothing.
            world.recorder.reset();
            const converged = yield* planFor(
              world,
              world.entries,
              managedLinksOf(settled.data.links),
            );
            expect(converged.units.flatMap((unit) => unit.actions)).toEqual([]);
            yield* applyPlan(world, converged);
            expect(world.recorder.stateWrites()).toBe(0);
          }),
        ),
      { timeout: 120_000 },
    );
  }

  batchIt.effect("writes state exactly twice to remove 200 links", () =>
    withWorld(200, (world) =>
      Effect.gen(function* () {
        yield* applyPlan(world, yield* planFor(world, world.entries));
        const owned = managedLinksOf((yield* readState(world.options)).data.links);
        world.recorder.reset();

        const removal = yield* planFor(world, [], owned);
        expect(removal.units.flatMap((unit) => unit.actions)).toHaveLength(200);
        yield* applyPlan(world, removal);

        expect(world.recorder.stateWrites()).toBe(2);
        const settled = yield* readState(world.options);
        expect(settled.data.links).toEqual([]);
        expect(settled.data.journal).toBeUndefined();
      }),
    ),
  );

  batchIt.effect("prepares one entry per destination, and one entry for a replacement", () =>
    withWorld(6, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const [kept, replaced, removed, ...created] = world.entries;
        if (kept === undefined || replaced === undefined || removed === undefined) {
          throw new Error("Expected six entries.");
        }
        yield* applyPlan(world, yield* planFor(world, [kept, replaced, removed]));
        // The replaced skill's source moves, so its link is replaced; the removed one is deselected.
        const moved = path.join(world.home, "moved", path.basename(replaced.directoryPath));
        yield* fileSystem.makeDirectory(moved, { recursive: true });
        const owned = managedLinksOf((yield* readState(world.options)).data.links);
        const next = [kept, { ...replaced, directoryPath: moved }, ...created];
        const plan = yield* planFor(world, next, owned);
        const tags = plan.units.flatMap((unit) => unit.actions.map((action) => action._tag));
        expect(tags).toContain("link-remove");
        expect(tags.filter((tag) => tag === "link-create")).toHaveLength(4);

        const journals: Array<ReadonlyArray<string>> = [];
        yield* Effect.provideService(applyPlan(world, plan), FileSystem.FileSystem, {
          ...fileSystem,
          symlink: (fromPath, toPath) =>
            readState(world.options).pipe(
              Effect.tap((state) =>
                Effect.sync(() => {
                  if (journals.length === 0) {
                    journals.push(
                      (state.data.journal ?? []).map(
                        (entry) => `${entry._tag}:${path.basename(entry.link.destinationPath)}`,
                      ),
                    );
                  }
                }),
              ),
              Effect.orDie,
              Effect.flatMap(() => fileSystem.symlink(fromPath, toPath)),
            ),
        });

        expect(journals).toHaveLength(1);
        const prepared = journals[0] ?? [];
        // Four creates, the replacement of one destination as a single entry, and the removal.
        expect([...prepared].sort()).toEqual(
          [
            ...created.map((entry) => `create:${entry.address.name}`),
            `replace:${replaced.address.name}`,
            `remove:${removed.address.name}`,
          ].sort(),
        );
        const settled = yield* readState(world.options);
        expect(settled.data.journal).toBeUndefined();
        expect(
          managedLinksOf(settled.data.links)
            .map((link) => link.address.name)
            .sort(),
        ).toEqual([kept, replaced, ...created].map((entry) => entry.address.name).sort());
      }),
    ),
  );

  batchIt.effect(
    "merges a removal and a creation at one destination into one replacement entry",
    () =>
      withWorld(2, (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const [entry, other] = world.entries;
          if (entry === undefined || other === undefined) throw new Error("Expected two entries.");
          yield* applyPlan(world, yield* planFor(world, [entry, other]));
          const moved = path.join(world.home, "moved", entry.address.name);
          yield* fileSystem.makeDirectory(moved, { recursive: true });
          const owned = managedLinksOf((yield* readState(world.options)).data.links);
          const planned = yield* planFor(world, [{ ...entry, directoryPath: moved }, other], owned);
          // A plan need not name the replaced evidence on its creation: the pair still merges.
          const plan: ReconciliationPlan = {
            ...planned,
            units: planned.units.map((unit) => ({
              ...unit,
              actions: unit.actions.map((action) => {
                if (action._tag !== "link-create") return action;
                const { previousEvidence: _previous, ...bare } = action;
                return bare;
              }),
            })),
          };
          const journals: Array<ReadonlyArray<string>> = [];
          yield* applyPlan(world, plan).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fileSystem,
              symlink: (fromPath, toPath) =>
                readState(world.options).pipe(
                  Effect.tap((state) =>
                    Effect.sync(() => {
                      journals.push(
                        (state.data.journal ?? []).map(
                          (prepared) => `${prepared._tag}:${prepared.link.resource.name}`,
                        ),
                      );
                    }),
                  ),
                  Effect.orDie,
                  Effect.flatMap(() => fileSystem.symlink(fromPath, toPath)),
                ),
            }),
          );

          expect(journals[0]).toEqual([`replace:${entry.address.name}`]);
          const settled = yield* readState(world.options);
          expect(
            managedLinksOf(settled.data.links).map((link) => link.sourceDirectoryPath),
          ).toContain(moved);
        }),
      ),
  );

  batchIt.effect("retires the old link of a replacement whose creation then fails", () =>
    withWorld(2, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const [entry, other] = world.entries;
        if (entry === undefined || other === undefined) throw new Error("Expected two entries.");
        yield* applyPlan(world, yield* planFor(world, [entry, other]));
        const moved = path.join(world.home, "moved", entry.address.name);
        yield* fileSystem.makeDirectory(moved, { recursive: true });
        const owned = managedLinksOf((yield* readState(world.options)).data.links);
        const plan = yield* planFor(world, [{ ...entry, directoryPath: moved }, other], owned);

        const result = yield* applyPlan(world, plan).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            symlink: () => Effect.fail(platformError("symlink")),
          }),
        );

        expect(result.units[0]?.status).toBe("partial");
        // The old link was removed, so Tack no longer manages it, though its replacement failed.
        const link = path.join(world.home, ".cursor", "skills", entry.address.name);
        expect(yield* fileSystem.exists(link)).toBe(false);
        const settled = yield* readState(world.options);
        expect(managedLinksOf(settled.data.links).map((record) => record.address.name)).toEqual([
          other.address.name,
        ]);
        expect(settled.data.journal).toBeUndefined();
      }),
    ),
  );

  batchIt.effect("proves a destination right before changing it, with no state write between", () =>
    withWorld(5, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const destination = yield* Destination;
        const [first, ...rest] = world.entries;
        if (first === undefined) throw new Error("Expected entries.");
        yield* applyPlan(world, yield* planFor(world, [first, ...rest.slice(0, 2)]));
        const owned = managedLinksOf((yield* readState(world.options)).data.links);
        world.recorder.reset();

        // Remove one link, create two others: both kinds of mutation in one batch.
        const plan = yield* planFor(world, [first, ...rest.slice(1, 4)], owned);
        const { events } = world.recorder;
        const linkPath = (target: string) => path.relative(world.home, target);
        const recording: FileSystem.FileSystem = {
          ...fileSystem,
          symlink: (fromPath, toPath) =>
            Effect.sync(() => events.push(`symlink ${linkPath(toPath)}`)).pipe(
              Effect.flatMap(() => fileSystem.symlink(fromPath, toPath)),
            ),
          remove: (target, options) =>
            Effect.sync(() => events.push(`remove ${linkPath(target)}`)).pipe(
              Effect.flatMap(() => fileSystem.remove(target, options)),
            ),
        };
        yield* applyPlan(world, plan).pipe(
          Effect.provideService(FileSystem.FileSystem, recording),
          Effect.provideService(Destination, {
            ...destination,
            observe: (target) =>
              Effect.sync(() => events.push(`observe ${linkPath(target)}`)).pipe(
                Effect.flatMap(() => destination.observe(target)),
              ),
          }),
        );

        const mutations = events.flatMap((event, index) =>
          event.startsWith("symlink ") || event.startsWith("remove ") ? [index] : [],
        );
        expect(mutations).toHaveLength(3);
        for (const index of mutations) {
          const mutation = events[index] ?? "";
          const target = mutation.slice(mutation.indexOf(" ") + 1);
          // The event just before a change is the proof of that same destination.
          expect(events[index - 1]).toBe(`observe ${target}`);
        }
        // State is written once before the first change and once after the last, nowhere between.
        expect(events.filter((event) => event === "state-write")).toHaveLength(2);
        expect(events[0]).toBe("state-write");
        expect(events.at(-1)).toBe("state-write");
      }),
    ),
  );

  batchIt.effect("an interrupted apply settles the actions that completed before it exits", () =>
    withWorld(6, (world) =>
      Effect.gen(function* () {
        const plan = yield* planFor(world, world.entries);
        const stall = yield* stallAt("symlink", { call: 4 }, { when: "after" });
        const fiber = yield* applyPlan(world, plan).pipe(
          Effect.provideService(FileSystem.FileSystem, stall.fileSystem),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(stall.entered);
        yield* Fiber.interrupt(fiber);

        // The three completed links are recorded. The fourth was mid-change, so its entry stays
        // prepared for the next writer; the two that never started are dropped.
        expect(world.recorder.stateWrites()).toBe(2);
        const state = yield* readState(world.options);
        expect(managedLinksOf(state.data.links).map((link) => link.address.name)).toEqual(
          world.entries.slice(0, 3).map((entry) => entry.address.name),
        );
        expect(
          state.data.journal?.map((entry) => `${entry._tag}:${entry.link.resource.name}`),
        ).toEqual([`create:${world.entries[3]?.address.name}`]);

        // The next writer settles that one by observation: the link exists, so it is recorded.
        yield* withRecoveredWriter(world.options, () => Effect.void);
        const recovered = yield* readState(world.options);
        expect(recovered.data.journal).toBeUndefined();
        expect(managedLinksOf(recovered.data.links).map((link) => link.address.name)).toEqual(
          world.entries.slice(0, 4).map((entry) => entry.address.name),
        );
      }),
    ),
  );

  batchIt.effect(
    "writes once more to recover a journal it finds, and then twice for its own plan",
    () =>
      withWorld(6, (world) =>
        Effect.gen(function* () {
          const stall = yield* stallAt("symlink", { call: 2 }, { when: "after" });
          const fiber = yield* applyPlan(world, yield* planFor(world, world.entries)).pipe(
            Effect.provideService(FileSystem.FileSystem, stall.fileSystem),
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(stall.entered);
          yield* Fiber.interrupt(fiber);
          expect((yield* readState(world.options)).data.journal).toHaveLength(1);
          world.recorder.reset();

          // The next writer settles the journal it finds, then plans from the recovered ledger.
          const result = yield* withRecoveredWriter(world.options, (writer) =>
            planFor(world, world.entries, managedLinksOf(writer.current().data.links)).pipe(
              Effect.flatMap((plan) => applyReconciliationWithWriter(writer, plan)),
            ),
          );

          expect(result.units.map((unit) => unit.status)).toEqual(["success"]);
          expect(world.recorder.stateWrites()).toBe(3);
          const settled = yield* readState(world.options);
          expect(managedLinksOf(settled.data.links)).toHaveLength(6);
          expect(settled.data.journal).toBeUndefined();
        }),
      ),
  );

  batchIt.effect("a failed settle write leaves the batch for the next writer to settle", () =>
    withWorld(5, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const statePath = path.join(world.stateDirectory, "state.json");
        const plan = yield* planFor(world, world.entries);
        let stateRenames = 0;
        const diskFull: FileSystem.FileSystem = {
          ...fileSystem,
          rename: (fromPath, toPath) => {
            if (toPath !== statePath) return fileSystem.rename(fromPath, toPath);
            stateRenames += 1;
            // The prepare write succeeds; the settle write does not.
            return stateRenames === 1
              ? fileSystem.rename(fromPath, toPath)
              : Effect.fail(platformError("rename"));
          },
        };

        const error = yield* provideTestFileSystem(applyPlan(world, plan), diskFull).pipe(
          Effect.flip,
        );
        expect(error).toBeInstanceOf(StateStorageError);

        // Every link exists on disk, and the journal still names each of them.
        const stranded = yield* readState(world.options);
        expect(stranded.data.links).toEqual([]);
        expect(stranded.data.journal).toHaveLength(5);
        const links = yield* Effect.forEach(world.entries, (entry) =>
          fileSystem.exists(path.join(world.home, ".cursor", "skills", entry.address.name)),
        );
        expect(links).toEqual([true, true, true, true, true]);

        yield* withRecoveredWriter(world.options, () => Effect.void);
        const recovered = yield* readState(world.options);
        expect(recovered.data.journal).toBeUndefined();
        expect(recovered.data.links).toHaveLength(5);
      }),
    ),
  );

  batchIt.effect(
    "refuses a replacement over a removal that is still owed before changing anything",
    () =>
      withWorld(2, (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const [entry, other] = world.entries;
          if (entry === undefined || other === undefined) throw new Error("Expected two entries.");
          yield* applyPlan(world, yield* planFor(world, [entry]));
          const previous = managedLinksOf((yield* readState(world.options)).data.links);
          const evidence = previous[0];
          if (evidence === undefined) throw new Error("Expected recorded evidence.");
          yield* mutateState(world.options, (state) => ({
            ...state,
            data: {
              ...state.data,
              links: state.data.links.map((record) => ({
                ...record,
                removal: { cause: "root-removal" as const },
              })),
            },
          }));
          const moved = path.join(world.home, "moved", entry.address.name);
          yield* fileSystem.makeDirectory(moved, { recursive: true });
          const plan = yield* planFor(world, [{ ...entry, directoryPath: moved }, other], previous);
          world.recorder.reset();

          const error = yield* Effect.flip(applyPlan(world, plan));

          expect(error.message).toContain("Prepared links must agree");
          // Nothing was prepared or changed: the old link is still there and still recorded.
          expect(world.recorder.stateWrites()).toBe(0);
          const link = path.join(world.home, ".cursor", "skills", entry.address.name);
          expect(yield* fileSystem.exists(link)).toBe(true);
          expect(
            yield* fileSystem.exists(
              path.join(world.home, ".cursor", "skills", other.address.name),
            ),
          ).toBe(false);
          expect((yield* readState(world.options)).data.links).toEqual([
            { ...agentLink(evidence), removal: { cause: "root-removal" } },
          ]);
        }),
      ),
  );
});
