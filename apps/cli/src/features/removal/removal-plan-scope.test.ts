import { mutateStateFixture } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { planRemovalAt } from "../../../test/support/removal.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { docsLink } from "../../domain/docs/docs-schema.ts";
import { initializeState, type StateOptions } from "../../services/state-store.ts";
import { attachDocs } from "../docs/docs.ts";
import { docsRequest, syncDocsReport, withDocsWorld } from "../../../test/support/docs-world.ts";

const sourceId = "00000000-0000-4000-8000-000000000001";

/** A project with one root, `kept`, and a docs mount at it that only owes its removal. */
const owedDocsWorld = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-plan-" }));
  const options = {
    stateDirectory: path.join(root, "state"),
    homeDirectory: path.join(root, "home"),
  } satisfies StateOptions;
  yield* initializeState(options);
  const kept = path.join(root, "kept");
  const mount = {
    projectName: "project",
    root: kept,
    resource: { sourceRegistrationId: sourceId, name: "notes" },
    destinationPath: path.join(kept, ".tack", "docs", sourceId, "notes"),
    sourceDirectoryPath: path.join(root, "source", "notes"),
  };
  yield* mutateStateFixture(options, (state) => ({
    ...state,
    data: {
      ...state.data,
      links: [{ ...docsLink(mount), removal: { cause: "clean" as const }, pendingOnly: true }],
      projects: [{ gitCommonDirectory: path.join(root, "git"), name: "project", roots: [kept] }],
    },
  }));
  return { options, kept, mount, root, path };
});

it.layer(LiveTestLayer)("removal plan scope", (test) => {
  test.effect("retries a docs mount the project or its root still owes", () =>
    Effect.gen(function* () {
      const { options, kept, mount } = yield* owedDocsWorld;
      const project = yield* planRemovalAt(options, {
        cause: "project-removal",
        scope: { _tag: "project", projectName: "project" },
      });
      expect(project.docsActions?.map((action) => action.evidence.destinationPath)).toEqual([
        mount.destinationPath,
      ]);
      const root = yield* planRemovalAt(options, {
        cause: "root-removal",
        scope: { _tag: "project-root", projectName: "project", canonicalRoot: kept },
      });
      expect(root.docsActions?.map((action) => action.evidence.destinationPath)).toEqual([
        mount.destinationPath,
      ]);
    }),
  );

  test.effect("plans an owed docs mount for every scope that reaches it and for no other", () =>
    Effect.gen(function* () {
      const { options, kept } = yield* owedDocsWorld;
      const target = { _tag: "project-root" as const, canonicalPath: kept, projectName: "project" };
      const planned = (scope: Parameters<typeof planRemovalAt>[1]["scope"]) =>
        planRemovalAt(options, { scope }).pipe(Effect.map((plan) => plan.docsActions?.length ?? 0));
      expect(yield* planned({ _tag: "maintenance" })).toBe(1);
      expect(yield* planned({ _tag: "retry-targets", targets: [target] })).toBe(1);
      expect(yield* planned({ _tag: "selected-targets", targets: [target] })).toBe(1);
      expect(yield* planned({ _tag: "retry-targets", targets: [] })).toBe(0);
      expect(yield* planned({ _tag: "adapter", adapter: "claude" })).toBe(0);
      expect(yield* planned({ _tag: "source", sourceRegistrationId: sourceId })).toBe(1);
      expect(
        yield* planned({
          _tag: "source",
          sourceRegistrationId: "00000000-0000-4000-8000-000000000002",
        }),
      ).toBe(0);
    }),
  );

  test.effect("refuses to plan for a project or root that is not registered", () =>
    Effect.gen(function* () {
      const { options, path, root } = yield* owedDocsWorld;
      expect(
        yield* Effect.flip(
          planRemovalAt(options, {
            cause: "project-removal",
            scope: { _tag: "project", projectName: "unknown" },
          }),
        ),
      ).toMatchObject({ _tag: "RemovalProjectNotFoundError", projectName: "unknown" });
      const elsewhere = path.join(root, "elsewhere");
      expect(
        yield* Effect.flip(
          planRemovalAt(options, {
            cause: "root-removal",
            scope: { _tag: "project-root", projectName: "project", canonicalRoot: elsewhere },
          }),
        ),
      ).toMatchObject({
        _tag: "RemovalRootNotFoundError",
        canonicalRoot: elsewhere,
        projectName: "project",
      });
    }),
  );

  test.effect("scopes docs cleanup evidence to selected targets and removal lifecycles", () =>
    withDocsWorld(({ options, sourceId: handbookSourceId, roots }) =>
      Effect.gen(function* () {
        yield* attachDocs(
          options,
          { projectName: "demo" },
          docsRequest({ sourceRegistrationId: handbookSourceId, name: "handbook" }),
        );
        yield* syncDocsReport(options, { projectName: "demo", apply: true });
        const target = {
          _tag: "project-root" as const,
          canonicalPath: roots[0] ?? "",
          projectName: "demo",
        };
        expect(
          (yield* planRemovalAt(options, {
            scope: { _tag: "selected-targets", targets: [target] },
          })).docsActions,
        ).toHaveLength(1);
        // Retry settles obligations only: a mount on an active root is healthy and stays.
        expect(
          (yield* planRemovalAt(options, { scope: { _tag: "retry-targets", targets: [target] } }))
            .docsActions,
        ).toBeUndefined();
        expect(
          (yield* planRemovalAt(options, { scope: { _tag: "adapter", adapter: "codex" } }))
            .docsActions,
        ).toBeUndefined();
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: (state.data.projects ?? []).map((entry) => ({
              ...entry,
              roots: [roots[1] ?? ""],
              removingRoots: [roots[0] ?? ""],
            })),
          },
        }));
        expect(
          (yield* planRemovalAt(options, { scope: { _tag: "maintenance" } })).docsActions,
        ).toHaveLength(1);
        // Once the root is being removed, its mount is evidence retry must settle.
        expect(
          (yield* planRemovalAt(options, { scope: { _tag: "retry-targets", targets: [target] } }))
            .docsActions,
        ).toHaveLength(1);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: (state.data.projects ?? []).map((entry) => ({
              ...entry,
              roots: [],
              removingRoots: [roots[0] ?? "", roots[1] ?? ""],
            })),
          },
        }));
        expect(
          (yield* planRemovalAt(options, { scope: { _tag: "retry-targets", targets: [target] } }))
            .docsActions,
        ).toHaveLength(1);
      }),
    ),
  );
});
