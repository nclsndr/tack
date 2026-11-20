import { pendingRemovalsOf } from "../../domain/links/link-record-schema.ts";
import { stallAt } from "../../../test/support/faults.ts";
import { allSkillChoices } from "../../domain/state/state-intent.ts";
import {
  mutateStateFixture,
  runtimeFixture,
  withStateFixture,
  evidenceFor,
  setupLink,
  fixtureSourceId,
} from "../../../test/support/state-fixture.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, FileSystem, Fiber, Path, PlatformError, Schema } from "effect";

import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import { RemovalPlanSchema } from "../../domain/reconciliation/removal-schema.ts";
import {
  cleanManagedLinks,
  resetTack,
  retrySelectedPendingRemovals,
  type RetryPendingRemovalOptions,
} from "./selected-removal.ts";
import {
  readState,
  StateBusyError,
  StateNotInitializedError,
  StateStorageError,
  type StateOptions,
} from "../../services/state-store.ts";
import {
  docsLink,
  docsPendingRemovalsOf,
  reportDocsManagedLink,
} from "../../domain/docs/docs-schema.ts";
import { attachDocs } from "../docs/docs.ts";
import { retryPendingRemovals } from "../../../test/support/removal.ts";
import {
  docsEvidence,
  docsJournal,
  docsRequest,
  replaceDocsLinks,
  syncDocsReport,
  withDocsWorld,
} from "../../../test/support/docs-world.ts";

const retryOptions = (
  cwd: string,
  selector: RetryPendingRemovalOptions["selector"],
  apply = true,
): RetryPendingRemovalOptions => ({ apply, cwd, selector });

