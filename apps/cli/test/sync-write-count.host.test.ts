import { skillText, write } from "./support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { type GitService } from "../src/services/git.ts";
import { readState } from "../src/services/state-store.ts";
import { runHost } from "./support/host-runner.ts";
import { LiveTestLayer, provideTestFileSystem } from "./support/live-test-layer.ts";
import { stateOptionsAt } from "./support/state-fixture.ts";

/*
 * One `sync --all --apply` writes the state document twice however many links it creates: once to
 * prepare the batch and once to settle it. The count is taken through the real host, so it covers
 * everything the command does, not only the apply.
 */

const fixture = (skillCount: number, withDocs = false) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-sync-write-count-" }),
    );
    const stateDirectory = path.join(root, "state");
    const homeDirectory = path.join(root, "home");
    const source = path.join(root, "source");
    const projectRoot = path.join(root, "projects", "p1");
    yield* fileSystem.makeDirectory(homeDirectory, { recursive: true });
    yield* fileSystem.makeDirectory(projectRoot, { recursive: true });
    yield* fileSystem.makeDirectory(path.join(root, "anchors", "p1"), { recursive: true });
    yield* write(
      path.join(source, "tack.yaml"),
      `version: 1\nname: team\nskills:\n  - path: skills\n${withDocs ? "docs:\n  - name: handbook\n    path: knowledge\n" : ""}`,
    );
    if (withDocs) yield* write(path.join(source, "knowledge", "hello.md"), "# Hello\n");
    yield* Effect.forEach(
      Array.from({ length: skillCount }, (_, index) => `skill-${String(index).padStart(4, "0")}`),
      (name) =>
        write(
          path.join(source, "skills", name, "SKILL.md"),
          skillText(name, { tack: ["activation: default"], body: "" }),
        ),
    );
    const git = {
      listWorktrees: (cwd) => Effect.succeed([{ bare: false, detached: false, path: cwd }]),
      resolveCommonDirectory: (cwd) =>
        Effect.succeed(path.join(root, "anchors", path.basename(cwd))),
    } satisfies GitService;
    const statePath = path.join(stateDirectory, "state.json");
    let stateWrites = 0;
    const counting: FileSystem.FileSystem = {
      ...fileSystem,
      rename: (fromPath, toPath) => {
        if (toPath === statePath) stateWrites += 1;
        return fileSystem.rename(fromPath, toPath);
      },
    };
    /** Runs one command, with `HOME` set to `home` when given, and counts its state writes. */
    const tack = (arguments_: ReadonlyArray<string>, home?: string) =>
      Effect.gen(function* () {
        stateWrites = 0;
        const { stdout } = yield* provideTestFileSystem(
          runHost({
            args: ["--json", "--state-dir", stateDirectory, ...arguments_],
            git,
            ...(home === undefined ? {} : { env: { HOME: home } }),
          }),
          counting,
        );
        return { output: stdout, stateWrites };
      });
    yield* tack(["state", "init"]);
    yield* tack(["source", "add", source, "--apply"]);
    yield* tack(["adapter", "enable", "claude"]);
    yield* tack(["project", "add", "p1", "--repository-cwd", projectRoot]);
    if (withDocs) yield* tack(["docs", "attach", "handbook", "--project", "p1"]);
    return { homeDirectory, stateDirectory, tack };
  });

it.layer(LiveTestLayer)("sync --all --apply writes state a fixed number of times", (writesIt) => {
  for (const count of [100, 200, 400, 800]) {
    writesIt.effect(
      `writes state exactly twice for ${count} skills, and not at all when nothing is left to do`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { homeDirectory, stateDirectory, tack } = yield* fixture(count);
            const first = yield* tack(["sync", "--all", "--apply"], homeDirectory);
            expect(JSON.parse(first.output)).toMatchObject({ command: "sync", status: "success" });
            expect(first.stateWrites).toBe(2);

            const state = yield* readState(stateOptionsAt(stateDirectory, homeDirectory));
            expect(state.data.journal).toBeUndefined();
            // The project and the user target each hold every skill.
            expect(state.data.links.length).toBeGreaterThanOrEqual(count);

            const second = yield* tack(["sync", "--all", "--apply"], homeDirectory);
            expect(JSON.parse(second.output)).toMatchObject({ command: "sync", status: "success" });
            expect(second.stateWrites).toBe(0);
          }),
        ),
      { timeout: 300_000 },
    );
  }
});

it.layer(LiveTestLayer)("a mixed sync of agent links and docs mounts", (mixedIt) => {
  mixedIt.effect(
    "writes state exactly twice for both kinds together, and not at all when nothing is left",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { homeDirectory, stateDirectory, tack } = yield* fixture(20, true);
          const first = yield* tack(["sync", "--all", "--apply"], homeDirectory);
          expect(JSON.parse(first.output)).toMatchObject({ command: "sync", status: "success" });
          expect(first.stateWrites).toBe(2);

          const state = yield* readState(stateOptionsAt(stateDirectory, homeDirectory));
          expect(state.data.journal).toBeUndefined();
          expect(state.data.links.filter((link) => link.delivery._tag === "docs")).toHaveLength(1);
          expect(
            state.data.links.filter((link) => link.delivery._tag === "agent").length,
          ).toBeGreaterThanOrEqual(20);

          const second = yield* tack(["sync", "--all", "--apply"], homeDirectory);
          expect(JSON.parse(second.output)).toMatchObject({ command: "sync", status: "success" });
          expect(second.stateWrites).toBe(0);
        }),
      ),
    { timeout: 120_000 },
  );
});
