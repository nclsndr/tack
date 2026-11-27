import { expect, it } from "@effect/vitest";
import { stallAt } from "../../../test/support/faults.ts";
import { Deferred, Effect, Fiber, FileSystem, Path, PlatformError } from "effect";
import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import {
  initializeState,
  readState,
  StateStorageError,
  type StateOptions,
} from "../../services/state-store.ts";
import { managedLinksOf, pendingRemovalsOf } from "../../domain/links/link-record-schema.ts";
import type { ManagedLinkEvidence } from "../../domain/links/managed-link-schema.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import {
  mutateStateFixture,
  evidenceFor,
  targetProject,
} from "../../../test/support/state-fixture.ts";
import {
  planRemovalAt,
  removeProject,
  removeProjectRoot,
  retryPendingRemovals,
} from "../../../test/support/removal.ts";
import { disableAdapter } from "./adapter-disablement.ts";
import { withRecoveredWriter } from "../writer/recovered-writer.ts";
import { cleanManagedLinks, resetTack } from "./selected-removal.ts";
import { applyRemovalWithWriter } from "./removal-apply.ts";

/*
 * The write path of one removal: it writes the state document a fixed number of times, whatever the
 * number of links, with the obligations in the first write and the results in the last.
 */

const platformError = (method: string) =>
  PlatformError.badArgument({ module: "removal-batch-test", method });

type World = {
  readonly evidence: ReadonlyArray<ManagedLinkEvidence>;
  readonly links: ReadonlyArray<string>;
  readonly options: StateOptions;
  readonly projectRoot: string;
  readonly stateDirectory: string;
  readonly writes: () => number;
  readonly resetWrites: () => void;
};

/** A project whose root holds `count` recorded, owned links, with state initialized. */
const withLinks = <A, E, R>(count: number, use: (world: World) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-removal-batch-test-" }),
    );
    const stateDirectory = path.join(root, "state");
    const projectRoot = path.join(root, "project-root");
    const source = path.join(root, "source");
    let writes = 0;
    const options: StateOptions = {
      stateDirectory,
      homeDirectory: path.join(root, "home"),
      observer: {
        wrote: () => {
          writes += 1;
        },
        initialized: () => undefined,
      },
    };
    const skills = path.join(projectRoot, ".agents", "skills");
    yield* fileSystem.makeDirectory(skills, { recursive: true });
    yield* fileSystem.makeDirectory(source, { recursive: true });
    const names = Array.from(
      { length: count },
      (_, index) => `skill-${String(index).padStart(4, "0")}`,
    );
    yield* Effect.forEach(names, (name) =>
      fileSystem
        .makeDirectory(path.join(source, name), { recursive: true })
        .pipe(
          Effect.flatMap(() =>
            fileSystem.symlink(
              path.join("..", "..", "..", "source", name),
              path.join(skills, name),
            ),
          ),
        ),
    );
    const canonicalRoot = yield* fileSystem.realPath(projectRoot);
    const canonicalSource = yield* fileSystem.realPath(source);
    const evidence = names.map((name) =>
      evidenceFor(
        "codex",
        targetProject("project", canonicalRoot),
        path.join(canonicalSource, name),
        name,
      ),
    );
    yield* initializeState(options);
    yield* mutateStateFixture(options, (state) => ({
      ...state,
      data: {
        ...state.data,
        enabledAdapters: ["codex"],
        agentLinks: evidence,
        projects: [
          { gitCommonDirectory: `${canonicalRoot}/.git`, name: "project", roots: [canonicalRoot] },
        ],
      },
    }));
    writes = 0;
    return yield* use({
      evidence,
      links: evidence.map(managedLinkDestinationPath),
      options,
      projectRoot: canonicalRoot,
      resetWrites: () => {
        writes = 0;
      },
      stateDirectory,
      writes: () => writes,
    });
  });

