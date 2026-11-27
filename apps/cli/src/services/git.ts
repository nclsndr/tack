import { Context, Effect, Schema } from "effect";

/** A command executed by the Git capability. */
export type GitCommand = {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
};

/** A parsed worktree entry returned by Git. */
export type GitWorktree = {
  readonly path: string;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly branch?: string;
  readonly locked?: string;
  readonly prunable?: string;
};

/** Reports a Git process that could not be started, drained, or exited successfully. */
export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  args: Schema.Array(Schema.String),
  code: Schema.Literals(["git-process-failed", "git-process-spawn-failed"]),
  command: Schema.String,
  cwd: Schema.String,
  exitCode: Schema.optionalKey(Schema.Number),
  message: Schema.String,
  phase: Schema.Literals(["spawn", "output", "exit"]),
  stderr: Schema.String,
}) {}

/** Reports malformed output from a Git discovery command. */
export class GitOutputParseError extends Schema.TaggedError<GitOutputParseError>()(
  "GitOutputParseError",
  {
    command: Schema.String,
    message: Schema.String,
  },
) {}

/** The process-backed Git service used by project registration and refresh. */
export type GitService = {
  readonly resolveCommonDirectory: (
    cwd: string,
  ) => Effect.Effect<string, GitCommandError | GitOutputParseError>;
  readonly listWorktrees: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<GitWorktree>, GitCommandError | GitOutputParseError>;
};

/** Injectable Git capability. */
export class Git extends Context.Service<Git, GitService>()("tack/cli/services/git/Git") {}
