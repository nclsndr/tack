import { mutateStateFixture } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { selectTargets } from "../../../test/support/snapshot-helpers.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { initializeState } from "../../services/state-store.ts";

it.layer(LiveTestLayer)("user target selection", (test) => {
  test.effect("resolves the home of a user profile, and keeps a missing home as spelled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-user-" }));
      const realHome = path.join(root, "real-home");
      const linkedHome = path.join(root, "linked-home");
      yield* fs.makeDirectory(realHome);
      yield* fs.symlink(realHome, linkedHome);
      const options = { environment: { TACK_STATE_DIR: path.join(root, "state") } };
      yield* initializeState(options);
      yield* mutateStateFixture(options, (state) => ({
        format: 1,
        data: {
          ...state.data,
          profileApplications: [
            {
              namespace: { _tag: "user" },
              profileName: "team",
              sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
              direct: [],
              inventory: [],
              targets: [],
            },
          ],
        },
      }));
      const userTarget = (home: string) =>
        selectTargets(
          { ...options, homeDirectory: home },
          { cwd: root, selector: { _tag: "user" } },
        ).pipe(Effect.map((selection) => selection.targets));

      expect(yield* userTarget(linkedHome)).toEqual([{ _tag: "user", canonicalPath: realHome }]);
      const missing = path.join(root, "missing-home");
      expect(yield* userTarget(missing)).toEqual([{ _tag: "user", canonicalPath: missing }]);
      // An explicit user target wins over the operator home.
      const explicit = yield* selectTargets(
        { ...options, homeDirectory: missing },
        { cwd: root, selector: { _tag: "user" }, userTarget: linkedHome },
      );
      expect(explicit.targets).toEqual([{ _tag: "user", canonicalPath: realHome }]);
      // Without a home or a user target there is no user target to select.
      expect(
        yield* Effect.flip(selectTargets(options, { cwd: root, selector: { _tag: "user" } })),
      ).toMatchObject({
        _tag: "StateConfigurationError",
        message: "The operator home directory is unavailable.",
      });
    }),
  );

  test.effect("names the root being removed when a bare selection starts inside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-bare-" }));
      const leaving = path.join(root, "leaving");
      yield* fs.makeDirectory(path.join(leaving, "inside"), { recursive: true });
      const options = { environment: { TACK_STATE_DIR: path.join(root, "state") } };
      yield* initializeState(options);
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          projects: [
            {
              gitCommonDirectory: path.join(root, "git"),
              name: "gone",
              removingRoots: [leaving],
              roots: [],
            },
          ],
        },
      }));
      const error = yield* Effect.flip(
        selectTargets(options, { cwd: path.join(leaving, "inside"), selector: { _tag: "bare" } }),
      );
      expect(error).toMatchObject({
        _tag: "TargetSelectionError",
        code: "bare-target-requires-registered-root",
        path: path.join(leaving, "inside"),
        projectName: "gone",
        root: leaving,
      });
    }),
  );
});
