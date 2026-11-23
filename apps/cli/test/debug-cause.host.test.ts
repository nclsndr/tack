import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import type { GitService } from "../src/services/git.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

/** Git discovery that fails with a defect, as a bug in Tack would. */
const brokenGit = {
  listWorktrees: () => Effect.die(new Error("forced defect in worktree discovery")),
  resolveCommonDirectory: () => Effect.die(new Error("forced defect in worktree discovery")),
} satisfies GitService;

/** A throwaway state directory and project folder, and the words that register the project. */
const world = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "tack-debug-cause-" });
  const project = path.join(root, "project");
  yield* fs.makeDirectory(project, { recursive: true });
  const state = ["--state-dir", path.join(root, "state")];
  yield* runHost({ args: [...state, "state", "init"], git: brokenGit });
  const words = [...state, "project", "add", "demo", "--repository-cwd", project];
  return { words };
});

it.layer(LiveTestLayer)("TACK_DEBUG", (test) => {
  test.effect("prints the cause of a defect to stderr and leaves the envelope unchanged", () =>
    Effect.gen(function* () {
      const { words } = yield* world;
      const args = ["--json", ...words];
      const quiet = yield* runHost({ args, git: brokenGit });
      const debug = yield* runHost({ args, git: brokenGit, env: { TACK_DEBUG: "1" } });

      expect(quiet.stderr).toBe("");
      expect(debug.stdout).toBe(quiet.stdout);
      expect(debug.stderr).toContain("forced defect in worktree discovery");
      expect(debug.stderr).toContain("at projects.registerProject");
      expect(debug.stderr.indexOf("forced defect")).toBeLessThan(
        debug.stderr.indexOf("at projects.registerProject"),
      );
      expect(decodeEnvelope(quiet.stdout)).toMatchObject({
        classification: "internal",
        diagnostics: [
          { code: "internal-error", message: "An unexpected internal error occurred." },
        ],
        next: [`TACK_DEBUG=1 tack ${args.join(" ")}`],
      });
    }),
  );

  test.effect("ends the text view of an internal error with the debug rerun", () =>
    Effect.gen(function* () {
      const { words } = yield* world;
      const run = yield* runHost({ args: words, git: brokenGit });

      expect(run.stderr).toBe("");
      expect(run.stdout).toContain("✗ An unexpected internal error occurred.");
      const next = run.stdout.slice(run.stdout.lastIndexOf("\nNext\n") + "\nNext\n".length);
      // A long command wraps with a trailing backslash; joined, it is the same command line.
      expect(next.replaceAll(/ \\\n\s+/g, " ").trim()).toBe(`TACK_DEBUG=1 tack ${words.join(" ")}`);
    }),
  );

  test.effect("prints nothing extra for an outcome that is not internal", () =>
    Effect.gen(function* () {
      const { words } = yield* world;
      const run = yield* runHost({
        args: ["--json", ...words.slice(0, 2), "state", "init"],
        git: brokenGit,
        env: { TACK_DEBUG: "1" },
      });

      expect(run.stderr).toBe("");
      expect(decodeEnvelope(run.stdout).classification).toBe("success");
    }),
  );
});
