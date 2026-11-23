import { stallAt } from "../../../test/support/faults.ts";
import {
  LinkRecordsSchema,
  managedLinksOf,
  pendingRemovalsOf,
} from "../../domain/links/link-record-schema.ts";
import { allDocsSettings, allSkillChoices } from "../../domain/state/state-intent.ts";
import {
  expectWriterGuarded,
  mutateStateFixture,
  projectRecords,
  runtimeFixture,
  withStateFixture,
  evidenceFor,
  setupLink,
  fixtureSourceId,
  targetProject,
} from "../../../test/support/state-fixture.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Fiber, Path, PlatformError, Schema } from "effect";
import { PendingRemovalSchema } from "../../domain/links/pending-removal-schema.ts";
import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import type { RemovalScope } from "../../domain/reconciliation/removal-schema.ts";
import { ProjectRecordSchema } from "../../domain/projects/project-schema.ts";
import {
  planRemovalAt,
  removeProject,
  removeProjectRoot,
  retryPendingRemovals,
} from "../../../test/support/removal.ts";
import { readState } from "../../services/state-store.ts";
import { StateSchema } from "../../domain/state/state-schema.ts";
import { docsPendingRemovalsOf, reportDocsManagedLink } from "../../domain/docs/docs-schema.ts";
import { attachDocs } from "../docs/docs.ts";
import { linksCheck } from "../doctor/doctor-observations.ts";
import { resetTack, retrySelectedPendingRemovals } from "../maintenance/selected-removal.ts";
import { runStatus } from "../status/status.ts";
import {
  docsEvidence,
  docsRequest,
  syncDocsReport,
  withDocsWorld,
  type DocsWorld,
} from "../../../test/support/docs-world.ts";

const project = (root: string) => ({
  gitCommonDirectory: `${root}/.git`,
  name: "project",
  roots: [root],
});

const rootScope = (root: string): RemovalScope => ({
  _tag: "project-root",
  canonicalRoot: root,
  projectName: "project",
});

