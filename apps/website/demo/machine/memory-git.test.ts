import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeMemoryGit } from "./memory-git.ts";
import { makeMemoryVolume } from "./memory-volume.ts";

const world = () => {
  const volume = makeMemoryVolume();
  volume.mkdir("/home/you/code/app/.git", { recursive: true });
  volume.mkdir("/home/you/code/app/src", { recursive: true });
  volume.mkdir("/home/you/notes", { recursive: true });
  volume.symlink("/home/you/code/app", "/home/you/app-link");
  return makeMemoryGit(volume);
};

describe("memory git", () => {
  it.effect("finds the repository that contains a nested or linked directory", () =>
    Effect.gen(function* () {
      const git = world();

      expect(yield* git.resolveCommonDirectory("/home/you/code/app/src")).toBe(
        "/home/you/code/app/.git",
      );
      expect(yield* git.resolveCommonDirectory("/home/you/app-link")).toBe(
        "/home/you/code/app/.git",
      );
      expect(yield* git.listWorktrees("/home/you/code/app/src")).toEqual([
        { path: "/home/you/code/app", bare: false, detached: false, branch: "refs/heads/main" },
      ]);
    }),
  );

  it.effect.each(["/home/you/notes", "/home/you/missing"])(
    "fails the way git does outside a repository: %s",
    (cwd) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(world().listWorktrees(cwd));

        expect(error).toMatchObject({
          _tag: "GitCommandError",
          code: "git-process-failed",
          cwd,
          exitCode: 128,
          phase: "exit",
          stderr: expect.stringContaining("not a git repository"),
        });
      }),
  );
});
