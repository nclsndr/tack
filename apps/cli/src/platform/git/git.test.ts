import { expect, it } from "@effect/vitest";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, PlatformError, Sink, Stream } from "effect";
import { Git } from "../../services/git.ts";
import { GitLive, makeGitService } from "./git.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

const fakeHandle = (stdout: string, stderr: string, exitCode: number) =>
  ChildProcessSpawner.makeHandle({
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    pid: ChildProcessSpawner.ProcessId(1),
    stderr: Stream.succeed(bytes(stderr)),
    stdin: Sink.drain,
    stdout: Stream.succeed(bytes(stdout)),
    unref: Effect.succeed(Effect.void),
  });

it.effect("runs each Git discovery command with captured output and checks its exit code", () =>
  Effect.gen(function* () {
    const commands: Array<{ readonly args: ReadonlyArray<string>; readonly cwd: string }> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command) === false) {
        return Effect.die("Expected a standard Git command.");
      }
      commands.push({ args: command.args, cwd: command.options.cwd ?? "" });
      return Effect.succeed(
        fakeHandle(
          commands.length === 1
            ? "/repo/.git\n"
            : "worktree /repo/main\0HEAD abc\0branch refs/heads/main\0\0",
          "diagnostic output",
          0,
        ),
      );
    });
    const git = makeGitService(spawner);

    const anchor = yield* git.resolveCommonDirectory("/repo/main");
    const worktrees = yield* git.listWorktrees("/repo/main");

    expect(anchor).toBe("/repo/.git");
    expect(worktrees).toEqual([
      {
        bare: false,
        branch: "refs/heads/main",
        detached: false,
        path: "/repo/main",
      },
    ]);
    expect(commands).toEqual([
      {
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd: "/repo/main",
      },
      {
        args: ["worktree", "list", "--porcelain", "-z"],
        cwd: "/repo/main",
      },
    ]);
  }),
);

it.effect("reports a nonzero Git exit with captured stderr", () =>
  Effect.gen(function* () {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(fakeHandle("", "not a repository", 128)),
    );
    const git = makeGitService(spawner);
    const error = yield* Effect.flip(git.resolveCommonDirectory("/outside"));

    expect(error).toMatchObject({
      code: "git-process-failed",
      phase: "exit",
      stderr: "not a repository",
    });
  }),
);

it.effect("maps spawn, output-drain, and exit-wait failures to typed process errors", () =>
  Effect.gen(function* () {
    const spawnFailure = ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "Unknown",
          method: "spawn",
          module: "git-test",
          description: "spawn failed",
        }),
      ),
    );
    const spawnError = yield* Effect.flip(
      makeGitService(spawnFailure).resolveCommonDirectory("/repo"),
    );

    const outputFailure = ChildProcessSpawner.make(() =>
      Effect.succeed({
        ...fakeHandle("", "", 0),
        stdout: Stream.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            method: "read",
            module: "git-test",
            description: "stdout failed",
          }),
        ),
      }),
    );
    const outputError = yield* Effect.flip(
      makeGitService(outputFailure).resolveCommonDirectory("/repo"),
    );

    const exitFailure = ChildProcessSpawner.make(() =>
      Effect.succeed({
        ...fakeHandle("/repo/.git\n", "diagnostic", 0),
        exitCode: Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            method: "wait",
            module: "git-test",
            description: "wait failed",
          }),
        ),
      }),
    );
    const exitError = yield* Effect.flip(
      makeGitService(exitFailure).resolveCommonDirectory("/repo"),
    );

    expect(spawnError).toMatchObject({ code: "git-process-spawn-failed", phase: "spawn" });
    expect(outputError).toMatchObject({ code: "git-process-failed", phase: "output" });
    expect(exitError).toMatchObject({
      code: "git-process-failed",
      phase: "exit",
      stderr: "diagnostic",
    });
  }),
);

it.effect("provides the process-backed Git service through GitLive", () =>
  Effect.gen(function* () {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(fakeHandle("/repo/.git\n", "", 0)),
    );
    const anchor = yield* Effect.gen(function* () {
      const git = yield* Git;
      return yield* git.resolveCommonDirectory("/repo");
    }).pipe(
      Effect.provide(GitLive),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    expect(anchor).toBe("/repo/.git");
  }),
);

it.effect("accepts one path without a trailing newline and refuses empty or multi-line paths", () =>
  Effect.gen(function* () {
    const answering = (stdout: string) =>
      makeGitService(ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(stdout, "", 0))));

    expect(yield* answering("/repo/.git").resolveCommonDirectory("/repo")).toBe("/repo/.git");
    for (const stdout of ["", "\n", "/one/.git\n/two/.git\n"]) {
      const error = yield* Effect.flip(answering(stdout).resolveCommonDirectory("/repo"));
      expect(error).toMatchObject({
        _tag: "GitOutputParseError",
        message: "Git returned an empty or multi-line path.",
      });
    }
  }),
);
