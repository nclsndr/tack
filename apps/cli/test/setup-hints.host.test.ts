import { skillText } from "./support/source-tree.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { mutateStateFixture } from "./support/state-fixture.ts";
import { fakeGit, outsideRepositoryGit } from "./support/fake-git.ts";
import { inDirectory, runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";
import { hintsIn } from "./support/hints.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ExecutionPlatformLive } from "../src/platform/execution/execution-platform.ts";
import { DoctorReportSchema } from "../src/domain/doctor/doctor-schema.ts";
import { SyncPlanSchema } from "../src/domain/reconciliation/sync-schema.ts";
import type { PublicEnvelope } from "../src/cli/host/public-outcome.ts";
import type { GitService } from "../src/services/git.ts";
import type { TerminalContextShape } from "../src/cli/host/human/terminal-context.ts";

const pipe: TerminalContextShape = {
  columns: 120,
  environment: { TERM: "dumb" },
  stdinIsTerminal: false,
  stdoutIsTerminal: false,
};

/**
 * A temporary machine: a source of one skill, the repository `app` with a second worktree
 * `app-wt`, a repository `other` no project holds, and a folder `loose` outside any repository.
 * Git answers for whichever repository holds the directory it is asked about.
 */
const machine = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-setup-hints-" }),
  );
  const at = (name: string) => path.join(root, name);
  yield* Effect.forEach(
    ["home", "app/.git", "app/src", "app-wt/src", "other/.git", "loose", "source/skills/review"],
    (name) => fileSystem.makeDirectory(at(name), { recursive: true }),
  );
  yield* fileSystem.writeFileString(
    at("source/tack.yaml"),
    "version: 1\nname: source\nskills:\n  - path: skills\n",
  );
  yield* fileSystem.writeFileString(
    at("source/skills/review/SKILL.md"),
    skillText("review", { description: "Review a change", body: "" }),
  );
  const app = fakeGit(at("app/.git"), [{ path: at("app") }, { path: at("app-wt") }]);
  const other = fakeGit(at("other/.git"), [{ path: at("other") }]);
  const inside = (folder: string, cwd: string) =>
    cwd === at(folder) || cwd.startsWith(`${at(folder)}/`);
  const pick = (cwd: string): GitService =>
    inside("app", cwd) || inside("app-wt", cwd)
      ? app
      : inside("other", cwd)
        ? other
        : outsideRepositoryGit;
  const git: GitService = {
    listWorktrees: (cwd) => pick(cwd).listWorktrees(cwd),
    resolveCommonDirectory: (cwd) => pick(cwd).resolveCommonDirectory(cwd),
  };
  /** Runs `tack` from `cwd`, or from the test's own directory when it names none. */
  const json = (arguments_: ReadonlyArray<string>, cwd?: string) =>
    runHost({
      args: ["--json", "--state-dir", at("state"), ...arguments_],
      git,
      env: { HOME: at("home") },
    }).pipe(
      // Doctor reads the retained script runs.
      Effect.provide(ExecutionPlatformLive),
      Effect.map(({ stdout }) => decodeEnvelope(stdout)),
      cwd === undefined ? (effect) => effect : inDirectory(at(cwd)),
    );
  const text = (arguments_: ReadonlyArray<string>, cwd?: string) =>
    runHost({
      args: ["--state-dir", at("state"), ...arguments_],
      git,
      env: { HOME: at("home") },
      terminal: pipe,
    }).pipe(
      Effect.map(({ stdout }) => stdout),
      cwd === undefined ? (effect) => effect : inDirectory(at(cwd)),
    );
  expect((yield* json(["state", "init"])).status).toBe("success");
  return { at, json, text, state: { environment: { TACK_STATE_DIR: at("state") } } };
});

/** The `projects` check of a doctor envelope. */
const projectsCheckOf = (envelope: PublicEnvelope) =>
  Schema.decodeUnknownSync(DoctorReportSchema)(envelope.result).checks.find(
    ({ id }) => id === "projects",
  );

