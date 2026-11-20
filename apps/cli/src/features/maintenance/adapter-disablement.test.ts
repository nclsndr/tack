import { managedLinksOf, pendingRemovalsOf } from "../../domain/links/link-record-schema.ts";
import { allSkillChoices } from "../../domain/state/state-intent.ts";
import {
  mutateStateFixture,
  projectRecords,
  withStateFixture,
  evidenceFor,
  setupLink,
  fixtureSourceId,
} from "../../../test/support/state-fixture.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Fiber, Path, Schema } from "effect";

import {
  AdapterDisablementPlanSchema,
  AdapterDisablementResultSchema,
  disableAdapter,
} from "./adapter-disablement.ts";
import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import { readState, StateBusyError } from "../../services/state-store.ts";

const project = (activeRoot: string, removingRoot?: string) => ({
  gitCommonDirectory: `${activeRoot}/.git`,
  name: "project",
  ...(removingRoot === undefined ? {} : { removingRoots: [removingRoot] }),
  roots: [activeRoot],
});

it.layer(LiveTestLayer)("adapter disablement", (adapterIt) => {
  adapterIt.effect(
    "plans deterministically and removes only one adapter across every managed target",
    () =>
      withStateFixture(({ options, root }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const activeRootPath = path.join(root, "active");
          const removingRootPath = path.join(root, "removing");
          const userRootPath = path.join(root, "user");
          yield* fileSystem.makeDirectory(activeRootPath, { recursive: true });
          yield* fileSystem.makeDirectory(removingRootPath, { recursive: true });
          yield* fileSystem.makeDirectory(userRootPath, { recursive: true });
          const activeRoot = yield* fileSystem.realPath(activeRootPath);
          const removingRoot = yield* fileSystem.realPath(removingRootPath);
          const userRoot = yield* fileSystem.realPath(userRootPath);
          const cursorUserSourcePath = path.join(root, "source-user");
          const cursorActiveSourcePath = path.join(root, "source-active");
          const cursorRemovingSourcePath = path.join(root, "source-removing");
          const codexSourcePath = path.join(root, "source-codex");
          yield* fileSystem.makeDirectory(cursorUserSourcePath, { recursive: true });
          yield* fileSystem.makeDirectory(cursorActiveSourcePath, { recursive: true });
          yield* fileSystem.makeDirectory(cursorRemovingSourcePath, { recursive: true });
          yield* fileSystem.makeDirectory(codexSourcePath, { recursive: true });
          const cursorUser = evidenceFor(
            "cursor",
            { _tag: "user", canonicalPath: userRoot },
            yield* fileSystem.realPath(cursorUserSourcePath),
            "alpha",
          );
          const cursorActive = evidenceFor(
            "cursor",
            { _tag: "project-root", canonicalPath: activeRoot, projectName: "project" },
            yield* fileSystem.realPath(cursorActiveSourcePath),
            "beta",
          );
          const cursorRemoving = evidenceFor(
            "cursor",
            { _tag: "project-root", canonicalPath: removingRoot, projectName: "project" },
            yield* fileSystem.realPath(cursorRemovingSourcePath),
            "gamma",
          );
          const codexActive = evidenceFor(
            "codex",
            { _tag: "project-root", canonicalPath: activeRoot, projectName: "project" },
            yield* fileSystem.realPath(codexSourcePath),
            "beta",
          );
          const cursorUserDestination = yield* setupLink(cursorUser);
          const cursorActiveDestination = yield* setupLink(cursorActive);
          const codexDestination = yield* setupLink(codexActive);
          const blockedCursorDestination = managedLinkDestinationPath(cursorRemoving);
          yield* fileSystem.makeDirectory(path.dirname(blockedCursorDestination), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(blockedCursorDestination, "foreign");
          const choices = [
            {
              address: {
                kind: "skill" as const,
                name: "beta",
                sourceRegistrationId: fixtureSourceId,
              },
              decision: "include" as const,
              namespace: { _tag: "project" as const, projectName: "project" },
            },
          ];
          const projects = [project(activeRoot, removingRoot)];
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              choices,
              enabledAdapters: ["codex", "cursor"],
              managedLinks: [codexActive, cursorActive, cursorRemoving, cursorUser],
              projects,
            },
          }));

          const before = yield* readState(options);
          const preview = yield* disableAdapter(options, "cursor", { apply: false });
          expect(preview.applied).toBeUndefined();
          const dryRun = preview.plan;
          expect(yield* readState(options)).toEqual(before);
          expect(dryRun).toMatchObject({
            adapter: "cursor",
            enabledAdapters: ["codex"],
            expectedEnabledAdapters: ["codex", "cursor"],
            kind: "adapter-disablement-plan",
            removal: { cause: "adapter-disable", scope: { _tag: "adapter", adapter: "cursor" } },
            version: 1,
          });
          expect(dryRun.removal.actions).toHaveLength(3);
          expect(dryRun.removal.actions.map((action) => action.destinationPath)).toEqual(
            [...dryRun.removal.actions]
              .map((action) => action.destinationPath)
              .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
          );
          expect(Schema.decodeUnknownSync(AdapterDisablementPlanSchema)(dryRun)).toEqual(dryRun);
          expect(() =>
            Schema.decodeUnknownSync(AdapterDisablementPlanSchema, {
              onExcessProperty: "error",
            })({ ...dryRun, unexpected: true }),
          ).toThrow();

          const execution = yield* disableAdapter(options, "cursor", { apply: true });
          expect(execution.plan).toEqual(dryRun);
          expect(execution.applied).toMatchObject({
            adapter: "cursor",
            enabledAdapters: ["codex"],
            kind: "adapter-disablement-application",
            version: 1,
          });
          expect(
            Schema.decodeUnknownSync(AdapterDisablementResultSchema)(execution.applied),
          ).toEqual(execution.applied);
          const after = yield* readState(options);
          expect(after.data.enabledAdapters).toEqual(["codex"]);
          expect(projectRecords(after)).toEqual(projects);
          expect(allSkillChoices(after)).toEqual(choices);
          expect(managedLinksOf(after.data.links)).toEqual([codexActive, cursorRemoving]);
          expect(pendingRemovalsOf(after.data.links)).toEqual([
            {
              cause: "root-removal",
              evidence: cursorRemoving,
              lastResult: {
                _tag: "blocked",
                message: "The destination is an existing file.",
              },
            },
          ]);
          expect(yield* fileSystem.exists(cursorUserDestination)).toBe(false);
          expect(yield* fileSystem.exists(cursorActiveDestination)).toBe(false);
          expect(yield* fileSystem.readFileString(blockedCursorDestination)).toBe("foreign");
          expect(yield* fileSystem.readLink(codexDestination)).toBe(
            path.relative(path.dirname(codexDestination), codexActive.sourceDirectoryPath),
          );
          expect(yield* fileSystem.exists(path.dirname(cursorUserDestination))).toBe(true);
          expect(yield* fileSystem.exists(path.dirname(cursorActiveDestination))).toBe(true);
          expect(yield* fileSystem.exists(path.dirname(codexDestination))).toBe(true);
        }),
      ),
  );

  adapterIt.effect("disables an adapter whose command and skill links share one target", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRootPath = path.join(root, "project");
        yield* fileSystem.makeDirectory(projectRootPath, { recursive: true });
        const projectRoot = yield* fileSystem.realPath(projectRootPath);
        const sourceRoot = yield* fileSystem.realPath(root);
        const target = {
          _tag: "project-root" as const,
          canonicalPath: projectRoot,
          projectName: "project",
        };
        // The command sorts after the skill by name but before it by resource kind.
        const command = evidenceFor(
          "cursor",
          target,
          path.join(sourceRoot, "source", "commands", "review.md"),
          "review",
          "command",
        );
        const skill = evidenceFor(
          "cursor",
          target,
          path.join(sourceRoot, "source", "skills", "alpha"),
          "alpha",
        );
        const commandDestination = yield* setupLink(command);
        const skillDestination = yield* setupLink(skill);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            enabledAdapters: ["cursor"],
            managedLinks: [command, skill],
            projects: [project(projectRoot)],
          },
        }));

        const dryRun = yield* disableAdapter(options, "cursor", { apply: false });
        expect(dryRun.plan.removal.expectedManagedLinks).toEqual([command, skill]);
        expect(dryRun.plan.removal.actions.map((action) => action.destinationPath)).toEqual([
          commandDestination,
          skillDestination,
        ]);
        expect(Schema.decodeUnknownSync(AdapterDisablementPlanSchema)(dryRun.plan)).toEqual(
          dryRun.plan,
        );

        const execution = yield* disableAdapter(options, "cursor", { apply: true });

        expect(execution.plan).toEqual(dryRun.plan);
        expect(execution.applied?.removal.actions.map((outcome) => outcome._tag)).toEqual([
          "applied",
          "applied",
        ]);
        const after = yield* readState(options);
        expect(after.data.enabledAdapters ?? []).toEqual([]);
        expect(managedLinksOf(after.data.links)).toEqual([]);
        expect(yield* fileSystem.exists(commandDestination)).toBe(false);
        expect(yield* fileSystem.exists(skillDestination)).toBe(false);
      }),
    ),
  );

  adapterIt.effect("keeps an already-disabled adapter retryable and idempotent", () =>
    withStateFixture(({ options, root, statePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userRootPath = path.join(root, "user");
        const sourcePath = path.join(root, "source");
        yield* fileSystem.makeDirectory(userRootPath, { recursive: true });
        yield* fileSystem.makeDirectory(sourcePath, { recursive: true });
        const userRoot = yield* fileSystem.realPath(userRootPath);
        const source = yield* fileSystem.realPath(sourcePath);
        const evidence = evidenceFor(
          "cursor",
          { _tag: "user", canonicalPath: userRoot },
          source,
          "alpha",
        );
        const destinationPath = managedLinkDestinationPath(evidence);
        yield* fileSystem.makeDirectory(path.dirname(destinationPath), { recursive: true });
        yield* fileSystem.writeFileString(destinationPath, "foreign");
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            enabledAdapters: ["codex"],
            managedLinks: [evidence],
            pendingRemovals: [{ cause: "adapter-disable" as const, evidence }],
          },
        }));

        const first = yield* disableAdapter(options, "cursor", { apply: true });
        expect(first.plan.expectedEnabledAdapters).toEqual(["codex"]);
        expect(first.plan.enabledAdapters).toEqual(["codex"]);
        expect(first.applied?.removal.actions[0]?._tag).toBe("skipped");
        yield* fileSystem.remove(destinationPath);
        yield* fileSystem.symlink(
          path.relative(path.dirname(destinationPath), source),
          destinationPath,
        );

        const retry = yield* disableAdapter(options, "cursor", { apply: true });
        expect(retry.applied?.removal.actions[0]?._tag).toBe("applied");
        const settled = yield* readState(options);
        expect(settled.data.enabledAdapters).toEqual(["codex"]);
        expect(managedLinksOf(settled.data.links)).toEqual([]);
        expect(pendingRemovalsOf(settled.data.links)).toEqual([]);
        expect(yield* fileSystem.exists(destinationPath)).toBe(false);
        const beforeNoop = yield* fileSystem.readFileString(statePath);
        const repeated = yield* disableAdapter(options, "cursor", { apply: true });
        expect(repeated.applied?.removal.actions).toEqual([]);
        expect(yield* fileSystem.readFileString(statePath)).toBe(beforeNoop);
      }),
    ),
  );

  adapterIt.effect("holds the writer lock while planning machine-wide disablement", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userRootPath = path.join(root, "user");
        const sourcePath = path.join(root, "source");
        yield* fileSystem.makeDirectory(userRootPath, { recursive: true });
        yield* fileSystem.makeDirectory(sourcePath, { recursive: true });
        const evidence = evidenceFor(
          "cursor",
          { _tag: "user", canonicalPath: yield* fileSystem.realPath(userRootPath) },
          yield* fileSystem.realPath(sourcePath),
          "alpha",
        );
        const destinationPath = yield* setupLink(evidence);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, enabledAdapters: ["cursor"], managedLinks: [evidence] },
        }));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let gated = false;
        const gatedFileSystem = FileSystem.makeNoop({
          ...fileSystem,
          readLink: (candidate) =>
            candidate === destinationPath && gated === false
              ? Effect.gen(function* () {
                  gated = true;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return yield* fileSystem.readLink(candidate);
                })
              : fileSystem.readLink(candidate),
        });
        const fiber = yield* provideTestFileSystem(
          disableAdapter(options, "cursor", { apply: true }),
          gatedFileSystem,
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(entered);
        const busy = yield* Effect.flip(mutateStateFixture(options, (state) => state));
        expect(busy).toBeInstanceOf(StateBusyError);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        expect((yield* readState(options)).data.enabledAdapters ?? []).toEqual([]);
        expect(yield* fileSystem.exists(destinationPath)).toBe(false);
      }),
    ),
  );

  adapterIt.effect("rejects an invalid adapter at the domain boundary", () =>
    withStateFixture(({ options }) =>
      Effect.gen(function* () {
        const invalidAdapter = yield* Effect.flip(
          disableAdapter(options, "windsurf", { apply: false }),
        );

        expect(invalidAdapter._tag).toBe("AdapterDisablementValidationError");
      }),
    ),
  );
});
