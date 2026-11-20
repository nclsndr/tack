import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Layer, Stream } from "effect";
import {
  Git,
  GitCommandError,
  parseGitWorktreeList,
  GitOutputParseError,
  type GitCommand,
  type GitService,
} from "../../services/git.ts";

const parseCommandOutput = (output: string, command: string) => {
  const lines = output.split(/\r?\n/);
  const withoutTrailingLine = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
  const value = withoutTrailingLine[0];

  return withoutTrailingLine.length === 1 && value !== undefined && value !== ""
    ? Effect.succeed(value)
    : Effect.fail(
        new GitOutputParseError({
          command,
          message: "Git returned an empty or multi-line path.",
        }),
      );
};

const runGitCommand = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: GitCommand,
): Effect.Effect<{ readonly stderr: string; readonly stdout: string }, GitCommandError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* spawner
        .spawn(ChildProcess.make("git", command.args, { cwd: command.cwd }))
        .pipe(
          Effect.mapError(
            (error) =>
              new GitCommandError({
                args: [...command.args],
                code: "git-process-spawn-failed",
                command: "git",
                cwd: command.cwd,
                message: error.message,
                phase: "spawn",
                stderr: "",
              }),
          ),
        );

      const output = yield* Effect.all(
        {
          stderr: process.stderr.pipe(Stream.decodeText, Stream.mkString),
          stdout: process.stdout.pipe(Stream.decodeText, Stream.mkString),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (error) =>
            new GitCommandError({
              args: [...command.args],
              code: "git-process-failed",
              command: "git",
              cwd: command.cwd,
              message: error.message,
              phase: "output",
              stderr: "",
            }),
        ),
      );

      const exitCode = yield* process.exitCode.pipe(
        Effect.mapError(
          (error) =>
            new GitCommandError({
              args: [...command.args],
              code: "git-process-failed",
              command: "git",
              cwd: command.cwd,
              message: error.message,
              phase: "exit",
              stderr: output.stderr,
            }),
        ),
      );

      if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
        return yield* new GitCommandError({
          args: [...command.args],
          code: "git-process-failed",
          command: "git",
          cwd: command.cwd,
          exitCode,
          message: `Git exited with code ${exitCode}.`,
          phase: "exit",
          stderr: output.stderr,
        });
      }

      return output;
    }),
  );

/** Builds the Git discovery capability over an injectable child-process service. */
export const makeGitService = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): GitService => ({
  resolveCommonDirectory: (cwd) =>
    Effect.gen(function* () {
      const output = yield* runGitCommand(spawner, {
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd,
      });
      return yield* parseCommandOutput(output.stdout, "git rev-parse --git-common-dir");
    }),
  listWorktrees: (cwd) =>
    Effect.gen(function* () {
      const output = yield* runGitCommand(spawner, {
        args: ["worktree", "list", "--porcelain", "-z"],
        cwd,
      });
      return yield* parseGitWorktreeList(output.stdout);
    }),
});

/** Provides the process-backed Git service using the platform child-process implementation. */
export const GitLive = Layer.effect(
  Git,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return makeGitService(spawner);
  }),
);