it.layer(LiveTestLayer)("setup hints", (hintIt) => {
  hintIt.effect("names the project add a bare selection needs in an unregistered repository", () =>
    Effect.gen(function* () {
      const { json, text } = yield* machine();
      for (const command of [["status"], ["sync"]]) {
        const envelope = yield* json(command, "other");
        expect(envelope).toMatchObject({
          status: "failure",
          diagnostics: [{ code: "bare-target-requires-registered-root" }],
          next: ["tack project add other"],
        });
        expect(envelope.diagnostics[0]?.message).toContain(
          "It is in a Git repository that no project registers.",
        );
      }
      expect(yield* json(["project", "refresh"], "other")).toMatchObject({
        diagnostics: [{ code: "bare-target-requires-registered-root" }],
        next: ["tack project add other"],
      });
      expect(yield* text(["status"], "other")).toContain("Next\n  tack project add other\n");
      expect(projectsCheckOf(yield* json(["doctor"], "other"))).toMatchObject({
        outcome: "warning",
        next: ["tack", "project", "add", "other", "--state-dir", expect.any(String)],
      });
      expect(projectsCheckOf(yield* json(["doctor"], "loose"))).toMatchObject({
        outcome: "skipped",
      });
      // Outside any repository there is nothing to register, so there is no command to name.
      expect(yield* json(["status"], "loose")).toMatchObject({
        diagnostics: [
          {
            code: "bare-target-requires-registered-root",
            message:
              "This directory is not inside a registered project. Choose --project NAME, --user or --all.",
          },
        ],
        next: [],
      });
    }),
  );

  hintIt.effect("names refresh in a new worktree, and sync once refresh has added it", () =>
    Effect.gen(function* () {
      const { at, json, state, text } = yield* machine();
      expect(yield* json(["project", "add", "app", "--repository-cwd", at("app")])).toMatchObject({
        status: "success",
      });
      // Registration recorded both worktrees; forget the second, as if Git reported it later.
      yield* mutateStateFixture(state, (current) => ({
        ...current,
        data: {
          ...current.data,
          projects: current.data.projects.map((project) => ({
            ...project,
            roots: project.roots.filter((root) => root !== at("app-wt")),
          })),
        },
      }));
      for (const command of [["status"], ["sync"]]) {
        const envelope = yield* json(command, "app-wt/src");
        expect(envelope).toMatchObject({
          diagnostics: [{ code: "bare-target-requires-registered-root" }],
          next: ["tack project refresh --apply"],
        });
        expect(envelope.diagnostics[0]?.message).toContain(
          "It is a worktree of project app that Tack has not registered yet.",
        );
      }

      expect(projectsCheckOf(yield* json(["doctor"], "app-wt/src"))).toMatchObject({
        outcome: "warning",
        subjects: ["app"],
        next: ["tack", "project", "refresh", "--project", "app", "--state-dir", expect.any(String)],
      });
      // Named by project, status no longer reports the project as healthy from that worktree.
      const status = yield* json(["status", "--project", "app"], "app-wt/src");
      expect(status).toMatchObject({
        classification: "partial",
        diagnostics: [
          {
            code: "worktree-not-registered",
            details: { projectName: "app", root: at("app-wt") },
            severity: "warning",
          },
        ],
      });
      expect(status.next[0]).toBe("tack project refresh --apply");
      expect(yield* text(["status", "--project", "app"], "app-wt/src")).toContain(
        "Next\n  tack project refresh --apply\n",
      );
      // Every project includes this one; another project or the user scope says nothing of it.
      expect((yield* json(["status", "--all"], "app-wt/src")).diagnostics).toContainEqual(
        expect.objectContaining({ code: "worktree-not-registered" }),
      );
      expect(
        yield* json(["project", "add", "second", "--repository-cwd", at("other")]),
      ).toMatchObject({ status: "success" });
      for (const selector of [["--project", "second"], ["--user"]])
        expect(
          (yield* json(["status", ...selector], "app-wt/src")).diagnostics.map(({ code }) => code),
        ).not.toContain("worktree-not-registered");

      const applied = yield* json(["project", "refresh", "--apply"], "app-wt/src");
      expect(applied).toMatchObject({ status: "success" });
      expect(applied.next).toEqual(["tack sync --project app", "tack sync --project app --apply"]);
      // A refresh that adds no root has nothing new to link.
      expect((yield* json(["project", "refresh", "--apply"], "app-wt/src")).next).toEqual([]);
      expect(yield* json(["status"], "app-wt/src")).toMatchObject({
        status: "success",
      });
    }),
  );

  hintIt.effect("says project add needs a repository, and how to name one", () =>
    Effect.gen(function* () {
      const { at, json, text } = yield* machine();
      expect(yield* json(["project", "add", "loose"], "loose")).toMatchObject({
        classification: "invalid-configuration",
        diagnostics: [
          {
            code: "repository-cwd-not-in-git",
            details: { path: at("loose") },
            message: "This directory is not inside a Git repository.",
          },
        ],
        next: ["tack project add loose --repository-cwd PATH"],
      });
      expect(yield* text(["project", "add", "loose"], "loose")).toContain(
        "Next\n  tack project add loose --repository-cwd PATH\n",
      );
    }),
  );

  hintIt.effect("points a registered source at the project it can be linked into", () =>
    Effect.gen(function* () {
      const { at, json } = yield* machine();
      // Inside a repository no project registers, register it by its folder's name, as project
      // add does from there; outside any repository, name the project and its path.
      expect((yield* json(["source", "add", at("source"), "--apply"], "other")).next).toEqual([
        "tack project add other",
      ]);
      expect((yield* json(["source", "add", at("source"), "--apply"], "loose")).next).toEqual([
        "tack project add NAME --repository-cwd PATH",
      ]);
      expect(yield* json(["project", "add", "app", "--repository-cwd", at("app")])).toMatchObject({
        status: "success",
      });
      expect((yield* json(["source", "add", at("source"), "--apply"], "loose")).next).toEqual([
        "tack sync --project app",
      ]);
      expect((yield* json(["source", "add", at("source"), "--apply"], "other")).next).toEqual([
        "tack project add other",
      ]);
      expect(
        yield* json(["project", "add", "second", "--repository-cwd", at("other")]),
      ).toMatchObject({ status: "success" });
      // With projects: the one holding the directory; outside every one of several, the list.
      expect((yield* json(["source", "add", at("source"), "--apply"], "other")).next).toEqual([
        "tack sync --project second",
      ]);
      expect((yield* json(["source", "add", at("source"), "--apply"], "loose")).next).toEqual([
        "tack project",
      ]);
    }),
  );

  hintIt.effect("leaves a project link out while the same agent links the skill for the user", () =>
    Effect.gen(function* () {
      const { at, json, text } = yield* machine();
      yield* json(["adapter", "enable", "claude"]);
      yield* json(["source", "add", at("source"), "--apply"]);
      yield* json(["project", "add", "app", "--repository-cwd", at("app")]);
      const unitOf = (envelope: PublicEnvelope, target: string) =>
        Schema.decodeUnknownSync(SyncPlanSchema)(envelope.plan).resources?.units.find(
          (unit) => unit.target._tag === target,
        );
      const linksReview = (envelope: PublicEnvelope) =>
        unitOf(envelope, "project-root")?.actions.some(
          (action) =>
            action._tag === "link-create" &&
            action.destinationPath === at("app/.claude/skills/review"),
        );
      expect(linksReview(yield* json(["sync", "--project", "app", "--apply"]))).toBe(true);
      yield* json(["pick", "include", "source:review", "--user"]);
      const review = { kind: "skill", name: "review" };

      // Every project sync and the sync of all projects leave it to the user's link, with no note.
      const all = yield* json(["sync", "--all"]);
      expect(all).toMatchObject({ classification: "success", diagnostics: [] });
      expect(unitOf(all, "project-root")).toMatchObject({
        actions: [{ _tag: "link-remove", reason: "linked-for-user" }],
        linkedForUser: [review],
      });
      expect(unitOf(all, "user")).not.toHaveProperty("linkedForUser");
      expect(yield* text(["sync", "--project", "app"])).toContain(
        "  remove  .claude/skills/review  skill review · linked-for-user\n" +
          "  skip    skill review           linked for the user\n",
      );
      yield* json(["sync", "--all", "--apply"]);
      const converged = yield* text(["sync", "--project", "app"]);
      expect(converged).toContain("Everything is up to date.");
      expect(converged).toContain("  skip  skill review  linked for the user\n");
      const status = yield* json(["status", "--project", "app"]);
      expect(status).toMatchObject({ classification: "success" });
      expect(status.result).toMatchObject({
        namespaces: [
          {
            undelivered: [{ adapter: "claude", address: review, reason: "linked-for-user" }],
          },
        ],
      });

      // Without the user pick, the next project sync links it into the project again.
      yield* json(["pick", "remove", "source:review", "--user"]);
      const restored = yield* json(["sync", "--project", "app"]);
      expect(unitOf(restored, "project-root")).not.toHaveProperty("linkedForUser");
      expect(linksReview(restored)).toBe(true);
    }),
  );

  hintIt.effect.each([
    {
      layout: "a skill at its root",
      files: ["SKILL.md"],
      suggests: undefined,
    },
    {
      layout: "flat skill folders",
      files: ["review/SKILL.md", "notes.md"],
      suggests: '{"version":1,"name":"skills-folder","kind":"skills"}',
    },
    {
      layout: "a skills folder",
      files: ["skills/review/SKILL.md"],
      suggests: '{"version":1,"name":"skills-folder","skills":[{"path":"skills"}]}',
    },
    {
      layout: "a skills folder beside a commands folder",
      files: ["skills/review/SKILL.md", "commands/ship.md"],
      suggests:
        '{"version":1,"name":"skills-folder","skills":[{"path":"skills"}],"commands":[{"path":"commands"}]}',
    },
  ])("names what to run for a folder of $layout without tack.yaml", ({ files, suggests }) =>
    Effect.gen(function* () {
      const { at, json, text } = yield* machine();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* Effect.forEach(files, (file) =>
        fileSystem
          .makeDirectory(path.dirname(at(`skills-folder/${file}`)), { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(
                at(`skills-folder/${file}`),
                "---\nname: review\ndescription: Review a change\n---\n",
              ),
            ),
          ),
      );
      const folder = at("skills-folder");
      const commands = suggests === undefined ? [] : ["tack guide tack-yaml"];
      const remedy =
        suggests === undefined
          ? `${folder} holds SKILL.md, so it is one skill, not a folder of skills. Register the folder that holds it, or import it into a source with tack import add.`
          : `Write its tack.yaml as JSON and preview it with tack source add ${folder} --config 'JSON', or --config - to read it from standard input; tack guide tack-yaml lists every key. Its layout suggests ${suggests}.`;
      const checked = yield* json(["check", folder]);
      expect(checked).toMatchObject({
        classification: "success",
        next: commands,
        result: {
          checks: [{ kind: "source", path: folder, details: [] }],
          findings: [
            {
              code: "check-not-a-source",
              file: folder,
              message: "No tack.yaml: this folder is not a Tack source yet.",
              remedy,
              severity: "warning",
            },
          ],
        },
      });
      expect(hintsIn(yield* text(["check", folder]))).toEqual(commands);
      // check and a bare source add on the same folder give the same advice.
      if (suggests !== undefined) {
        const added = yield* json(["source", "add", folder, "--apply"]);
        expect(added.next).toEqual(commands);
        expect(added.diagnostics).toEqual([
          expect.objectContaining({
            code: "declaration-config-required",
            message: `${folder} has no tack.yaml. ${remedy}`,
          }),
        ]);
      }
    }),
  );

  hintIt.effect("keeps checking a folder of Markdown alone as docs", () =>
    Effect.gen(function* () {
      const { at, json } = yield* machine();
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(at("loose/guide.md"), "# Guide\n");
      const checked = yield* json(["check", at("loose")]);
      expect(checked.next).toEqual([]);
      expect(checked.result).toMatchObject({
        checks: [{ kind: "docs", path: at("loose/guide.md") }],
        findings: [],
      });
    }),
  );
});
