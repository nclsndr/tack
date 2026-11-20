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
export class Git extends Context.Service<Git, GitService>()("tack/cli/Git") {}

const worktreeCommand = "git worktree list --porcelain -z";

const parseWorktreeRecord = (record: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const first = record[0];
    if (first === undefined || first.startsWith("worktree ") === false) {
      return yield* new GitOutputParseError({
        command: worktreeCommand,
        message: "A worktree record must begin with a worktree path.",
      });
    }

    const attributes = yield* Effect.forEach(record, (attribute) => {
      const separator = attribute.indexOf(" ");
      const label = separator === -1 ? attribute : attribute.slice(0, separator);
      const value = separator === -1 ? undefined : attribute.slice(separator + 1);

      if (label.length === 0 || (label === "worktree" && separator === -1)) {
        return Effect.fail(
          new GitOutputParseError({
            command: worktreeCommand,
            message: "A worktree attribute is malformed.",
          }),
        );
      }

      return Effect.succeed({ label, value });
    });

    const labels = attributes.map((attribute) => attribute.label);
    if (new Set(labels).size !== labels.length) {
      return yield* new GitOutputParseError({
        command: worktreeCommand,
        message: "A worktree record contains duplicate attributes.",
      });
    }

    const path = attributes.find((attribute) => attribute.label === "worktree")?.value;
    if (path === undefined || path.length === 0) {
      return yield* new GitOutputParseError({
        command: worktreeCommand,
        message: "A worktree record has no path.",
      });
    }

    const booleanAttribute = (label: string) =>
      attributes.some((attribute) => attribute.label === label);
    const valueAttribute = (label: string) =>
      attributes.find((attribute) => attribute.label === label)?.value;
    const branch = valueAttribute("branch");
    const locked = booleanAttribute("locked") ? (valueAttribute("locked") ?? "") : undefined;
    const prunable = booleanAttribute("prunable") ? (valueAttribute("prunable") ?? "") : undefined;

    return {
      bare: booleanAttribute("bare"),
      detached: booleanAttribute("detached"),
      path,
      ...(branch === undefined ? {} : { branch }),
      ...(locked === undefined ? {} : { locked }),
      ...(prunable === undefined ? {} : { prunable }),
    } satisfies GitWorktree;
  });

/** Parses Git's NUL-terminated porcelain worktree output. */
export const parseGitWorktreeList = (output: string) =>
  Effect.gen(function* () {
    if (output.length === 0) {
      return [] as ReadonlyArray<GitWorktree>;
    }

    if (output.endsWith("\0") === false) {
      return yield* new GitOutputParseError({
        command: worktreeCommand,
        message: "Git worktree output is not NUL terminated.",
      });
    }

    const tokenState = output.split("\0").reduce<{
      readonly current: ReadonlyArray<string>;
      readonly records: ReadonlyArray<ReadonlyArray<string>>;
    }>((state, token) => (token === "" ? (state.current.length === 0 ? state : { current: [], records: [...state.records, state.current] }) : { current: [...state.current, token], records: state.records }), { current: [], records: [] });

    return yield* Effect.forEach(tokenState.records, (record) => parseWorktreeRecord(record));
  });
