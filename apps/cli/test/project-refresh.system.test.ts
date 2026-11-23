import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { withTackWorld } from "./support/tack-world.ts";
import { decodeEnvelope, tackProcess } from "./support/tack-process.ts";

// The process-level smoke test of `tack status` and `tack project refresh`, without HOME. The
// other cases run in process, in `project-refresh.host.test.ts`.
it.layer(LiveTestLayer)("project refresh against real Git", (refreshIt) => {
  refreshIt.effect(
    "bare status needs no HOME, while --all still does",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const withoutHome = { state: fixture.stateDirectory };
          const bare = yield* tackProcess(["--json", "status"], {
            ...withoutHome,
            cwd: fixture.primaryRoot,
          });
          expect(bare.exitCode).not.toBe(ChildProcessSpawner.ExitCode(2));
          expect(decodeEnvelope(bare.stdout).result).toMatchObject({
            scope: { _tag: "project", projectName: "workspace" },
          });
          const all = yield* tackProcess(["--json", "status", "--all"], {
            ...withoutHome,
            cwd: fixture.primaryRoot,
          });
          expect(all.exitCode).toBe(ChildProcessSpawner.ExitCode(2));
          expect(decodeEnvelope(all.stdout).diagnostics).toContainEqual(
            expect.objectContaining({
              code: "home-directory-unavailable",
            }),
          );
          const refreshAll = yield* tackProcess(["--json", "project", "refresh", "--all"], {
            ...withoutHome,
            cwd: fixture.homeDirectory,
          });
          expect(refreshAll.exitCode).toBe(ChildProcessSpawner.ExitCode(0));
          expect(decodeEnvelope(refreshAll.stdout).plan).toMatchObject({
            refresh: { scope: { _tag: "all" } },
          });
        }),
      ),
    { timeout: 20_000 },
  );
});
