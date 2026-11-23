import { skillText, write } from "./support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ExecutionPlatform } from "../src/services/execution-platform.ts";
import { type GitService } from "../src/services/git.ts";
import { withStateCheckpointWriter } from "../src/services/state-store.ts";
import { runHost } from "./support/host-runner.ts";
import { LiveTestLayer, provideTestFileSystem } from "./support/live-test-layer.ts";

/*
 * Fixture A of the state-format-5 spec: one source with 20 skills and one docs resource, and four
 * registered projects. Every command runs through the real host with a counting filesystem, so the
 * test asserts how often one invocation decodes `state.json` and resolves the catalog.
 */

const projectNames = ["p1", "p2", "p3", "p4"] as const;
const skillNames = Array.from({ length: 20 }, (_, index) => `skill-${index + 1}`);

type Counts = { stateReads: number; catalogResolutions: number };

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-command-snapshot-test-" }),
  );
  const stateDirectory = path.join(root, "state");
  const homeDirectory = path.join(root, "home");
  const source = path.join(root, "source");
  yield* fileSystem.makeDirectory(homeDirectory, { recursive: true });
  yield* write(
    path.join(source, "tack.yaml"),
    "version: 1\nname: team\nskills:\n  - path: skills\ndocs:\n  - name: handbook\n    path: notes\n",
  );
  yield* write(path.join(source, "notes", "guide.md"), "# Guide\n");
  yield* Effect.forEach(skillNames, (name) =>
    write(
      path.join(source, "skills", name, "SKILL.md"),
      skillText(name, { tack: ["activation: default"], body: "" }),
    ),
  );
  const projectRoot = (name: string) => path.join(root, "projects", name);
  const anchor = (name: string) => path.join(root, "anchors", name);
  yield* Effect.forEach(projectNames, (name) =>
    Effect.all([
      fileSystem.makeDirectory(projectRoot(name), { recursive: true }),
      fileSystem.makeDirectory(anchor(name), { recursive: true }),
    ]),
  );
  const git = {
    listWorktrees: (cwd) => Effect.succeed([{ bare: false, detached: false, path: cwd }]),
    resolveCommonDirectory: (cwd) => Effect.succeed(path.join(root, "anchors", path.basename(cwd))),
  } satisfies GitService;
  const counts: Counts = { stateReads: 0, catalogResolutions: 0 };
  const statePath = path.join(stateDirectory, "state.json");
  const probeSkill = path.join(source, "skills", "skill-1", "SKILL.md");
  /** Runs after each read of `state.json`, so a test can change the file between two reads. */
  const afterStateRead: { current: Effect.Effect<void, unknown> | undefined } = {
    current: undefined,
  };
  const counting: FileSystem.FileSystem = {
    ...fileSystem,
    readFileString: (target, encoding) => {
      if (target === statePath) {
        counts.stateReads += 1;
        const hook = afterStateRead.current;
        if (hook !== undefined)
          return fileSystem
            .readFileString(target, encoding)
            .pipe(Effect.tap(() => Effect.ignore(hook)));
      }
      // Resolving a catalog reads each skill document once, so one probe skill counts resolutions.
      if (target === probeSkill) counts.catalogResolutions += 1;
      return fileSystem.readFileString(target, encoding);
    },
  };
  /**
   * Runs one command, with `HOME` set to `home` when given, and returns the output with how often
   * it read state and the catalog.
   */
  const tack = (arguments_: ReadonlyArray<string>, home?: string) =>
    Effect.gen(function* () {
      counts.stateReads = 0;
      counts.catalogResolutions = 0;
      const { stdout } = yield* provideTestFileSystem(
        Effect.gen(function* () {
          const platform = yield* ExecutionPlatform;
          // The doctor report scans retained run history; the fixture retains none.
          return yield* runHost({
            args: ["--json", "--state-dir", stateDirectory, ...arguments_],
            git,
            ...(home === undefined ? {} : { env: { HOME: home } }),
          }).pipe(
            Effect.provideService(
              ExecutionPlatform,
              ExecutionPlatform.of({
                ...platform,
                listHistory: () => Effect.succeed({ runs: [], issues: [] }),
              }),
            ),
          );
        }),
        counting,
      );
      return {
        output: stdout,
        stateReads: counts.stateReads,
        catalogResolutions: counts.catalogResolutions,
      };
    });
  yield* tack(["state", "init"]);
  yield* tack(["source", "add", source, "--apply"]);
  yield* tack(["adapter", "enable", "claude"]);
  yield* Effect.forEach(projectNames, (name) =>
    tack(["project", "add", name, "--repository-cwd", projectRoot(name)]),
  );
  yield* Effect.forEach(projectNames, (name) =>
    tack(["docs", "attach", "handbook", "--project", name]),
  );
  return { tack, homeDirectory, statePath, stateDirectory, afterStateRead, fileSystem };
});

