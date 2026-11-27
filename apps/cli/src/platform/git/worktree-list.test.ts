import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { GitOutputParseError } from "../../services/git.ts";
import { parseGitWorktreeList } from "./worktree-list.ts";

it.effect("parses NUL-terminated worktree records without newline splitting", () =>
  Effect.gen(function* () {
    const output =
      "worktree /repo/with\nnewline\0HEAD abc\0branch refs/heads/main\0\0" +
      "worktree /repo/second\0bare\0locked\0prunable\0\0";
    const parsed = yield* parseGitWorktreeList(output);

    expect(parsed).toEqual([
      {
        bare: false,
        branch: "refs/heads/main",
        detached: false,
        path: "/repo/with\nnewline",
      },
      { bare: true, detached: false, locked: "", path: "/repo/second", prunable: "" },
    ]);
  }),
);

it.effect("rejects non-NUL-terminated worktree output", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(parseGitWorktreeList("worktree /repo"));

    expect(error).toBeInstanceOf(GitOutputParseError);
  }),
);

it.effect("rejects malformed and duplicate porcelain attributes", () =>
  Effect.gen(function* () {
    const malformed = yield* Effect.flip(parseGitWorktreeList("not-worktree /repo\0\0"));
    const malformedAttribute = yield* Effect.flip(
      parseGitWorktreeList("worktree /repo\0worktree\0\0"),
    );
    const missingPath = yield* Effect.flip(parseGitWorktreeList("worktree \0\0"));
    const duplicate = yield* Effect.flip(
      parseGitWorktreeList("worktree /repo\0HEAD abc\0HEAD def\0\0"),
    );
    const empty = yield* parseGitWorktreeList("");

    expect(malformed).toBeInstanceOf(GitOutputParseError);
    expect(malformedAttribute).toBeInstanceOf(GitOutputParseError);
    expect(missingPath).toBeInstanceOf(GitOutputParseError);
    expect(duplicate).toBeInstanceOf(GitOutputParseError);
    expect(empty).toEqual([]);
  }),
);