it.layer(LiveTestLayer)("removal lifecycle", (removalIt) => {
  removalIt.effect(
    "validates derived destinations, ordering, duplicates, and evidence agreement",
    () =>
      Effect.gen(function* () {
        yield* Effect.void;
        const evidence = evidenceFor(
          "codex",
          targetProject("project", "/repo/root"),
          "/repo/source",
          "alpha",
        );
        const pending = { cause: "root-removal" as const, evidence };
        expect(Schema.decodeUnknownSync(PendingRemovalSchema)(pending)).toEqual(pending);
        expect(
          managedLinkDestinationPath(
            evidenceFor("codex", targetProject("project", "C:\\repo"), "C:\\source", "alpha"),
          ),
        ).toBe("C:\\repo\\.agents\\skills\\alpha");
        expect(
          managedLinkDestinationPath(
            evidenceFor("codex", targetProject("project", "C:\\"), "C:\\source", "alpha"),
          ),
        ).toBe("C:\\.agents\\skills\\alpha");
        expect(
          managedLinkDestinationPath(
            evidenceFor("codex", targetProject("project", "C:/repo"), "C:/source", "alpha"),
          ),
        ).toBe("C:\\repo\\.agents\\skills\\alpha");
        expect(
          managedLinkDestinationPath(
            evidenceFor("codex", targetProject("project", "C:\\repo/mixed"), "C:/source", "alpha"),
          ),
        ).toBe("C:\\repo\\mixed\\.agents\\skills\\alpha");
        expect(
          managedLinkDestinationPath(
            evidenceFor(
              "codex",
              targetProject("project", "\\\\server\\share"),
              "\\\\server\\source",
              "alpha",
            ),
          ),
        ).toBe("\\\\server\\share\\.agents\\skills\\alpha");
        expect(
          managedLinkDestinationPath(
            evidenceFor("codex", targetProject("project", "/repo\\name"), "/source", "alpha"),
          ),
        ).toBe("/repo\\name/.agents/skills/alpha");
        expect(() =>
          Schema.decodeUnknownSync(PendingRemovalSchema, { onExcessProperty: "error" })({
            ...pending,
            destinationPath: "/repo/.agents/skills/wrong",
          }),
        ).toThrow();
        const record = { evidence, removal: { cause: pending.cause } };
        expect(() => Schema.decodeUnknownSync(LinkRecordsSchema)([record, record])).toThrow();
        expect(() =>
          Schema.decodeUnknownSync(StateSchema)(
            runtimeFixture({
              version: 1,
              data: {
                managedLinks: [evidence],
                pendingRemovals: [
                  { ...pending, evidence: { ...evidence, sourceDirectoryPath: "/repo/other" } },
                ],
              },
            }),
          ),
        ).toThrow();
      }),
  );

  removalIt.effect("removes a final project only after matching links settle", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const source = path.join(root, "source");
        const projectRoot = path.join(root, "project-root");
        yield* setupLink(
          evidenceFor("codex", targetProject("project", projectRoot), source, "alpha"),
        );
        const canonicalSource = yield* fileSystem.realPath(source);
        const canonicalRoot = yield* fileSystem.realPath(projectRoot);
        const evidence = evidenceFor(
          "codex",
          targetProject("project", canonicalRoot),
          canonicalSource,
          "alpha",
        );
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
                namespace: { _tag: "project" as const, projectName: "project" },
              },
            ],
            managedLinks: [evidence],
            projects: [project(canonicalRoot)],
          },
        }));

        const plan = yield* planRemovalAt(options, {
          scope: rootScope(canonicalRoot),
          cause: "root-removal",
        });
        expect(plan.actions).toHaveLength(1);
        const execution = yield* removeProjectRoot(options, {
          apply: true,
          canonicalRoot: canonicalRoot,
          projectName: "project",
        });
        const state = yield* readState(options);
        expect(execution.applied?.finalizedProject).toBe(true);
        expect(state.data.projects ?? []).toEqual([]);
        expect(allSkillChoices(state) ?? []).toEqual([]);
        expect(managedLinksOf(state.data.links)).toEqual([]);
        expect(pendingRemovalsOf(state.data.links)).toEqual([]);
      }),
    ),
  );

  removalIt.effect("cleans same-project evidence outside the final registered root", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const registeredRootPath = path.join(root, "registered");
        const orphanRootPath = path.join(root, "orphan");
        const firstSource = path.join(root, "first-source");
        const secondSource = path.join(root, "second-source");
        const firstDestination = yield* setupLink(
          evidenceFor("codex", targetProject("project", registeredRootPath), firstSource, "alpha"),
        );
        const secondDestination = yield* setupLink(
          evidenceFor("codex", targetProject("project", orphanRootPath), secondSource, "beta"),
        );
        const registeredRoot = yield* fileSystem.realPath(registeredRootPath);
        const orphanRoot = yield* fileSystem.realPath(orphanRootPath);
        const firstEvidence = evidenceFor(
          "codex",
          targetProject("project", registeredRoot),
          yield* fileSystem.realPath(firstSource),
          "alpha",
        );
        const secondEvidence = evidenceFor(
          "codex",
          targetProject("project", orphanRoot),
          yield* fileSystem.realPath(secondSource),
          "beta",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            managedLinks: [firstEvidence, secondEvidence],
            projects: [project(registeredRoot)],
          },
        }));

        const execution = yield* removeProjectRoot(options, {
          apply: true,
          canonicalRoot: registeredRoot,
          projectName: "project",
        });
        const state = yield* readState(options);

        expect(execution.plan.actions).toHaveLength(2);
        expect(execution.applied?.finalizedProject).toBe(true);
        expect(state.data.projects ?? []).toEqual([]);
        expect(managedLinksOf(state.data.links)).toEqual([]);
        expect(pendingRemovalsOf(state.data.links)).toEqual([]);
        expect(yield* fileSystem.exists(firstDestination)).toBe(false);
        expect(yield* fileSystem.exists(secondDestination)).toBe(false);
      }),
    ),
  );

  removalIt.effect("maintenance finalization accounts for orphan project evidence", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const handoffRootPath = path.join(root, "handoff");
        const orphanRootPath = path.join(root, "orphan");
        const handoffSource = path.join(root, "handoff-source");
        const orphanSource = path.join(root, "orphan-source");
        yield* setupLink(
          evidenceFor("codex", targetProject("project", handoffRootPath), handoffSource, "alpha"),
        );
        const orphanDestination = yield* setupLink(
          evidenceFor("codex", targetProject("project", orphanRootPath), orphanSource, "beta"),
        );
        const handoffRoot = yield* fileSystem.realPath(handoffRootPath);
        const orphanRoot = yield* fileSystem.realPath(orphanRootPath);
        const handoffEvidence = evidenceFor(
          "codex",
          targetProject("project", handoffRoot),
          yield* fileSystem.realPath(handoffSource),
          "alpha",
        );
        const orphanEvidence = evidenceFor(
          "codex",
          targetProject("project", orphanRoot),
          yield* fileSystem.realPath(orphanSource),
          "beta",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            managedLinks: [handoffEvidence, orphanEvidence],
            projects: [
              {
                ...project(handoffRoot),
                removingRoots: [handoffRoot],
                roots: [],
              },
            ],
          },
        }));

        const execution = yield* retryPendingRemovals(options, { apply: true });
        const state = yield* readState(options);

        expect(execution.applied?.finalizedProject).toBe(true);
        expect(state.data.projects ?? []).toEqual([]);
        expect(managedLinksOf(state.data.links)).toEqual([]);
        expect(yield* fileSystem.exists(orphanDestination)).toBe(false);
      }),
    ),
  );

  removalIt.effect("retains a removing project when unlisted managed evidence is blocked", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const handoffRootPath = path.join(root, "handoff");
        const orphanRootPath = path.join(root, "orphan");
        const orphanSourcePath = path.join(root, "orphan-source");
        yield* fileSystem.makeDirectory(handoffRootPath, { recursive: true });
        yield* fileSystem.makeDirectory(orphanRootPath, { recursive: true });
        yield* fileSystem.makeDirectory(orphanSourcePath, { recursive: true });
        const handoffRoot = yield* fileSystem.realPath(handoffRootPath);
        const orphanRoot = yield* fileSystem.realPath(orphanRootPath);
        const source = yield* fileSystem.realPath(orphanSourcePath);
        const evidence = evidenceFor("codex", targetProject("project", orphanRoot), source, "beta");
        const destination = managedLinkDestinationPath(evidence);
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.writeFileString(destination, "foreign");
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            choices: [
              {
                address: {
                  kind: "skill" as const,
                  name: "beta",
                  sourceRegistrationId: fixtureSourceId,
                },
                decision: "include" as const,
                namespace: { _tag: "project" as const, projectName: "project" },
              },
            ],
            managedLinks: [evidence],
            projects: [
              {
                ...project(handoffRoot),
                removingRoots: [handoffRoot],
                roots: [],
              },
            ],
          },
        }));

        const execution = yield* retryPendingRemovals(options, { apply: true });
        const state = yield* readState(options);
        expect(execution.applied?.actions[0]?._tag).toBe("skipped");
        expect(projectRecords(state)).toEqual([
          {
            ...project(handoffRoot),
            removingRoots: [handoffRoot],
            roots: [],
          },
        ]);
        expect(allSkillChoices(state)).toHaveLength(1);
        expect(managedLinksOf(state.data.links)).toEqual([evidence]);
        expect(pendingRemovalsOf(state.data.links)).toHaveLength(1);
        expect(yield* fileSystem.readFileString(destination)).toBe("foreign");
        expect(yield* fileSystem.exists(path.dirname(destination))).toBe(true);
      }),
    ),
  );

  removalIt.effect("retains a removing project for preexisting unlisted pending evidence", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const handoffRootPath = path.join(root, "handoff");
        const orphanRootPath = path.join(root, "orphan");
        const orphanSourcePath = path.join(root, "orphan-source");
        yield* fileSystem.makeDirectory(handoffRootPath, { recursive: true });
        yield* fileSystem.makeDirectory(orphanRootPath, { recursive: true });
        yield* fileSystem.makeDirectory(orphanSourcePath, { recursive: true });
        const handoffRoot = yield* fileSystem.realPath(handoffRootPath);
        const orphanRoot = yield* fileSystem.realPath(orphanRootPath);
        const source = yield* fileSystem.realPath(orphanSourcePath);
        const evidence = evidenceFor("codex", targetProject("project", orphanRoot), source, "beta");
        const destinationPath = managedLinkDestinationPath(evidence);
        yield* fileSystem.makeDirectory(path.dirname(destinationPath), { recursive: true });
        yield* fileSystem.writeFileString(destinationPath, "foreign");
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            pendingRemovals: [{ cause: "project-removal" as const, evidence }],
            projects: [
              {
                ...project(handoffRoot),
                removingRoots: [handoffRoot],
                roots: [],
              },
            ],
          },
        }));

        const execution = yield* retryPendingRemovals(options, { apply: true });
        const state = yield* readState(options);
        expect(execution.applied?.actions[0]?._tag).toBe("skipped");
        expect(state.data.projects?.[0]).toMatchObject({
          removingRoots: [handoffRoot],
          roots: [],
        });
        expect(pendingRemovalsOf(state.data.links)).toHaveLength(1);
        expect(yield* fileSystem.readFileString(destinationPath)).toBe("foreign");
        expect(yield* fileSystem.exists(path.dirname(destinationPath))).toBe(true);
      }),
    ),
  );

  removalIt.effect("retires an absent link and keeps a non-final root and choices", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const firstRoot = path.join(root, "first");
        const secondRoot = path.join(root, "second");
        const source = path.join(root, "source");
        yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fileSystem) =>
            Effect.all([
              fileSystem.makeDirectory(firstRoot, { recursive: true }),
              fileSystem.makeDirectory(secondRoot, { recursive: true }),
              fileSystem.makeDirectory(source, { recursive: true }),
            ]),
          ),
        );
        const fileSystem = yield* FileSystem.FileSystem;
        const canonicalFirstRoot = yield* fileSystem.realPath(firstRoot);
        const canonicalSecondRoot = yield* fileSystem.realPath(secondRoot);
        const canonicalSource = yield* fileSystem.realPath(source);
        const evidence = evidenceFor(
          "codex",
          targetProject("project", canonicalFirstRoot),
          canonicalSource,
          "alpha",
        );
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
                namespace: { _tag: "project" as const, projectName: "project" },
              },
            ],
            managedLinks: [evidence],
            projects: [
              { ...project(canonicalFirstRoot), roots: [canonicalFirstRoot, canonicalSecondRoot] },
            ],
          },
        }));

        const execution = yield* removeProjectRoot(options, {
          apply: true,
          canonicalRoot: canonicalFirstRoot,
          projectName: "project",
        });
        const state = yield* readState(options);
        expect(execution.applied?.finalizedProject).toBe(false);
        expect(projectRecords(state)).toEqual([
          {
            gitCommonDirectory: `${canonicalFirstRoot}/.git`,
            name: "project",
            roots: [canonicalSecondRoot],
          },
        ]);
        expect(allSkillChoices(state)).toHaveLength(1);
        expect(managedLinksOf(state.data.links)).toEqual([]);
      }),
    ),
  );

  removalIt.effect.each(["file", "directory", "absolute", "dangling"] as const)(
    "preserves %s destinations as pending obligations",
    (kind) =>
      withStateFixture(({ options, root }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const projectRoot = path.join(root, `project-${kind}`);
          const source = path.join(root, "source");
          yield* fileSystem.makeDirectory(projectRoot, { recursive: true });
          yield* fileSystem.makeDirectory(source, { recursive: true });
          const destination = path.join(projectRoot, ".agents", "skills", "alpha");
          yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
          if (kind === "file") yield* fileSystem.writeFileString(destination, "operator");
          if (kind === "directory") yield* fileSystem.makeDirectory(destination);
          if (kind === "absolute") yield* fileSystem.symlink(source, destination);
          if (kind === "dangling") yield* fileSystem.symlink("../../missing", destination);
          const canonicalRoot = yield* fileSystem.realPath(projectRoot);
          const canonicalSource = yield* fileSystem.realPath(source);
          const evidence = evidenceFor(
            "codex",
            targetProject("project", canonicalRoot),
            canonicalSource,
            "alpha",
          );
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: { ...state.data, managedLinks: [evidence], projects: [project(canonicalRoot)] },
          }));

          const execution = yield* removeProjectRoot(options, {
            apply: true,
            canonicalRoot,
            projectName: "project",
          });
          const state = yield* readState(options);
          expect(execution.applied?.actions[0]?._tag).toBe("skipped");
          expect(state.data.projects?.[0]).toMatchObject({
            removalIntent: "project",
            roots: [],
          });
          expect(pendingRemovalsOf(state.data.links)).toHaveLength(1);
          expect(managedLinksOf(state.data.links)).toEqual([evidence]);
        }),
      ),
  );

  removalIt.effect("re-proves ownership after recovery intent is checkpointed", () =>
    withStateFixture(({ options, root, statePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRootPath = path.join(root, "project-root");
        const sourcePath = path.join(root, "source");
        const destinationPath = yield* setupLink(
          evidenceFor("codex", targetProject("project", projectRootPath), sourcePath, "alpha"),
        );
        const canonicalRoot = yield* fileSystem.realPath(projectRootPath);
        const evidence = evidenceFor(
          "codex",
          targetProject("project", canonicalRoot),
          yield* fileSystem.realPath(sourcePath),
          "alpha",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, managedLinks: [evidence], projects: [project(canonicalRoot)] },
        }));
        let stateRenames = 0;
        const racingFileSystem = FileSystem.makeNoop({
          ...fileSystem,
          rename: (fromPath, toPath) =>
            fileSystem.rename(fromPath, toPath).pipe(
              Effect.tap(() => {
                if (toPath !== statePath) return Effect.void;
                stateRenames += 1;
                return stateRenames === 1
                  ? Effect.gen(function* () {
                      yield* fileSystem.remove(destinationPath);
                      yield* fileSystem.writeFileString(destinationPath, "foreign");
                    })
                  : Effect.void;
              }),
            ),
        });

        const execution = yield* provideTestFileSystem(
          removeProjectRoot(options, {
            apply: true,
            canonicalRoot,
            projectName: "project",
          }),
          racingFileSystem,
        );
        const state = yield* readState(options);

        // The prepare write and the settle write: the race lands between them.
        expect(stateRenames).toBe(2);
        expect(execution.applied?.actions[0]?.["_tag"]).toBe("skipped");
        expect(yield* fileSystem.readFileString(destinationPath)).toBe("foreign");
        expect(managedLinksOf(state.data.links)).toEqual([evidence]);
        expect(pendingRemovalsOf(state.data.links)[0]).toMatchObject({
          cause: "root-removal",
          evidence,
          lastResult: { _tag: "blocked" },
        });
        expect(state.data.journal).toBeUndefined();
      }),
    ),
  );

  removalIt.effect("retains explicit whole-project removal intent while cleanup is blocked", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRootPath = path.join(root, "project-root");
        const sourcePath = path.join(root, "source");
        yield* fileSystem.makeDirectory(projectRootPath, { recursive: true });
        yield* fileSystem.makeDirectory(sourcePath, { recursive: true });
        const canonicalRoot = yield* fileSystem.realPath(projectRootPath);
        const canonicalSource = yield* fileSystem.realPath(sourcePath);
        const evidence = evidenceFor(
          "codex",
          targetProject("project", canonicalRoot),
          canonicalSource,
          "alpha",
        );
        const destinationPath = managedLinkDestinationPath(evidence);
        yield* fileSystem.makeDirectory(path.dirname(destinationPath), { recursive: true });
        yield* fileSystem.writeFileString(destinationPath, "foreign");
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, managedLinks: [evidence], projects: [project(canonicalRoot)] },
        }));

        const execution = yield* removeProject(options, { apply: true, projectName: "project" });
        const blocked = yield* readState(options);

        expect(execution.applied?.actions[0]?._tag).toBe("skipped");
        expect(blocked.data.projects?.[0]).toEqual({
          gitCommonDirectory: `${canonicalRoot}/.git`,
          name: "project",
          removalIntent: "project",
          removingRoots: [canonicalRoot],
          roots: [],
        });
        expect(pendingRemovalsOf(blocked.data.links)[0]?.cause).toBe("project-removal");
        expect(() =>
          Schema.decodeUnknownSync(ProjectRecordSchema)({
            ...project(canonicalRoot),
            removalIntent: "project",
          }),
        ).toThrow();
      }),
    ),
  );

  removalIt.effect("continues independent destinations and retries pending-only evidence", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const projectRoot = path.join(root, "project-root");
        const secondSource = path.join(root, "second-source");
        const firstSource = path.join(root, "first-source");
        const firstDestination = yield* setupLink(
          evidenceFor("codex", targetProject("project", projectRoot), firstSource, "alpha"),
        );
        const secondDestination = path.join(projectRoot, ".agents", "skills", "beta");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(secondSource, { recursive: true });
        yield* fileSystem.writeFileString(secondDestination, "foreign");
        const canonicalRoot = yield* fileSystem.realPath(projectRoot);
        const canonicalFirstSource = yield* fileSystem.realPath(firstSource);
        const canonicalSecondSource = yield* fileSystem.realPath(secondSource);
        const first = evidenceFor(
          "codex",
          targetProject("project", canonicalRoot),
          canonicalFirstSource,
          "alpha",
        );
        const second = evidenceFor(
          "codex",
          targetProject("project", canonicalRoot),
          canonicalSecondSource,
          "beta",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            managedLinks: [first, second],
            projects: [project(canonicalRoot)],
          },
        }));

        const execution = yield* removeProjectRoot(options, {
          apply: true,
          canonicalRoot,
          projectName: "project",
        });
        const state = yield* readState(options);
        expect(execution.applied?.actions).toHaveLength(2);
        expect(
          execution.applied?.actions.find((action) => action.action._tag === "remove"),
        ).toBeDefined();
        expect(managedLinksOf(state.data.links)).toEqual([second]);
        expect(pendingRemovalsOf(state.data.links)).toHaveLength(1);
        const absent = yield* Effect.flip(fileSystem.access(firstDestination));
        expect(absent).toBeDefined();

        const retry = yield* retryPendingRemovals(options, { apply: true });
        expect(retry.applied?.actions[0]?._tag).toBe("skipped");
        const repeated = yield* removeProjectRoot(options, {
          apply: true,
          canonicalRoot,
          projectName: "project",
        });
        const repeatedState = yield* readState(options);
        expect(repeated.applied?.actions[0]?._tag).toBe("skipped");
        expect(repeatedState.data.projects?.[0]?.removingRoots).toEqual([canonicalRoot]);
        expect(pendingRemovalsOf(repeatedState.data.links)).toHaveLength(1);
      }),
    ),
  );

  removalIt.effect(
    "reports a filesystem failure while applying an independent healthy sibling",
    () =>
      withStateFixture(({ options, root }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const projectRootPath = path.join(root, "project");
          const firstSourcePath = path.join(root, "source-alpha");
          const secondSourcePath = path.join(root, "source-beta");
          yield* Effect.forEach([projectRootPath, firstSourcePath, secondSourcePath], (directory) =>
            fileSystem.makeDirectory(directory, { recursive: true }),
          );
          const projectRoot = yield* fileSystem.realPath(projectRootPath);
          const firstSource = yield* fileSystem.realPath(firstSourcePath);
          const secondSource = yield* fileSystem.realPath(secondSourcePath);
          const firstDestination = yield* setupLink(
            evidenceFor("codex", targetProject("project", projectRoot), firstSource, "alpha"),
          );
          const secondDestination = yield* setupLink(
            evidenceFor("codex", targetProject("project", projectRoot), secondSource, "beta"),
          );
          const first = evidenceFor(
            "codex",
            targetProject("project", projectRoot),
            firstSource,
            "alpha",
          );
          const second = evidenceFor(
            "codex",
            targetProject("project", projectRoot),
            secondSource,
            "beta",
          );
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              managedLinks: [first, second],
              projects: [project(projectRoot)],
            },
          }));
          const failingFileSystem = FileSystem.makeNoop({
            ...fileSystem,
            remove: (candidate, removeOptions) =>
              candidate === firstDestination
                ? Effect.fail(PlatformError.badArgument({ module: "test", method: "remove" }))
                : fileSystem.remove(candidate, removeOptions),
          });

          const execution = yield* removeProjectRoot(options, {
            apply: true,
            canonicalRoot: projectRoot,
            projectName: "project",
          }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem));

          expect(execution.applied?.actions).toMatchObject([
            { _tag: "failed", code: "filesystem-failure" },
            { _tag: "applied" },
          ]);
          expect(yield* fileSystem.exists(firstDestination)).toBe(true);
          expect(yield* fileSystem.exists(secondDestination)).toBe(false);
          expect(pendingRemovalsOf((yield* readState(options)).data.links)).toMatchObject([
            { lastResult: { _tag: "filesystem-failure" } },
          ]);
        }),
      ),
  );

  removalIt.effect("recovers a pending-only absent destination", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const projectRoot = path.join(root, "project-root");
        const source = path.join(root, "source");
        yield* (yield* FileSystem.FileSystem).makeDirectory(source, { recursive: true });
        const evidence = evidenceFor(
          "codex",
          targetProject("project", projectRoot),
          source,
          "alpha",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            pendingRemovals: [{ cause: "root-removal" as const, evidence }],
          },
        }));

        const execution = yield* retryPendingRemovals(options, { apply: true });
        expect(execution.applied?.actions[0]?._tag).toBe("applied");
        expect(pendingRemovalsOf((yield* readState(options)).data.links)).toEqual([]);
      }),
    ),
  );

  removalIt.effect("does not write during a dry run", () =>
    withStateFixture(({ options, root, statePath }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const projectRoot = path.join(root, "project-root");
        const source = path.join(root, "source");
        const destination = yield* setupLink(
          evidenceFor("codex", targetProject("project", projectRoot), source, "alpha"),
        );
        const fileSystem = yield* FileSystem.FileSystem;
        const canonicalRoot = yield* fileSystem.realPath(projectRoot);
        const canonicalSource = yield* fileSystem.realPath(source);
        const evidence = evidenceFor(
          "codex",
          targetProject("project", canonicalRoot),
          canonicalSource,
          "alpha",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, managedLinks: [evidence], projects: [project(canonicalRoot)] },
        }));
        const before = yield* fileSystem.readFileString(statePath);
        const execution = yield* removeProjectRoot(options, {
          apply: false,
          canonicalRoot,
          projectName: "project",
        });
        expect(execution.plan.actions.map((action) => action._tag)).toEqual(["remove"]);
        expect(execution.applied).toBeUndefined();
        expect(yield* fileSystem.readFileString(statePath)).toBe(before);
        expect(yield* fileSystem.exists(destination)).toBe(true);
      }),
    ),
  );

  removalIt.effect("removes under the state writer lock", () =>
    withStateFixture(({ options, root, stateDirectory }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRootPath = path.join(root, "project-root");
        const sourcePath = path.join(root, "source");
        const destination = yield* setupLink(
          evidenceFor("codex", targetProject("project", projectRootPath), sourcePath, "alpha"),
        );
        const canonicalRoot = yield* fileSystem.realPath(projectRootPath);
        const evidence = evidenceFor(
          "codex",
          targetProject("project", canonicalRoot),
          yield* fileSystem.realPath(sourcePath),
          "alpha",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, managedLinks: [evidence], projects: [project(canonicalRoot)] },
        }));
        yield* expectWriterGuarded(
          stateDirectory,
          removeProjectRoot(options, { apply: true, canonicalRoot, projectName: "project" }),
        );
        expect(yield* fileSystem.readLink(destination)).toBe(
          path.relative(path.dirname(destination), sourcePath),
        );
      }),
    ),
  );

  removalIt.effect("finalizes a project whose lifecycle is recorded as explicitly active", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRoot = path.join(root, "project-root");
        const source = path.join(root, "source");
        const destination = yield* setupLink(
          evidenceFor("codex", targetProject("project", projectRoot), source, "alpha"),
        );
        const canonicalRoot = yield* fs.realPath(projectRoot);
        const evidence = evidenceFor(
          "codex",
          targetProject("project", canonicalRoot),
          yield* fs.realPath(source),
          "alpha",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, managedLinks: [evidence], projects: [project(canonicalRoot)] },
        }));
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, projects: [project(canonicalRoot)] },
        }));
        const { applied } = yield* removeProjectRoot(options, {
          apply: true,
          canonicalRoot,
          projectName: "project",
        });
        expect(applied?.finalizedProject).toBe(true);
        expect(applied?.actions[0]?._tag).toBe("applied");
        expect(yield* fs.exists(destination)).toBe(false);
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);
      }),
    ),
  );

  removalIt.effect("records an interrupted unlink and converges on a fresh maintenance run", () =>
    withStateFixture(({ options, root, statePath }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const liveFileSystem = yield* FileSystem.FileSystem;
        const projectRootPath = path.join(root, "project-root");
        const sourcePath = path.join(root, "source");
        yield* setupLink(
          evidenceFor("codex", targetProject("project", projectRootPath), sourcePath, "alpha"),
        );
        const canonicalRoot = yield* liveFileSystem.realPath(projectRootPath);
        const canonicalSource = yield* liveFileSystem.realPath(sourcePath);
        const evidence = evidenceFor(
          "codex",
          targetProject("project", canonicalRoot),
          canonicalSource,
          "alpha",
        );
        const canonicalDestination = managedLinkDestinationPath(evidence);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, managedLinks: [evidence], projects: [project(canonicalRoot)] },
        }));
        const stall = yield* stallAt("remove", canonicalDestination, { when: "after" });
        const fiber = yield* removeProjectRoot(options, {
          apply: true,
          canonicalRoot,
          projectName: "project",
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, stall.fileSystem),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(stall.entered);
        const lockPath = path.join(options.environment["TACK_STATE_DIR"] ?? "", "state.lock");
        expect(yield* liveFileSystem.exists(lockPath)).toBe(true);
        yield* Fiber.interrupt(fiber);
        expect(yield* liveFileSystem.exists(lockPath)).toBe(false);
        const interrupted = yield* readState(options);
        expect(interrupted.data.journal?.map((entry) => entry._tag)).toEqual(["remove"]);
        expect(pendingRemovalsOf(interrupted.data.links)[0]?.lastResult?._tag).toBe("interrupted");
        expect(yield* liveFileSystem.exists(canonicalDestination)).toBe(false);

        const retry = yield* retryPendingRemovals(options, { apply: true });
        const settled = yield* readState(options);
        expect(retry.applied?.finalizedProject).toBe(true);
        expect(settled.data.projects ?? []).toEqual([]);
        expect(pendingRemovalsOf(settled.data.links)).toEqual([]);
        expect(settled.data.journal).toBeUndefined();
        expect(yield* liveFileSystem.exists(statePath)).toBe(true);
      }),
    ),
  );

  removalIt.effect("cleans docs through root removal, project removal, and full reset", () =>
    withDocsWorld(({ options, sourceId, roots, source }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const resource = {
          sourceRegistrationId: sourceId,

          name: "handbook",
        };
        yield* attachDocs(options, { projectName: "demo" }, docsRequest(resource));
        yield* syncDocsReport(options, { projectName: "demo", apply: true });
        yield* removeProjectRoot(options, {
          apply: true,
          projectName: "demo",
          canonicalRoot: roots[0] ?? "",
        });
        expect(docsEvidence(yield* readState(options))).toHaveLength(1);
        yield* removeProject(options, { apply: true, projectName: "demo" });
        expect(docsEvidence(yield* readState(options))).toEqual([]);
        expect(allDocsSettings(yield* readState(options)) ?? []).toEqual([]);
        expect(yield* fs.exists(source)).toBe(true);
        yield* resetTack(options, { apply: true });
        expect(yield* Effect.flip(readState(options))).toMatchObject({
          _tag: "StateNotInitializedError",
        });
      }),
    ),
  );

  // Each scope that covers the replaced mount on the first root; only the first two cover the
  // healthy mount on the second root as well.
  removalIt.effect.each([
    ["project", true, () => ({ _tag: "project", projectName: "demo" })],
    [
      "project-root",
      false,
      ({ roots }) => ({ _tag: "project-root", projectName: "demo", canonicalRoot: roots[0] ?? "" }),
    ],
    ["source", true, ({ sourceId }) => ({ _tag: "source", sourceRegistrationId: sourceId })],
    [
      "selected-targets",
      false,
      ({ roots }) => ({
        _tag: "selected-targets",
        targets: [targetProject("demo", roots[0] ?? "")],
      }),
    ],
    ["reset", true, () => ({ _tag: "reset" })],
  ] as const satisfies ReadonlyArray<
    readonly [string, boolean, (world: DocsWorld) => RemovalScope]
  >)(
    "previews a docs mount replaced by a folder as a conflict in a %s removal",
    ([, coversHealthy, scopeOf]) =>
      withDocsWorld((world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* attachDocs(
            world.options,
            { projectName: "demo" },
            docsRequest({ sourceRegistrationId: world.sourceId, name: "handbook" }),
          );
          yield* syncDocsReport(world.options, { projectName: "demo", apply: true });
          const [replaced, healthy] = docsEvidence(yield* readState(world.options));
          if (replaced === undefined || healthy === undefined)
            return yield* Effect.die("Expected two docs mounts");
          yield* fs.remove(replaced.destinationPath);
          yield* fs.makeDirectory(replaced.destinationPath);

          const plan = yield* planRemovalAt(world.options, { scope: scopeOf(world) });

          // Apply refuses the replaced mount, so the preview reports it as a conflict up front.
          expect(plan.docsActions).toEqual([
            {
              action: "conflict",
              code: "docs-destination-modified",
              evidence: reportDocsManagedLink(replaced),
              message:
                "The recorded destination was changed; ownership does not authorize removing it.",
            },
            ...(coversHealthy
              ? [{ action: "remove", evidence: reportDocsManagedLink(healthy) }]
              : []),
          ]);
          return undefined;
        }),
      ),
  );

  removalIt.effect(
    "finishes a project removal whose docs mount was replaced by a folder and keeps the obligation",
    () =>
      withDocsWorld(({ options, sourceId, root }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* attachDocs(
            options,
            { projectName: "demo" },
            docsRequest({ sourceRegistrationId: sourceId, name: "handbook" }),
          );
          yield* syncDocsReport(options, { projectName: "demo", apply: true });
          const [replaced, removed] = docsEvidence(yield* readState(options));
          if (replaced === undefined || removed === undefined)
            return yield* Effect.die("Expected two docs mounts");
          yield* fs.remove(replaced.destinationPath);
          yield* fs.makeDirectory(replaced.destinationPath);

          const result = yield* removeProject(options, { apply: true, projectName: "demo" });

          // The command finishes: the project is finalized, the healthy mount is removed and the
          // replaced one stays on disk as an owed removal with the reason.
          expect(result.applied?.finalizedProject).toBe(true);
          expect(result.applied?.docsActions?.map((outcome) => outcome._tag)).toEqual([
            "blocked",
            "applied",
          ]);
          const left = yield* readState(options);
          expect(left.data.projects).toEqual([]);
          expect(docsPendingRemovalsOf(left.data.links)).toMatchObject([
            {
              cause: "project-removal",
              evidence: { destinationPath: replaced.destinationPath },
              lastResult: { _tag: "blocked", message: "The destination is an existing directory." },
            },
          ]);
          expect(yield* fs.exists(removed.destinationPath)).toBe(false);

          // status and doctor report the obligation with the agent ones.
          const status = yield* runStatus(options, { cwd: root, selector: { _tag: "all" } });
          expect(status.docsPendingRemovals).toMatchObject([
            { evidence: { destinationPath: replaced.destinationPath } },
          ]);
          expect(linksCheck(status, (argv) => argv)).toMatchObject({
            outcome: "failed",
            message: "1 pending removal.",
            subjects: ["demo"],
            next: ["tack", "state", "clean", "--pending", "--project", "demo"],
          });

          // clean retries it: still blocked while the folder is there, settled once it is gone.
          const blocked = yield* retrySelectedPendingRemovals(options, {
            apply: true,
            cwd: root,
            selector: { _tag: "project", projectName: "demo" },
          });
          expect(blocked.applied?.docsActions).toMatchObject([{ _tag: "blocked" }]);
          expect(docsPendingRemovalsOf((yield* readState(options)).data.links)).toHaveLength(1);
          yield* fs.remove(replaced.destinationPath, { recursive: true });
          const settled = yield* retrySelectedPendingRemovals(options, {
            apply: true,
            cwd: root,
            selector: { _tag: "project", projectName: "demo" },
          });
          expect(settled.applied?.docsActions).toMatchObject([{ _tag: "applied" }]);
          expect(docsPendingRemovalsOf((yield* readState(options)).data.links)).toEqual([]);
          return undefined;
        }),
      ),
  );
});