it.layer(LiveTestLayer)("one snapshot per command", (snapshotIt) => {
  const table: ReadonlyArray<readonly [ReadonlyArray<string>, string?]> = [
    [["catalog"]],
    [["status", "--all"]],
    [["pick", "include", "skill-1", "--project", "p1"]],
    [["sync", "--project", "p1"]],
    [["sync", "--all"]],
    [["sync", "--all", "--apply"]],
    [["doctor"]],
    [["project", "refresh", "--all"]],
  ];
  table.forEach(([command]) => {
    snapshotIt.effect(
      `reads state once and resolves the catalog once for tack ${command.join(" ")}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { tack, homeDirectory } = yield* fixture;
            const result = yield* tack(command, homeDirectory);
            expect(JSON.parse(result.output)).toHaveProperty("command");
            expect({
              stateReads: result.stateReads,
              catalogResolutions: result.catalogResolutions,
            }).toEqual({ stateReads: 1, catalogResolutions: 1 });
          }),
        ),
    );
  });

  const others: ReadonlyArray<ReadonlyArray<string>> = [
    ["source"],
    ["import"],
    ["project"],
    ["adapter"],
    ["adapter", "enable", "claude"],
    ["adapter", "disable", "claude"],
    ["docs", "--project", "p1"],
    ["docs", "target", "--project", "p1"],
    ["docs", "configure", "--project", "p1", "--destination", ".tack/mounts"],
    ["docs", "detach", "handbook", "--project", "p1"],
    ["docs", "search", "guide", "--project", "p1"],
    ["pick"],
    ["pick", "exclude", "skill-2", "--project", "p1"],
    ["pick", "remove", "skill-2", "--project", "p1"],
    ["state", "clean", "--all"],
    ["state", "clean", "--all", "--pending"],
    ["state", "reset"],
    ["script", "history"],
    ["sync", "--all", "--no-adapters"],
    ["project", "refresh", "--project", "p1", "--apply"],
  ];
  others.forEach((command) => {
    snapshotIt.effect(`reads state at most once for tack ${command.join(" ")}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { tack, homeDirectory } = yield* fixture;
          const result = yield* tack(command, homeDirectory);
          expect(JSON.parse(result.output)).toHaveProperty("command");
          // A write outdates the document, and `next` reads it again to label a resource it names.
          const writesAndNamesSource = command[0] === "docs" && command[1] === "configure";
          expect(result.stateReads).toBeLessThanOrEqual(writesAndNamesSource ? 2 : 1);
          expect(result.catalogResolutions).toBeLessThanOrEqual(writesAndNamesSource ? 2 : 1);
        }),
      ),
    );
  });

  snapshotIt.effect(
    "plans a preview from the one document it read, even if state changes meanwhile",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { tack, homeDirectory, statePath, afterStateRead, fileSystem } = yield* fixture;
          const original = yield* fileSystem.readFileString(statePath);
          const baseline = yield* tack(["sync", "--project", "p1"], homeDirectory);
          yield* tack(["pick", "exclude", "skill-1", "--project", "p1"]);
          const excluded = yield* fileSystem.readFileString(statePath);
          yield* fileSystem.writeFileString(statePath, original);
          // Another process excludes skill-1 right after the preview reads the document.
          afterStateRead.current = Effect.suspend(() => {
            afterStateRead.current = undefined;
            return fileSystem.writeFileString(statePath, excluded);
          });
          const raced = yield* tack(["sync", "--project", "p1"], homeDirectory);
          expect(
            JSON.parse(baseline.output).plan.resources.units[0].actions.length,
          ).toBeGreaterThan(0);
          // The hook ran, so the file did change after the preview's read.
          expect(afterStateRead.current).toBeUndefined();
          expect(raced.output).toBe(baseline.output);
        }),
      ),
  );

  snapshotIt.effect("fails a pick with state-busy while another writer holds the lock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tack, homeDirectory, statePath, stateDirectory, fileSystem } = yield* fixture;
        const before = yield* fileSystem.readFileString(statePath);
        const result = yield* withStateCheckpointWriter(
          { environment: { TACK_STATE_DIR: stateDirectory } },
          () => tack(["pick", "include", "skill-1", "--project", "p1"], homeDirectory),
        );
        expect(JSON.parse(result.output).diagnostics[0].code).toBe("state-busy");
        expect(yield* fileSystem.readFileString(statePath)).toBe(before);
      }),
    ),
  );
});
