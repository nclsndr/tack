import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { describeTree } from "../src/cli/commands/manifest.ts";
import { choicesOf, completeTack, valueSourceOf } from "../src/cli/host/completion.ts";
import { HostEnvironment } from "../src/cli/host/host-environment.ts";
import { guideTopics } from "../src/domain/guides/guide-schema.ts";
import type { GitService } from "../src/services/git.ts";
import { runHost } from "./support/host-runner.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { skillText, write } from "./support/source-tree.ts";

/*
 * Two sources, `team` and `me`, both provide the skill `review`; `team` also provides `lint` and the
 * docs `handbook`, `me` the skill `notes`. One project, `workspace`. Completion reads the grammar
 * from the command tree and the values from this state, as the host would.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-completion-test-" }),
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
  yield* write(path.join(team, "skills", "review", "SKILL.md"), skillText("review"));
  yield* write(path.join(team, "skills", "lint", "SKILL.md"), skillText("lint"));
  yield* write(path.join(me, "tack.yaml"), "version: 1\nname: me\nskills:\n  - path: skills\n");
  yield* write(path.join(me, "skills", "review", "SKILL.md"), skillText("review"));
  yield* write(path.join(me, "skills", "notes", "SKILL.md"), skillText("notes"));
  const git = {
    listWorktrees: () => Effect.succeed([{ bare: false, detached: false, path: projectRoot }]),
    resolveCommonDirectory: () => Effect.succeed(anchor),
  } satisfies GitService;
  const tack = (arguments_: ReadonlyArray<string>) =>
    runHost({ args: ["--state-dir", stateDirectory, ...arguments_], git });
  yield* tack(["state", "init"]);
  yield* tack(["source", "add", team]);
  yield* tack(["source", "add", me]);
  yield* tack(["project", "add", "workspace", "--repository-cwd", projectRoot]);
  /** The values completion offers for the last word `partial` after `words`, in this state. */
  const complete = (words: ReadonlyArray<string>, partial: string) =>
    completeTack(["--state-dir", stateDirectory, ...words], partial).pipe(
      Effect.map((candidates) => candidates.map((candidate) => candidate.value)),
      Effect.provideService(HostEnvironment, { HOME: root }),
    );
  return { root, complete };
});

