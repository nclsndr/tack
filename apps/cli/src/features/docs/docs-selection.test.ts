import { mutateState } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { initializeState } from "../../services/state-store.ts";
import { registerSource } from "../sources/source.ts";
import { attachDocs, configureDocs, inspectDocs } from "./docs.ts";
import { syncDocs } from "../../../test/support/reconciliation.ts";
import { runProjectRefreshCommand } from "../refresh/project-refresh.ts";
import { Git } from "../../services/git.ts";
import { fakeGit } from "../../../test/support/fake-git.ts";

/** A project `demo` with one root and two sources that both declare themselves `personal-brain`. */
const world = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-docs-sel-" }));
  const options = {
    environment: { TACK_STATE_DIR: path.join(root, "state") },
    homeDirectory: root,
  };
  yield* initializeState(options);
  const projectRoot = path.join(root, "project");
  yield* fs.makeDirectory(projectRoot);
  const project = {
    name: "demo",
    gitCommonDirectory: path.join(root, "git"),
    roots: [projectRoot],
  };
  yield* mutateState(options, (state) => ({
    ...state,
    data: { ...state.data, projects: [project] },
  }));
  const ids: Array<string> = [];
  for (const name of ["first", "second"]) {
    const source = path.join(root, name);
    yield* fs.makeDirectory(path.join(source, "knowledge"), { recursive: true });
    yield* fs.writeFileString(path.join(source, "knowledge", "a.md"), "# A\n");
    yield* fs.writeFileString(
      path.join(source, "tack.yaml"),
      `version: 1\nname: personal-brain\ndocs:\n  - name: ${name}-handbook\n    path: knowledge\n`,
    );
    ids.push((yield* registerSource(options, { sourcePath: source })).registration.id);
  }
  return { fs, path, root, options, project, projectRoot, ids };
});

it.layer(LiveTestLayer)("docs selection", (test) => {
  test.effect("refuses a label several sources share and a bare name no source declares", () =>
    Effect.gen(function* () {
      const { options, ids } = yield* world;
      const ambiguous = yield* Effect.flip(
        attachDocs(
          options,
          { projectName: "demo" },
          { reference: "personal-brain:first-handbook" },
        ),
      );
      expect(ambiguous).toMatchObject({
        _tag: "DocsError",
        code: "docs-source-label-ambiguous",
        details: { candidates: expect.arrayContaining(ids) },
      });
      expect(ambiguous.message).toContain("Use a registration ID.");
      expect(
        yield* Effect.flip(attachDocs(options, { projectName: "demo" }, { reference: "absent" })),
      ).toMatchObject({
        _tag: "DocsError",
        code: "docs-resource-unavailable",
        details: { name: "absent" },
      });
    }),
  );

  test.effect("cannot select a project from a directory that does not exist", () =>
    Effect.gen(function* () {
      const { path, root, options } = yield* world;
      expect(
        yield* Effect.flip(
          attachDocs(options, { cwd: path.join(root, "missing") }, { reference: "first-handbook" }),
        ),
      ).toMatchObject({ _tag: "DocsError", code: "docs-project-unavailable" });
    }),
  );

  test.effect("a refresh plans to remove a removing project's mounts and creates none", () =>
    Effect.gen(function* () {
      const { fs, options, project, projectRoot, ids } = yield* world;
      const [first = ""] = ids;
      yield* attachDocs(options, { projectName: "demo" }, { reference: `${first}:first-handbook` });
      const mounted = yield* syncDocs(options, { projectName: "demo", apply: true });
      expect(mounted.plan.actions.map(({ action }) => action)).toEqual(["create"]);
      yield* mutateState(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          // The project keeps its attachments while its root is being removed.
          projects: state.data.projects.map((entry) => ({
            ...entry,
            roots: [],
            removingRoots: [projectRoot],
          })),
        },
      }));
      // Git no longer lists the root, so the refresh keeps the project removing.
      yield* fs.makeDirectory(project.gitCommonDirectory);
      const removing = yield* runProjectRefreshCommand(options, {
        apply: false,
        scope: { _tag: "project", projectName: "demo" },
      }).pipe(Effect.provideService(Git, Git.of(fakeGit(project.gitCommonDirectory, []))));
      expect(removing.plan.docs.actions.map(({ action }) => action)).toEqual(["remove"]);
    }),
  );

  test.effect("inspects a project's docs settings when they are configured", () =>
    Effect.gen(function* () {
      const { options, ids } = yield* world;
      const [first = ""] = ids;
      const reference = { reference: `${first}:first-handbook` };
      const demo = { projectName: "demo" };
      yield* attachDocs(options, demo, reference);
      expect((yield* inspectDocs(options, demo)).settings).toEqual({});
      yield* configureDocs(options, demo, {
        destination: "knowledge",
        defaultWritingResource: reference,
      });
      const expected = {
        destination: "knowledge",
        defaultWritingResource: { sourceRegistrationId: first, name: "first-handbook" },
      };
      expect((yield* inspectDocs(options, demo)).settings).toEqual(expected);
    }),
  );
});