it.layer(LiveTestLayer)("one removal is one prepared batch", (removalIt) => {
  for (const count of [100, 400]) {
    removalIt.effect(
      `removes a project of ${count} links with two state writes, and finalizes it in the second`,
      () =>
        withLinks(count, (world) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const execution = yield* removeProject(world.options, {
              apply: true,
              projectName: "project",
            });

            expect(execution.applied?.finalizedProject).toBe(true);
            expect(world.writes()).toBe(2);
            const settled = yield* readState(world.options);
            expect(settled.data.projects).toEqual([]);
            expect(settled.data.links).toEqual([]);
            expect(settled.data.journal).toBeUndefined();
            const present = yield* Effect.forEach(world.links, (link) => fileSystem.exists(link));
            expect(present.some((exists) => exists)).toBe(false);
          }),
        ),
      { timeout: 120_000 },
    );
  }

  removalIt.effect("cleans 200 links, disables their adapter and resets with two writes each", () =>
    Effect.gen(function* () {
      yield* withLinks(200, (world) =>
        Effect.gen(function* () {
          const execution = yield* cleanManagedLinks(world.options, {
            apply: true,
            cwd: world.projectRoot,
            selector: { _tag: "all" },
          });
          expect(execution.applied?.actions).toHaveLength(200);
          expect(world.writes()).toBe(2);
          expect((yield* readState(world.options)).data.links).toEqual([]);
        }),
      );
      yield* withLinks(200, (world) =>
        Effect.gen(function* () {
          const execution = yield* disableAdapter(world.options, "codex", { apply: true });
          expect(execution.applied?.removal.actions).toHaveLength(200);
          // The adapter setting and every obligation go in the prepare write.
          expect(world.writes()).toBe(2);
          const settled = yield* readState(world.options);
          expect(settled.data.enabledAdapters).toEqual([]);
          expect(settled.data.links).toEqual([]);
        }),
      );
      yield* withLinks(200, (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const execution = yield* resetTack(world.options, { apply: true });
          expect(execution.applied?.actions).toHaveLength(200);
          // Reset keeps only the obligations, then deletes the document when none is left.
          expect(world.writes()).toBe(2);
          expect(yield* fileSystem.exists(path.join(world.stateDirectory, "state.json"))).toBe(
            false,
          );
        }),
      );
    }),
  );

  removalIt.effect("an apply with nothing owed and nothing to remove writes nothing", () =>
    withLinks(3, (world) =>
      Effect.gen(function* () {
        const before = yield* readState(world.options);
        const execution = yield* retryPendingRemovals(world.options, { apply: true });

        expect(execution.applied?.actions).toEqual([]);
        expect(world.writes()).toBe(0);
        expect(yield* readState(world.options)).toEqual(before);
      }),
    ),
  );

  removalIt.effect(
    "records every blocked result in the settle write and keeps what is still owed",
    () =>
      withLinks(6, (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          // The operator replaced two links with their own files.
          const foreign = world.links.slice(0, 2);
          yield* Effect.forEach(foreign, (link) =>
            fileSystem
              .remove(link)
              .pipe(Effect.flatMap(() => fileSystem.writeFileString(link, "operator"))),
          );

          const execution = yield* removeProjectRoot(world.options, {
            apply: true,
            canonicalRoot: world.projectRoot,
            projectName: "project",
          });

          expect(world.writes()).toBe(2);
          expect(execution.applied?.actions.map((action) => action._tag)).toEqual([
            "skipped",
            "skipped",
            "applied",
            "applied",
            "applied",
            "applied",
          ]);
          expect(execution.applied?.finalizedProject).toBe(false);
          const state = yield* readState(world.options);
          expect(state.data.journal).toBeUndefined();
          expect(managedLinksOf(state.data.links)).toHaveLength(2);
          expect(pendingRemovalsOf(state.data.links)).toHaveLength(2);
          expect(
            pendingRemovalsOf(state.data.links).map((pending) => pending.lastResult?._tag),
          ).toEqual(["blocked", "blocked"]);
          expect(state.data.projects[0]).toMatchObject({ removalIntent: "project", roots: [] });
        }),
      ),
  );

  removalIt.effect("blocks a retirement whose destination reappeared after planning", () =>
    withLinks(2, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const [gone, kept] = world.links;
        if (gone === undefined || kept === undefined) throw new Error("Expected two links.");
        yield* fileSystem.remove(gone);
        const plan = yield* planRemovalAt(world.options, {
          cause: "root-removal",
          scope: { _tag: "project-root", canonicalRoot: world.projectRoot, projectName: "project" },
        });
        expect(plan.actions.map((action) => action._tag)).toEqual(["retire", "remove"]);
        // An operator writes their own file where the link used to be, before the apply.
        yield* fileSystem.writeFileString(gone, "operator");

        const result = yield* withRecoveredWriter(world.options, (writer) =>
          applyRemovalWithWriter(writer, plan),
        );

        expect(result.actions.map((action) => action._tag)).toEqual(["skipped", "applied"]);
        expect(yield* fileSystem.readFileString(gone)).toBe("operator");
        const state = yield* readState(world.options);
        expect(
          pendingRemovalsOf(state.data.links).map((pending) => [
            pending.evidence.address.name,
            pending.lastResult?._tag,
          ]),
        ).toEqual([["skill-0000", "blocked"]]);
        expect(world.writes()).toBe(2);
      }),
    ),
  );

  removalIt.effect("an interrupted removal settles the unlinks that completed", () =>
    withLinks(5, (world) =>
      Effect.gen(function* () {
        const stall = yield* stallAt("remove", { call: 3 }, { when: "after" });
        const fiber = yield* removeProjectRoot(world.options, {
          apply: true,
          canonicalRoot: world.projectRoot,
          projectName: "project",
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, stall.fileSystem),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(stall.entered);
        yield* Fiber.interrupt(fiber);

        // Two unlinks completed and are settled. The third was running, so its journal entry
        // stays for the next writer. The last two never started: they still owe their removal.
        expect(world.writes()).toBe(2);
        const state = yield* readState(world.options);
        expect(state.data.journal?.map((entry) => entry.link.resource.name)).toEqual([
          "skill-0002",
        ]);
        const owed = pendingRemovalsOf(state.data.links).map((pending) => [
          pending.evidence.address.name,
          pending.lastResult?._tag,
        ]);
        expect(owed).toEqual([
          ["skill-0002", "interrupted"],
          ["skill-0003", undefined],
          ["skill-0004", undefined],
        ]);

        // The next writer decides the retained entry by observation: the link is gone.
        yield* withRecoveredWriter(world.options, () => Effect.void);
        const recovered = yield* readState(world.options);
        expect(recovered.data.journal).toBeUndefined();
        expect(managedLinksOf(recovered.data.links).map((link) => link.address.name)).toEqual([
          "skill-0003",
          "skill-0004",
        ]);
      }),
    ),
  );

  removalIt.effect("a failed settle write leaves the obligations and journal to recover from", () =>
    withLinks(4, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const statePath = path.join(world.stateDirectory, "state.json");
        let stateRenames = 0;
        const diskFull: FileSystem.FileSystem = {
          ...fileSystem,
          rename: (fromPath, toPath) => {
            if (toPath !== statePath) return fileSystem.rename(fromPath, toPath);
            stateRenames += 1;
            return stateRenames === 1
              ? fileSystem.rename(fromPath, toPath)
              : Effect.fail(platformError("rename"));
          },
        };

        const error = yield* provideTestFileSystem(
          removeProjectRoot(world.options, {
            apply: true,
            canonicalRoot: world.projectRoot,
            projectName: "project",
          }),
          diskFull,
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(StateStorageError);
        const stranded = yield* readState(world.options);
        expect(stranded.data.journal).toHaveLength(4);
        expect(pendingRemovalsOf(stranded.data.links)).toHaveLength(4);
        const present = yield* Effect.forEach(world.links, (link) => fileSystem.exists(link));
        expect(present).toEqual([false, false, false, false]);

        // Recovery sees every link gone: none is managed any more, and each removal is still owed.
        yield* withRecoveredWriter(world.options, () => Effect.void);
        const recovered = yield* readState(world.options);
        expect(recovered.data.journal).toBeUndefined();
        expect(managedLinksOf(recovered.data.links)).toEqual([]);
        expect(pendingRemovalsOf(recovered.data.links)).toHaveLength(4);
      }),
    ),
  );

  removalIt.effect("proves ownership right before each unlink, with no state write between", () =>
    withLinks(4, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const events: Array<string> = [];
        const statePath = path.join(world.stateDirectory, "state.json");
        const recording: FileSystem.FileSystem = {
          ...fileSystem,
          rename: (fromPath, toPath) =>
            Effect.sync(() => toPath === statePath && events.push("state-write")).pipe(
              Effect.flatMap(() => fileSystem.rename(fromPath, toPath)),
            ),
          readLink: (target) =>
            Effect.sync(() => events.push(`readlink ${path.basename(target)}`)).pipe(
              Effect.flatMap(() => fileSystem.readLink(target)),
            ),
          remove: (target, options) =>
            Effect.sync(() => events.push(`unlink ${path.basename(target)}`)).pipe(
              Effect.flatMap(() => fileSystem.remove(target, options)),
            ),
        };

        yield* provideTestFileSystem(
          removeProjectRoot(world.options, {
            apply: true,
            canonicalRoot: world.projectRoot,
            projectName: "project",
          }),
          recording,
        );

        const unlinks = events.flatMap((event, index) =>
          event.startsWith("unlink skill-") ? [index] : [],
        );
        expect(unlinks).toHaveLength(4);
        for (const index of unlinks) {
          // The state is only written before the first unlink and after the last one.
          expect(events.slice(unlinks[0] ?? 0, index + 1)).not.toContain("state-write");
        }
        expect(events.filter((event) => event === "state-write")).toHaveLength(2);
        expect(events.indexOf("state-write")).toBeLessThan(unlinks[0] ?? 0);
        expect(events.lastIndexOf("state-write")).toBeGreaterThan(unlinks.at(-1) ?? 0);
      }),
    ),
  );
});
