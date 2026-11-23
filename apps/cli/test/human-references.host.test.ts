import { skillText, write } from "./support/source-tree.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { type GitService } from "../src/services/git.ts";
import { runHost } from "./support/host-runner.ts";

/*
 * Two sources, `team` and `me`, both provide the skill `review`; `team` also provides `lint`, which
 * requires `notes` from `me` without declaring it, and the docs `handbook`. Every command runs
 * through the real host in human mode, so the references come from the catalog the host reads.
 */

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/;

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-human-references-test-" }),
  );
  const stateDirectory = path.join(root, "state");
  const anchor = path.join(root, "anchor");
  const projectRoot = path.join(root, "project");
  const team = path.join(root, "team");
  const me = path.join(root, "me");
  yield* Effect.forEach([anchor, projectRoot], (directory) =>
    fileSystem.makeDirectory(directory, { recursive: true }),
  );
  yield* write(
    path.join(team, "tack.yaml"),
    "version: 1\nname: team\nskills:\n  - path: skills\ndocs:\n  - name: handbook\n    path: notes\n",
  );
  yield* write(path.join(team, "notes", "guide.md"), "# Guide\n");
  yield* write(
    path.join(team, "skills", "review", "SKILL.md"),
    skillText("review", { tack: ["activation: default"], body: "" }),
  );
  yield* write(
    path.join(team, "skills", "lint", "SKILL.md"),
    skillText("lint", {
      tack: [
        "activation: default",
        "dependencies:",
        "  - kind: skill",
        "    name: notes",
        "    source: me",
      ],
      body: "",
    }),
  );
  yield* write(path.join(me, "tack.yaml"), "version: 1\nname: me\nskills:\n  - path: skills\n");
  yield* write(
    path.join(me, "skills", "review", "SKILL.md"),
    skillText("review", { tack: ["activation: default"], body: "" }),
  );
  yield* write(
    path.join(me, "skills", "notes", "SKILL.md"),
    skillText("notes", { tack: ["activation: default"], body: "" }),
  );
  const git = {
    listWorktrees: () => Effect.succeed([{ bare: false, detached: false, path: projectRoot }]),
    resolveCommonDirectory: () => Effect.succeed(anchor),
  } satisfies GitService;
  /** Runs one command and returns what the operator would read, without the exit result. */
  const tack = (arguments_: ReadonlyArray<string>) =>
    runHost({ args: ["--state-dir", stateDirectory, ...arguments_], git }).pipe(
      Effect.map(({ stdout }) => stdout),
    );
  yield* tack(["state", "init"]);
  yield* tack(["source", "add", team]);
  yield* tack(["source", "add", me]);
  yield* tack(["project", "add", "workspace", "--repository-cwd", projectRoot]);
  yield* tack(["adapter", "enable", "claude"]);
  return { tack };
});

it.layer(LiveTestLayer)("shortest references in human output", (referencesIt) => {
  referencesIt.effect("names a clashing resource by its source label and the rest by name", () =>
    Effect.gen(function* () {
      const { tack } = yield* fixture;
      const output = yield* tack(["catalog", "--kind", "skill"]);
      expect(output).toMatch(/^ {2}me:review +me\b/m);
      expect(output).toMatch(/^ {2}team:review +team\b/m);
      expect(output).toMatch(/^ {2}lint +team\b/m);
      expect(output).toMatch(/^ {2}notes +me\b/m);
      expect(output).not.toMatch(uuid);
      // A resource without tags ends its source cell, not a separator before the description.
      for (const line of output.slice(output.indexOf("Skills (")).split("\n"))
        expect(line).not.toMatch(/ ·( |$)/);
    }),
  );

  referencesIt.effect("keeps the project in every command a failed reference suggests", () =>
    Effect.gen(function* () {
      const { tack } = yield* fixture;
      const output = yield* tack(["pick", "include", "review", "--project", "workspace"]);
      expect(output.replace(/\n\s+/g, " ")).toContain(
        "review matches several resources. Use tack pick include me:review --project workspace or tack pick include team:review --project workspace.",
      );
      expect(output).not.toMatch(uuid);
      const user = yield* tack(["pick", "include", "review", "--user"]);
      expect(user.replace(/\n\s+/g, " ")).toContain("tack pick include me:review --user or");
    }),
  );

  referencesIt.effect("confirms a pick and lists it by reference, never by registration ID", () =>
    Effect.gen(function* () {
      const { tack } = yield* fixture;
      const set = yield* tack(["pick", "exclude", "me:review", "--project", "workspace"]);
      expect(set).toContain("Set skill me:review to exclude for project workspace.");
      expect(set).not.toMatch(uuid);
      yield* tack(["pick", "include", "lint", "--project", "workspace"]);
      const list = yield* tack(["pick", "--project", "workspace"]);
      expect(list).toMatch(/− exclude +skill me:review/);
      expect(list).toMatch(/\+ include +skill lint/);
      expect(list).not.toMatch(uuid);
      const removed = yield* tack(["pick", "remove", "me:review", "--project", "workspace"]);
      expect(removed).toContain("Removed the choice for skill me:review from project workspace.");
      expect(removed).not.toMatch(uuid);
    }),
  );

  referencesIt.effect("names one exclude command for each collision candidate", () =>
    Effect.gen(function* () {
      const { tack } = yield* fixture;
      const output = yield* tack(["sync", "--project", "workspace"]);
      expect(output).toMatch(
        /collision +review +needed by skill (me:review, skill team:review|team:review, skill me:review)/,
      );
      // The two candidates come in registration order, which is not a property under test.
      const next = output.slice(output.indexOf("Next\n")).split("\n");
      expect(next.slice(1, 3).sort()).toEqual([
        "  tack pick exclude me:review --kind skill --project workspace",
        "  tack pick exclude team:review --kind skill --project workspace",
      ]);
      expect(next[3]).toBe("  tack sync --project workspace --apply");
      expect(output).not.toMatch(uuid);
    }),
  );

  referencesIt.effect("says why a dependency is blocked and how to fix it", () =>
    Effect.gen(function* () {
      const { tack } = yield* fixture;
      const output = yield* tack(["sync", "--project", "workspace"]);
      const flat = output.replace(/\n {4}/g, " ");
      expect(flat).toContain(
        "lint needs skill me:notes, from a source that team does not declare. Add me to depends-on in the tack.yaml of team.",
      );
    }),
  );

  referencesIt.effect("attaches docs and lists them by reference", () =>
    Effect.gen(function* () {
      const { tack } = yield* fixture;
      const attached = yield* tack(["docs", "attach", "handbook", "--project", "workspace"]);
      expect(attached).toMatch(/attached +handbook/);
      expect(attached).not.toMatch(/\bsource [0-9a-f-]{36}/);
      const listed = yield* tack(["docs", "--project", "workspace"]);
      expect(listed).toContain("✓ available");
      expect(listed).toMatch(/^ {2}✓ available {2}handbook$/m);
      expect(listed).toMatch(/^ {4}source +team$/m);
      expect(listed).toMatch(/^ {2}! unmounted +handbook$/m);
    }),
  );

  referencesIt.effect("names the docs mount folder for .gitignore once docs are attached", () =>
    Effect.gen(function* () {
      const { tack } = yield* fixture;
      const details = ["status", "--project", "workspace", "--details"];
      expect(yield* tack(details)).not.toMatch(/^\/\.tack\/$/m);
      yield* tack(["docs", "attach", "handbook", "--project", "workspace"]);
      expect(yield* tack(details)).toMatch(
        /^For \.gitignore in project workspace\n(?:.*\n)*\/\.tack\/$/m,
      );
    }),
  );
});
