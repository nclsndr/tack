import { managedLinksOf, pendingRemovalsOf } from "../../domain/links/link-record-schema.ts";
import { mutateStateFixture } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { planRemoval, retryPendingRemovals } from "../../../test/support/removal.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import type { ProfileApplication } from "../../domain/profiles/profile-application.ts";
import {
  initializeState,
  readState,
  withStateCheckpointWriter,
  type StateOptions,
} from "../../services/state-store.ts";
import { applyRemovalWithWriter } from "./removal-apply.ts";

const sourceId = "00000000-0000-4000-8000-000000000001";

/** A project `project` whose root holds one managed link to the source `alpha`. */
const linkedWorld = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-removal-" }));
  const options = {
    environment: { TACK_STATE_DIR: path.join(root, "state") },
    homeDirectory: path.join(root, "home"),
  } satisfies StateOptions;
  yield* initializeState(options);
  const projectRoot = path.join(root, "project");
  const source = path.join(root, "source", "alpha");
  const skills = path.join(projectRoot, ".agents", "skills");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.makeDirectory(skills, { recursive: true });
  const destination = path.join(skills, "alpha");
  yield* fs.symlink(path.relative(skills, source), destination);
  const evidence = {
    adapter: "codex" as const,
    address: { kind: "skill" as const, name: "alpha", sourceRegistrationId: sourceId },
    sourceDirectoryPath: source,
    sourceRegistrationId: sourceId,
    target: {
      _tag: "project-root" as const,
      canonicalPath: projectRoot,
      projectName: "project",
    },
  };
  const project = {
    gitCommonDirectory: path.join(root, "git"),
    name: "project",
    roots: [projectRoot],
  };
  yield* mutateStateFixture(options, (state) => ({
    ...state,
    data: { ...state.data, managedLinks: [evidence], projects: [project] },
  }));
  return { fs, path, root, options, projectRoot, destination, evidence, project };
});

it.layer(LiveTestLayer)("removal against state that moved on", (test) => {
  test.effect("leaves projects alone when the project a plan removes is already gone", () =>
    Effect.gen(function* () {
      const { options } = yield* linkedWorld;
      const plan = yield* planRemoval(options, {
        cause: "project-removal",
        scope: { _tag: "project", projectName: "project" },
      });
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: { ...state.data, projects: [] },
      }));
      const result = yield* withStateCheckpointWriter(options, (writer) =>
        applyRemovalWithWriter(writer, plan),
      );
      expect(result.finalizedProject).toBe(false);
      expect((yield* readState(options)).data.projects).toEqual([]);
    }),
  );

  test.effect("leaves a destination an interrupted apply left prepared during a reset", () =>
    Effect.gen(function* () {
      const { fs, options, destination, evidence } = yield* linkedWorld;
      const plan = yield* planRemoval(options, { cause: "clean", scope: { _tag: "reset" } });
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          managedLinks: [evidence],
          reconciliationJournal: { action: { _tag: "link-remove", evidence } },
        },
      }));
      // A reset journals nothing, so applying it without recovery finds the earlier entry.
      const result = yield* withStateCheckpointWriter(options, (writer) =>
        applyRemovalWithWriter(writer, plan),
      );
      expect(result.actions).toMatchObject([
        {
          _tag: "skipped",
          reason: "An interrupted change to this destination is awaiting recovery.",
        },
      ]);
      expect(yield* fs.exists(destination)).toBe(true);
    }),
  );

  test.effect("drops the profile of a finalized project and keeps every other profile", () =>
    Effect.gen(function* () {
      const { path, root, options, project } = yield* linkedWorld;
      const application = (namespace: ProfileApplication["namespace"]): ProfileApplication => ({
        namespace,
        profileName: "team",
        sourceRegistrationId: sourceId,
        direct: [],
        inventory: [],
        targets: [],
      });
      const other = {
        gitCommonDirectory: path.join(root, "other-git"),
        name: "other",
        roots: [path.join(root, "other")],
      };
      yield* mutateStateFixture(options, (state) => ({
        format: 1,
        data: {
          ...state.data,
          managedLinks: [],
          projects: [other, { ...project, roots: [], removingRoots: project.roots }],
          profileApplications: [
            application({ _tag: "user" }),
            application({ _tag: "project", projectName: "other" }),
            application({ _tag: "project", projectName: "project" }),
          ],
        },
      }));
      yield* retryPendingRemovals(options, { apply: true });
      const state = yield* readState(options);
      expect(state.data.projects.map(({ name }) => name)).toEqual(["other"]);
      expect(state.data.profileApplications?.map(({ namespace }) => namespace)).toEqual([
        { _tag: "user" },
        { _tag: "project", projectName: "other" },
      ]);
      expect(managedLinksOf(state.data.links)).toEqual([]);
      expect(pendingRemovalsOf(state.data.links)).toEqual([]);
    }),
  );
});