it.layer(LiveTestLayer)("reset and pending-removal retry", (resetIt) => {
  resetIt.effect("deletes an initialized state with no cleanup obligations", () =>
    withStateFixture(({ options, statePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;

        const execution = yield* resetTack(options, { apply: true });

        expect(execution.plan.actions).toEqual([]);
        expect(execution.applied?.actions).toEqual([]);
        expect(execution.applied?.pending).toEqual([]);
        expect(yield* fileSystem.exists(statePath)).toBe(false);
      }),
    ),
  );

  resetIt.effect(
    "plans without mutation and fully resets owned state while preserving operator content",
    () =>
      withStateFixture(({ options, root, stateDirectory, statePath }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dotenvPath = path.join(stateDirectory, ".env");
          const projectRootPath = path.join(root, "project");
          const userRootPath = path.join(root, "user");
          const sourcePath = path.join(root, "registered-source");
          yield* fileSystem.makeDirectory(projectRootPath, { recursive: true });
          yield* fileSystem.makeDirectory(userRootPath, { recursive: true });
          yield* fileSystem.makeDirectory(sourcePath, { recursive: true });
          yield* fileSystem.writeFileString(path.join(sourcePath, "operator.txt"), "keep-source");
          yield* fileSystem.writeFileString(dotenvPath, "TACK_TOKEN=keep-secret\n");
          const projectRoot = yield* fileSystem.realPath(projectRootPath);
          const userRoot = yield* fileSystem.realPath(userRootPath);
          const source = yield* fileSystem.realPath(sourcePath);
          const projectEvidence = evidenceFor(
            "codex",
            { _tag: "project-root", canonicalPath: projectRoot, projectName: "project" },
            source,
            "alpha",
          );
          const userEvidence = evidenceFor(
            "cursor",
            { _tag: "user", canonicalPath: userRoot },
            source,
            "beta",
          );
          const projectDestination = yield* setupLink(projectEvidence);
          const userDestination = yield* setupLink(userEvidence);
          const projectDestinationDirectory = path.dirname(projectDestination);
          const userDestinationDirectory = path.dirname(userDestination);
          const foreignPath = path.join(projectDestinationDirectory, "operator-file");
          yield* fileSystem.writeFileString(foreignPath, "keep-foreign");
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              choices: [
                {
                  address: projectEvidence.address,
                  decision: "include" as const,
                  namespace: { _tag: "project" as const, projectName: "project" },
                },
              ],
              enabledAdapters: ["codex", "cursor"],
              managedLinks: [projectEvidence, userEvidence],
              projects: [
                {
                  gitCommonDirectory: path.join(projectRoot, ".git"),
                  name: "project",
                  roots: [projectRoot],
                },
              ],
              sources: [
                {
                  canonicalPath: source,
                  id: projectEvidence.sourceRegistrationId,
                },
              ],
            },
          }));
          const stateBefore = yield* fileSystem.readFileString(statePath);

          const dryRun = yield* resetTack(options, { apply: false });

          expect(dryRun.plan).toMatchObject({ cause: "reset", scope: { _tag: "reset" } });
          expect(dryRun.plan.actions).toHaveLength(2);
          expect(Schema.decodeUnknownSync(RemovalPlanSchema)(dryRun.plan)).toEqual(dryRun.plan);
          expect(() =>
            Schema.decodeUnknownSync(RemovalPlanSchema)({ ...dryRun.plan, cause: "clean" }),
          ).toThrow();
          expect(() =>
            Schema.decodeUnknownSync(RemovalPlanSchema)({
              ...dryRun.plan,
              finalizeProject: true,
            }),
          ).toThrow();
          expect(dryRun.applied).toBeUndefined();
          expect(yield* fileSystem.readFileString(statePath)).toBe(stateBefore);
          expect(yield* fileSystem.exists(projectDestination)).toBe(true);
          expect(yield* fileSystem.exists(userDestination)).toBe(true);

          const applied = yield* resetTack(options, { apply: true });

          expect(applied.plan).toEqual(dryRun.plan);
          expect(applied.applied?.pending).toEqual([]);
          expect(yield* fileSystem.exists(statePath)).toBe(false);
          expect(yield* fileSystem.exists(projectDestination)).toBe(false);
          expect(yield* fileSystem.exists(userDestination)).toBe(false);
          expect(yield* fileSystem.exists(projectDestinationDirectory)).toBe(true);
          expect(yield* fileSystem.exists(userDestinationDirectory)).toBe(true);
          expect(yield* fileSystem.readFileString(foreignPath)).toBe("keep-foreign");
          expect(yield* fileSystem.readFileString(dotenvPath)).toBe("TACK_TOKEN=keep-secret\n");
          expect(yield* fileSystem.readFileString(path.join(source, "operator.txt"))).toBe(
            "keep-source",
          );
          expect(yield* Effect.flip(readState(options))).toBeInstanceOf(StateNotInitializedError);
        }),
      ),
  );

  resetIt.effect(
    "retains exact minimal recovery state and never repeats completed reset removals",
    () =>
      withStateFixture(({ options, root, statePath }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const projectRootPath = path.join(root, "project");
          const sourcePath = path.join(root, "source");
          yield* fileSystem.makeDirectory(projectRootPath, { recursive: true });
          yield* fileSystem.makeDirectory(sourcePath, { recursive: true });
          const projectRoot = yield* fileSystem.realPath(projectRootPath);
          const source = yield* fileSystem.realPath(sourcePath);
          const matching = evidenceFor(
            "codex",
            { _tag: "project-root", canonicalPath: projectRoot, projectName: "project" },
            source,
            "matching",
          );
          const blocked = evidenceFor(
            "cursor",
            { _tag: "project-root", canonicalPath: projectRoot, projectName: "project" },
            source,
            "blocked",
          );
          const matchingDestination = yield* setupLink(matching);
          const blockedDestination = managedLinkDestinationPath(blocked);
          yield* fileSystem.makeDirectory(path.dirname(blockedDestination), { recursive: true });
          yield* fileSystem.writeFileString(blockedDestination, "foreign");
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              choices: [
                {
                  address: matching.address,
                  decision: "include" as const,
                  namespace: { _tag: "project" as const, projectName: "project" },
                },
              ],
              enabledAdapters: ["codex", "cursor"],
              managedLinks: [matching, blocked],
              projects: [
                {
                  gitCommonDirectory: path.join(projectRoot, ".git"),
                  name: "project",
                  roots: [projectRoot],
                },
              ],
              sources: [
                {
                  canonicalPath: source,
                  id: matching.sourceRegistrationId,
                },
              ],
            },
          }));

          const first = yield* resetTack(options, { apply: true });
          const partial = yield* readState(options);

          expect(first.applied?.actions.map((outcome) => outcome._tag)).toEqual([
            "applied",
            "skipped",
          ]);
          expect(yield* fileSystem.exists(matchingDestination)).toBe(false);
          expect(yield* fileSystem.readFileString(blockedDestination)).toBe("foreign");
          expect(partial).toEqual(
            runtimeFixture({
              version: 1,
              data: {
                pendingRemovals: [
                  {
                    cause: "reset",
                    evidence: blocked,
                    lastResult: {
                      _tag: "blocked",
                      message: "The destination is an existing file.",
                    },
                  },
                ],
              },
            }),
          );

          const unrelatedRetry = yield* retrySelectedPendingRemovals(
            options,
            retryOptions(root, { _tag: "user" }),
          );
          expect(unrelatedRetry.applied?.actions).toEqual([]);
          expect(yield* readState(options)).toEqual(partial);

          const selectedRetry = yield* retrySelectedPendingRemovals(
            options,
            retryOptions(root, { _tag: "project", projectName: "project" }, false),
          );
          expect(selectedRetry.plan.actions.map((action) => action.destinationPath)).toEqual([
            blockedDestination,
          ]);
          const blockedRetry = yield* retrySelectedPendingRemovals(
            options,
            retryOptions(root, { _tag: "project", projectName: "project" }),
          );
          expect(blockedRetry.applied?.actions[0]?._tag).toBe("skipped");
          expect(yield* fileSystem.readFileString(blockedDestination)).toBe("foreign");
          expect(pendingRemovalsOf((yield* readState(options)).data.links)).toHaveLength(1);

          const repeated = yield* resetTack(options, { apply: false });
          expect(repeated.plan.actions.map((action) => action.destinationPath)).toEqual([
            blockedDestination,
          ]);
          expect(yield* fileSystem.exists(statePath)).toBe(true);
          yield* fileSystem.remove(blockedDestination);
          yield* fileSystem.symlink(
            path.relative(path.dirname(blockedDestination), source),
            blockedDestination,
          );

          const settled = yield* retrySelectedPendingRemovals(
            options,
            retryOptions(root, { _tag: "project", projectName: "project" }),
          );

          expect(settled.plan.actions.map((action) => action.destinationPath)).toEqual([
            blockedDestination,
          ]);
          expect(settled.applied?.pending).toEqual([]);
          expect(yield* fileSystem.exists(statePath)).toBe(false);
          expect(yield* fileSystem.exists(blockedDestination)).toBe(false);
        }),
      ),
  );

  resetIt.effect(
    "retries explicit targets and lets --all cover pending removals across projects",
    () =>
      withStateFixture(({ options, root, statePath }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const firstRootPath = path.join(root, "first");
          const secondRootPath = path.join(root, "second");
          const userRootPath = path.join(root, "user");
          const sourcePath = path.join(root, "source");
          yield* fileSystem.makeDirectory(firstRootPath, { recursive: true });
          yield* fileSystem.makeDirectory(secondRootPath, { recursive: true });
          yield* fileSystem.makeDirectory(userRootPath, { recursive: true });
          yield* fileSystem.makeDirectory(sourcePath, { recursive: true });
          const firstRoot = yield* fileSystem.realPath(firstRootPath);
          const secondRoot = yield* fileSystem.realPath(secondRootPath);
          const userRoot = yield* fileSystem.realPath(userRootPath);
          const source = yield* fileSystem.realPath(sourcePath);
          const first = evidenceFor(
            "codex",
            { _tag: "project-root", canonicalPath: firstRoot, projectName: "first" },
            source,
            "first",
          );
          const second = evidenceFor(
            "codex",
            { _tag: "project-root", canonicalPath: secondRoot, projectName: "second" },
            source,
            "second",
          );
          const user = evidenceFor(
            "cursor",
            { _tag: "user", canonicalPath: userRoot },
            source,
            "user",
          );
          const secondDestination = yield* setupLink(second);
          const pending = [first, second, user]
            .map((evidence) => ({
              cause: "clean" as const,
              evidence,
            }))
            .sort((left, right) =>
              managedLinkDestinationPath(left.evidence) < managedLinkDestinationPath(right.evidence)
                ? -1
                : managedLinkDestinationPath(left.evidence) >
                    managedLinkDestinationPath(right.evidence)
                  ? 1
                  : 0,
            );
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              pendingRemovals: pending,
              projects: [
                {
                  gitCommonDirectory: path.join(firstRoot, ".git"),
                  name: "first",
                  roots: [firstRoot],
                },
                {
                  gitCommonDirectory: path.join(secondRoot, ".git"),
                  name: "second",
                  roots: [secondRoot],
                },
              ],
            },
          }));

          const before = yield* fileSystem.readFileString(statePath);
          const dry = yield* retrySelectedPendingRemovals(
            options,
            retryOptions(root, { _tag: "project", projectName: "first" }, false),
          );
          expect(dry.plan.actions.map((action) => action.evidence)).toEqual([first]);
          const bare = yield* retrySelectedPendingRemovals(
            options,
            retryOptions(firstRoot, { _tag: "bare" }, false),
          );
          const { selection: bareSelection, ...barePlan } = bare.plan;
          expect(bareSelection.containingRoot).toEqual({ projectName: "first", root: firstRoot });
          // The plan round-trips as a removal plan; its selection echo is presentation only.
          const { selection, ...removalPlan } = dry.plan;
          expect(barePlan).toEqual(removalPlan);
          expect(selection.selector).toEqual({ _tag: "project", projectName: "first" });
          expect(Schema.decodeUnknownSync(RemovalPlanSchema)(dry.plan)).toEqual(removalPlan);
          expect(() =>
            Schema.decodeUnknownSync(RemovalPlanSchema)({ ...dry.plan, cause: "reset" }),
          ).toThrow();
          expect(yield* fileSystem.readFileString(statePath)).toBe(before);

          yield* retrySelectedPendingRemovals(
            options,
            retryOptions(root, { _tag: "project", projectName: "first" }),
          );
          expect(
            pendingRemovalsOf((yield* readState(options)).data.links).map((item) => item.evidence),
          ).toEqual([second, user]);
          yield* retrySelectedPendingRemovals(options, retryOptions(root, { _tag: "user" }));
          expect(
            pendingRemovalsOf((yield* readState(options)).data.links).map((item) => item.evidence),
          ).toEqual([second]);

          const broad = yield* retrySelectedPendingRemovals(
            options,
            retryOptions(firstRoot, { _tag: "all" }),
          );
          expect(broad.plan.actions.map((action) => action.evidence)).toEqual([second]);
          expect(pendingRemovalsOf((yield* readState(options)).data.links)).toEqual([]);
          expect(yield* fileSystem.exists(secondDestination)).toBe(false);
        }),
      ),
  );

  resetIt.effect("finalizes only the selected removing project after its retry settles", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const firstRootPath = path.join(root, "first-removing");
        const secondRootPath = path.join(root, "second-removing");
        const sourcePath = path.join(root, "source");
        yield* fileSystem.makeDirectory(firstRootPath, { recursive: true });
        yield* fileSystem.makeDirectory(secondRootPath, { recursive: true });
        yield* fileSystem.makeDirectory(sourcePath, { recursive: true });
        const firstRoot = yield* fileSystem.realPath(firstRootPath);
        const secondRoot = yield* fileSystem.realPath(secondRootPath);
        const evidence = evidenceFor(
          "codex",
          { _tag: "project-root", canonicalPath: firstRoot, projectName: "first" },
          yield* fileSystem.realPath(sourcePath),
          "alpha",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            choices: [
              {
                address: evidence.address,
                decision: "include" as const,
                namespace: { _tag: "project" as const, projectName: "first" },
              },
              {
                address: evidence.address,
                decision: "include" as const,
                namespace: { _tag: "project" as const, projectName: "second" },
              },
            ],
            pendingRemovals: [
              {
                cause: "project-removal" as const,
                evidence,
              },
            ],
            projects: [
              {
                gitCommonDirectory: path.join(firstRoot, ".git"),
                name: "first",
                removingRoots: [firstRoot],
                roots: [],
              },
              {
                gitCommonDirectory: path.join(secondRoot, ".git"),
                name: "second",
                removingRoots: [secondRoot],
                roots: [],
              },
            ],
          },
        }));

        const execution = yield* retrySelectedPendingRemovals(
          options,
          retryOptions(root, { _tag: "project", projectName: "first" }),
        );
        const settled = yield* readState(options);

        expect(execution.applied?.finalizedProject).toBe(true);
        expect(settled.data.projects?.map((project) => project.name)).toEqual(["second"]);
        expect(allSkillChoices(settled)?.map((choice) => choice.namespace)).toEqual([
          { _tag: "project", projectName: "second" },
        ]);
        expect(pendingRemovalsOf(settled.data.links)).toEqual([]);
      }),
    ),
  );

  resetIt.effect(
    "uses --all retry to finalize every evidence-free removing project on the machine",
    () =>
      withStateFixture(({ options, root }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const activeRootPath = path.join(root, "active");
          const removingRootPath = path.join(root, "removing");
          yield* fileSystem.makeDirectory(activeRootPath, { recursive: true });
          yield* fileSystem.makeDirectory(removingRootPath, { recursive: true });
          const activeRoot = yield* fileSystem.realPath(activeRootPath);
          const removingRoot = yield* fileSystem.realPath(removingRootPath);
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              choices: [
                {
                  address: {
                    kind: "skill" as const,
                    name: "alpha",
                    sourceRegistrationId: fixtureSourceId,
                  },
                  decision: "include" as const,
                  namespace: { _tag: "project" as const, projectName: "active" },
                },
                {
                  address: {
                    kind: "skill" as const,
                    name: "beta",
                    sourceRegistrationId: fixtureSourceId,
                  },
                  decision: "include" as const,
                  namespace: { _tag: "project" as const, projectName: "removing" },
                },
              ],
              projects: [
                {
                  gitCommonDirectory: path.join(activeRoot, ".git"),
                  name: "active",
                  roots: [activeRoot],
                },
                {
                  gitCommonDirectory: path.join(removingRoot, ".git"),
                  name: "removing",
                  removalIntent: "project" as const,
                  removingRoots: [removingRoot],
                  roots: [],
                },
              ],
            },
          }));

          const execution = yield* retrySelectedPendingRemovals(
            options,
            retryOptions(activeRoot, { _tag: "all" }),
          );
          const settled = yield* readState(options);

          expect(execution.plan.scope).toEqual({ _tag: "maintenance" });
          expect(execution.plan.actions).toEqual([]);
          expect(execution.applied?.finalizedProject).toBe(true);
          expect(settled.data.projects?.map((project) => project.name)).toEqual(["active"]);
          expect(allSkillChoices(settled)?.map((choice) => choice.namespace)).toEqual([
            { _tag: "project", projectName: "active" },
          ]);
        }),
      ),
  );

  resetIt.effect("holds the writer lock while resolving selected retry targets", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const liveFileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRootPath = path.join(root, "project");
        const sourcePath = path.join(root, "source");
        yield* liveFileSystem.makeDirectory(projectRootPath, { recursive: true });
        yield* liveFileSystem.makeDirectory(sourcePath, { recursive: true });
        const projectRoot = yield* liveFileSystem.realPath(projectRootPath);
        const evidence = evidenceFor(
          "codex",
          { _tag: "project-root", canonicalPath: projectRoot, projectName: "project" },
          yield* liveFileSystem.realPath(sourcePath),
          "alpha",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            pendingRemovals: [
              {
                cause: "clean" as const,
                evidence,
              },
            ],
            projects: [
              {
                gitCommonDirectory: path.join(projectRoot, ".git"),
                name: "project",
                roots: [projectRoot],
              },
            ],
          },
        }));
        const selectionEntered = yield* Deferred.make<void>();
        const continueSelection = yield* Deferred.make<void>();
        const gatedFileSystem = FileSystem.makeNoop({
          ...liveFileSystem,
          realPath: (target) =>
            target === projectRoot
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(selectionEntered, undefined);
                  yield* Deferred.await(continueSelection);
                  return yield* liveFileSystem.realPath(target);
                })
              : liveFileSystem.realPath(target),
        });
        const retryFiber = yield* provideTestFileSystem(
          retrySelectedPendingRemovals(
            options,
            retryOptions(root, { _tag: "project", projectName: "project" }),
          ),
          gatedFileSystem,
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(selectionEntered);
        const concurrentChange = yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, projects: [] },
        })).pipe(
          Effect.map(() => ({ _tag: "changed" as const })),
          Effect.catch((error) => Effect.succeed({ _tag: "blocked" as const, error })),
        );
        yield* Deferred.succeed(continueSelection, undefined);
        yield* Fiber.join(retryFiber);

        expect(concurrentChange._tag).toBe("blocked");
        if (concurrentChange._tag === "blocked") {
          expect(concurrentChange.error).toBeInstanceOf(StateBusyError);
        }
        expect((yield* readState(options)).data.projects?.map((project) => project.name)).toEqual([
          "project",
        ]);
        expect(pendingRemovalsOf((yield* readState(options)).data.links)).toEqual([]);
      }),
    ),
  );

  resetIt.effect("makes final state deletion a terminal uninterruptible transition", () =>
    withStateFixture(({ options, root, statePath }) =>
      Effect.gen(function* () {
        const liveFileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const targetPath = path.join(root, "project");
        const sourcePath = path.join(root, "source");
        yield* liveFileSystem.makeDirectory(targetPath, { recursive: true });
        yield* liveFileSystem.makeDirectory(sourcePath, { recursive: true });
        const evidence = evidenceFor(
          "codex",
          {
            _tag: "project-root",
            canonicalPath: yield* liveFileSystem.realPath(targetPath),
            projectName: "project",
          },
          yield* liveFileSystem.realPath(sourcePath),
          "alpha",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, managedLinks: [evidence] },
        }));
        const deletion = yield* stallAt("remove", statePath);
        const fiber = yield* provideTestFileSystem(
          resetTack(options, { apply: true }),
          deletion.fileSystem,
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(deletion.entered);
        expect((yield* readState(options)).data).toEqual(
          runtimeFixture({
            version: 1,
            data: {
              pendingRemovals: [
                {
                  cause: "reset",
                  evidence,
                },
              ],
            },
          }).data,
        );
        const interruptFiber = yield* Fiber.interrupt(fiber).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        expect(yield* liveFileSystem.exists(statePath)).toBe(true);
        yield* Deferred.succeed(deletion.release, undefined);
        yield* Fiber.join(interruptFiber);
        const exit = yield* Fiber.await(fiber);

        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(yield* liveFileSystem.exists(statePath)).toBe(false);
        expect(yield* liveFileSystem.exists(path.join(path.dirname(statePath), "state.lock"))).toBe(
          false,
        );
      }),
    ),
  );

  resetIt.effect("retains the final obligation when terminal state deletion fails", () =>
    withStateFixture(({ options, root, statePath }) =>
      Effect.gen(function* () {
        const liveFileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const targetPath = path.join(root, "project");
        const sourcePath = path.join(root, "source");
        yield* liveFileSystem.makeDirectory(targetPath, { recursive: true });
        yield* liveFileSystem.makeDirectory(sourcePath, { recursive: true });
        const evidence = evidenceFor(
          "codex",
          {
            _tag: "project-root",
            canonicalPath: yield* liveFileSystem.realPath(targetPath),
            projectName: "project",
          },
          yield* liveFileSystem.realPath(sourcePath),
          "alpha",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            enabledAdapters: ["codex"],
            managedLinks: [evidence],
          },
        }));
        const failingFileSystem = FileSystem.makeNoop({
          ...liveFileSystem,
          remove: (target, removeOptions) =>
            target === statePath
              ? Effect.fail(PlatformError.badArgument({ method: "remove", module: "reset-test" }))
              : liveFileSystem.remove(target, removeOptions),
        });

        const error = yield* Effect.flip(
          provideTestFileSystem(resetTack(options, { apply: true }), failingFileSystem),
        );
        const recovery = yield* readState(options);

        expect(error).toBeInstanceOf(StateStorageError);
        expect(recovery).toEqual(
          runtimeFixture({
            version: 1,
            data: {
              pendingRemovals: [
                {
                  cause: "reset",
                  evidence,
                },
              ],
            },
          }),
        );

        yield* resetTack(options, { apply: true });
        expect(yield* liveFileSystem.exists(statePath)).toBe(false);
      }),
    ),
  );

  resetIt.effect(
    "keeps a blocked docs removal as an obligation when reset meets a replaced owned link",
    () =>
      withDocsWorld(({ options, sourceId }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* attachDocs(
            options,
            { projectName: "demo" },
            docsRequest({
              sourceRegistrationId: sourceId,

              name: "handbook",
            }),
          );
          yield* syncDocsReport(options, { projectName: "demo", apply: true });
          const evidence = docsEvidence(yield* readState(options))[0];
          if (evidence === undefined) return yield* Effect.die("Expected docs evidence");
          yield* fs.remove(evidence.destinationPath);
          yield* fs.makeDirectory(evidence.destinationPath);
          const preview = yield* resetTack(options, { apply: false });
          expect(preview.plan.docsActions).toHaveLength(2);
          const reset = yield* resetTack(options, { apply: true });
          // The other mount is removed; the replaced one stays on disk, owed, with the reason.
          expect(reset.applied?.docsActions?.map((outcome) => outcome._tag).toSorted()).toEqual([
            "applied",
            "blocked",
          ]);
          expect(reset.applied?.docsPending).toMatchObject([
            {
              evidence: { destinationPath: evidence.destinationPath },
              lastResult: { _tag: "blocked", message: "The destination is an existing directory." },
            },
          ]);
          const left = yield* readState(options);
          expect(docsPendingRemovalsOf(left.data.links)).toHaveLength(1);
          expect(left.data.projects).toEqual([]);
          expect((yield* fs.stat(evidence.destinationPath)).type).toBe("Directory");

          // Once the destination is cleared, retrying settles the obligation and the state ends.
          yield* fs.remove(evidence.destinationPath, { recursive: true });
          const retried = yield* retryPendingRemovals(options, { apply: true });
          expect(retried.applied?.docsActions?.map((outcome) => outcome._tag)).toEqual(["applied"]);
          expect(retried.applied?.docsPending).toBeUndefined();
          expect(docsPendingRemovalsOf((yield* readState(options)).data.links)).toEqual([]);
          return undefined;
        }),
      ),
  );

  resetIt.effect("reports the exact docs removals performed by reset", () =>
    withDocsWorld(({ options, sourceId }) =>
      Effect.gen(function* () {
        yield* attachDocs(
          options,
          { projectName: "demo" },
          docsRequest({
            sourceRegistrationId: sourceId,

            name: "handbook",
          }),
        );
        yield* syncDocsReport(options, { projectName: "demo", apply: true });
        const evidence = docsEvidence(yield* readState(options));
        const result = yield* resetTack(options, { apply: true });
        expect(result.applied).toMatchObject({
          docsActions: evidence?.map((entry) => ({
            _tag: "applied",
            action: { action: "remove", evidence: entry },
          })),
        });
      }),
    ),
  );

  // C1 regression: clean recovered only the agent journal before planning, so the docs
  // evidence it planned was stale once removal recovered the docs journal.
  resetIt.effect.each([
    {
      entry: "reset",
      run: (options: StateOptions, _cwd: string) => resetTack(options, { apply: true }),
      // A reset that settles every mount ends the state.
      settled: (options: StateOptions) =>
        Effect.flip(readState(options)).pipe(
          Effect.map((error) => expect(error).toMatchObject({ _tag: "StateNotInitializedError" })),
        ),
    },
    {
      entry: "clean",
      run: (options: StateOptions, cwd: string) =>
        cleanManagedLinks(options, {
          apply: true,
          cwd,
          selector: { _tag: "project", projectName: "demo" },
        }),
      settled: (options: StateOptions) =>
        readState(options).pipe(
          Effect.map((state) => {
            expect(docsJournal(state)).toBeUndefined();
            expect(docsEvidence(state)).toEqual([]);
          }),
        ),
    },
  ])(
    "$entry removes every docs mount on the first apply while a docs create is pending recovery",
    ({ run, settled }) =>
      withDocsWorld(({ options, sourceId, root }) =>
        Effect.gen(function* () {
          yield* attachDocs(
            options,
            { projectName: "demo" },
            docsRequest({ sourceRegistrationId: sourceId, name: "handbook" }),
          );
          yield* syncDocsReport(options, { projectName: "demo", apply: true });
          const evidence = docsEvidence(yield* readState(options))[0];
          if (evidence === undefined) return yield* Effect.die("Expected docs evidence");
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              links: replaceDocsLinks(
                state,
                docsEvidence(state).filter(
                  (entry) => entry.destinationPath !== evidence.destinationPath,
                ),
              ),
              journal: [{ _tag: "create", link: docsLink(evidence) }],
            },
          }));
          const execution = yield* run(options, root);
          expect(execution.plan.docsActions).toHaveLength(2);
          expect(execution.plan.docsActions?.map((action) => action.evidence)).toContainEqual(
            reportDocsManagedLink(evidence),
          );
          expect(execution.applied?.docsActions?.map((outcome) => outcome.action.action)).toEqual([
            "remove",
            "remove",
          ]);
          expect(execution.applied?.docsActions).toContainEqual({
            _tag: "applied",
            action: { action: "remove", evidence: reportDocsManagedLink(evidence) },
          });
          yield* settled(options);
          return undefined;
        }),
      ),
  );
});