it.layer(LiveTestLayer)("tack completion", (completionIt) => {
  completionIt.effect("offers the subcommands the grammar declares, with their descriptions", () =>
    Effect.gen(function* () {
      const { complete } = yield* fixture;
      const described = yield* completeTack(["source"], "re");

      expect(yield* complete([], "s")).toEqual(["script", "source", "sync", "status", "state"]);
      expect(yield* complete(["source"], "")).toEqual(["add", "relocate", "remove"]);
      expect(yield* complete(["script", "history"], "")).toEqual(["show", "clear"]);
      expect(described.map((candidate) => candidate.description)).toEqual([
        expect.stringContaining("new directory"),
        expect.stringContaining("Preview removing a registered source"),
      ]);
    }),
  );

  completionIt.effect("offers the flags a command accepts that the line has not used yet", () =>
    Effect.gen(function* () {
      const { complete } = yield* fixture;

      expect(yield* complete(["sync"], "--a")).toEqual(["--adapter", "--all", "--apply"]);
      expect(yield* complete(["sync", "--apply"], "--a")).toEqual(["--adapter", "--all"]);
      // The fixture's lines already carry `--state-dir`.
      expect(yield* complete(["state"], "--")).toEqual(["--json"]);
    }),
  );

  completionIt.effect("offers a choice flag's values and nothing for free text", () =>
    Effect.gen(function* () {
      const { complete } = yield* fixture;

      expect(yield* complete(["sync", "--adapter"], "c")).toEqual(["claude", "codex", "cursor"]);
      expect(yield* complete(["catalog", "--kind"], "")).toEqual([
        "skill",
        "command",
        "context",
        "script",
        "docs",
      ]);
      expect(yield* complete(["docs", "search"], "")).toEqual([]);
      expect(yield* complete(["project", "add"], "")).toEqual([]);
      expect(yield* complete(["doctor"], "")).toEqual([]);
    }),
  );

  completionIt.effect("reads projects, sources and references from the state", () =>
    Effect.gen(function* () {
      const { complete } = yield* fixture;

      expect(yield* complete(["sync", "--project"], "w")).toEqual(["workspace"]);
      expect(yield* complete(["project", "remove"], "")).toEqual(["workspace"]);
      expect(yield* complete(["source", "remove"], "")).toEqual(["me", "team"]);
      expect(yield* complete(["pick", "include"], "")).toEqual([
        "lint",
        "me:review",
        "notes",
        "team:review",
      ]);
      expect(yield* complete(["pick", "include", "--project", "workspace"], "te")).toEqual([
        "team:review",
      ]);
      expect(yield* complete(["docs", "attach"], "")).toEqual(["handbook"]);
      expect(yield* complete(["script", "run"], "")).toEqual([]);
      expect(yield* complete(["source", "relocate"], "")).toEqual([
        expect.stringMatching(uuid),
        expect.stringMatching(uuid),
      ]);
    }),
  );

  completionIt.effect("offers adapters, leaving out those a variadic operand already names", () =>
    Effect.gen(function* () {
      const { complete } = yield* fixture;

      expect(yield* complete(["adapter", "enable"], "")).toEqual(["claude", "codex", "cursor"]);
      expect(yield* complete(["adapter", "enable", "claude"], "")).toEqual(["codex", "cursor"]);
      expect(yield* complete(["adapter", "enable", "claude", "codex"], "")).toEqual(["cursor"]);
      expect(yield* complete(["adapter", "disable", "claude"], "")).toEqual([]);
    }),
  );

  completionIt.effect("offers the guides of the running Tack, in the order it lists them", () =>
    Effect.gen(function* () {
      const { complete } = yield* fixture;

      expect(yield* complete(["guide"], "")).toEqual([...guideTopics]);
      expect(yield* complete(["guide"], "o")).toEqual(["onboarding"]);
      expect(yield* complete(["guide", "onboarding"], "")).toEqual([]);
    }),
  );

  completionIt.effect("offers directories for a path, keeping a leading ~ as typed", () =>
    Effect.gen(function* () {
      const { root, complete } = yield* fixture;

      expect(yield* complete(["source", "add"], `${root}/t`)).toEqual([`${root}/team/`]);
      expect(yield* complete(["source", "add"], "~/m")).toEqual(["~/me/"]);
      expect(yield* complete(["source", "add"], "~/team/")).toEqual([
        "~/team/notes/",
        "~/team/skills/",
      ]);
      expect(yield* complete(["sync", "--cwd"], "~/nowhere/")).toEqual([]);
      expect(yield* complete(["check"], "no-such-folder-")).toEqual([]);
      expect(yield* complete(["profile", "inspect-bundle"], "~/team/")).toEqual([
        "~/team/notes/",
        "~/team/skills/",
        "~/team/tack.yaml",
      ]);
    }),
  );

  completionIt.effect("hides dot folders unless the word starts with a dot", () =>
    Effect.gen(function* () {
      const { root, complete } = yield* fixture;
      yield* (yield* FileSystem.FileSystem).makeDirectory(`${root}/.hidden`);

      expect(yield* complete(["source", "add"], "~/")).not.toContain("~/.hidden/");
      expect(yield* complete(["source", "add"], "~/.")).toEqual(["~/.hidden/"]);
    }),
  );

  completionIt.effect("skips a dangling link among the paths", () =>
    Effect.gen(function* () {
      const { root, complete } = yield* fixture;
      yield* (yield* FileSystem.FileSystem).symlink(`${root}/nowhere`, `${root}/dangling`);

      expect(yield* complete(["source", "add"], "~/d")).toEqual([]);
    }),
  );

  completionIt.effect("offers no state values when the state cannot be read", () =>
    Effect.gen(function* () {
      const { root } = yield* fixture;
      const offered = (words: ReadonlyArray<string>) =>
        completeTack(words, "").pipe(Effect.provideService(HostEnvironment, { HOME: root }));

      expect(yield* offered(["--state-dir", `${root}/missing`, "sync", "--project"])).toEqual([]);
      // Without --state-dir, completion reads the default state under the home, which is absent.
      expect(yield* offered(["sync", "--project"])).toEqual([]);
    }),
  );

  completionIt.effect("declares where the values of every operand and value flag come from", () =>
    Effect.gen(function* () {
      const tree = yield* describeTree();
      const undeclared = tree.flatMap(({ grammar }) => [
        ...grammar.arguments.flatMap((argument) =>
          valueSourceOf(grammar.commandPath, argument.name) === undefined
            ? [`${grammar.commandPath.join(" ")} <${argument.name}>`]
            : [],
        ),
        ...grammar.flags.flatMap((flag) =>
          flag.type !== "boolean" &&
          choicesOf(flag) === undefined &&
          valueSourceOf(grammar.commandPath, `--${flag.name}`) === undefined
            ? [`${grammar.commandPath.join(" ")} --${flag.name}`]
            : [],
        ),
      ]);

      expect(undeclared).toEqual([]);
    }),
  );
});
