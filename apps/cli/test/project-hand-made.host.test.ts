import { LiveTestLayer } from "./support/live-test-layer.ts";
import { fakeGit } from "./support/fake-git.ts";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import type { TerminalContextShape } from "../src/cli/human/terminal-context.ts";
import type { GitService } from "../src/services/git.ts";

const pipe: TerminalContextShape = {
  columns: 120,
  environment: { TERM: "dumb" },
  stdinIsTerminal: false,
  stdoutIsTerminal: false,
};

/**
 * A temporary machine with Claude enabled and the repository `app`, whose agent folder holds a
 * hand-made `code-review` skill. Its worktree `app-wt`, with a hand-made `notes.md`, is listed by
 * Git only once the test adds it. `json` and `text` run `tack` with an explicit state directory.
 */
const machine = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-project-hand-made-" }),
  );
  const at = (...parts: ReadonlyArray<string>) => path.join(root, ...parts);
  yield* Effect.forEach(["home", "app/.git", "app/.claude/skills/code-review", "app-wt"], (name) =>
    fileSystem.makeDirectory(at(name), { recursive: true }),
  );
  yield* fileSystem.writeFileString(at("app/.claude/skills/code-review/SKILL.md"), "mine\n");
  yield* fileSystem.makeDirectory(at("app-wt/.claude/skills"), { recursive: true });
  yield* fileSystem.writeFileString(at("app-wt/.claude/skills/notes.md"), "notes\n");
  const worktrees = [{ path: at("app") }];
  const git: GitService = {
    listWorktrees: (cwd) => fakeGit(at("app/.git"), worktrees).listWorktrees(cwd),
    resolveCommonDirectory: (cwd) => fakeGit(at("app/.git"), worktrees).resolveCommonDirectory(cwd),
  };
  const run = (arguments_: ReadonlyArray<string>, terminal?: TerminalContextShape) =>
    runHost({
      args: ["--state-dir", at("state"), ...arguments_],
      git,
      env: { HOME: at("home") },
      ...(terminal === undefined ? {} : { terminal }),
    });
  const json = (arguments_: ReadonlyArray<string>) =>
    run(["--json", ...arguments_]).pipe(Effect.map(({ stdout }) => decodeEnvelope(stdout)));
  const text = (arguments_: ReadonlyArray<string>) =>
    run(arguments_, pipe).pipe(Effect.map(({ stdout }) => stdout));
  expect((yield* json(["state", "init"])).status).toBe("success");
  expect((yield* json(["adapter", "enable", "claude"])).status).toBe("success");
  return {
    at,
    fileSystem,
    json,
    text,
    addWorktree: () => worktrees.push({ path: at("app-wt") }),
  };
});

it.layer(LiveTestLayer)("hand-made entries in project folders", (handMadeIt) => {
  handMadeIt.effect(
    "project add lists the hand-made entries of its roots as information and leaves them",
    () =>
      Effect.gen(function* () {
        const { at, fileSystem, json, text } = yield* machine();
        const codeReview = {
          adapter: "claude",
          kind: "skill",
          path: at("app/.claude/skills/code-review"),
          entry: "directory",
        };

        const envelope = yield* json(["project", "add", "app", "--repository-cwd", at("app")]);
        expect(envelope).toMatchObject({
          status: "success",
          diagnostics: [],
          applied: { kind: "project-registration", handMade: [codeReview] },
          next: ["tack catalog", "tack sync --project app"],
        });

        // A repeated registration changes nothing and still reports them.
        const output = yield* text(["project", "add", "app", "--repository-cwd", at("app")]);
        expect(output).toContain("Project app is already registered; nothing changed.");
        expect(output).toContain("Hand-made, left untouched");
        expect(output).toContain("folder · claude skill");
        expect(
          yield* fileSystem.readFileString(at("app/.claude/skills/code-review/SKILL.md")),
        ).toBe("mine\n");
      }),
  );

  handMadeIt.effect("project refresh lists the hand-made entries of a root it adds", () =>
    Effect.gen(function* () {
      const { at, fileSystem, json, text, addWorktree } = yield* machine();
      yield* json(["project", "add", "app", "--repository-cwd", at("app")]);
      addWorktree();
      const notes = {
        adapter: "claude",
        kind: "skill",
        path: at("app-wt/.claude/skills/notes.md"),
        entry: "file",
      };

      const preview = yield* text(["project", "refresh", "--project", "app"]);
      expect(preview).toContain("Hand-made, left untouched");
      expect(preview).toContain("file · claude skill");
      // The root refresh keeps has nothing new to report.
      expect(preview).not.toContain("code-review");

      const applied = yield* json(["project", "refresh", "--project", "app", "--apply"]);
      expect(applied).toMatchObject({
        status: "success",
        diagnostics: [],
        plan: { kind: "project-refresh-command-plan", handMade: [notes] },
      });
      expect(yield* fileSystem.readFileString(at("app-wt/.claude/skills/notes.md"))).toBe(
        "notes\n",
      );
      // Once the worktree is registered, refresh has no root to add and nothing to report.
      expect(yield* json(["project", "refresh", "--project", "app"])).toMatchObject({
        plan: { handMade: [] },
      });
    }),
  );
});
