import { skillText } from "../../../test/support/source-tree.ts";
import { mutateStateFixture } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { initializeState, type StateOptions } from "../../services/state-store.ts";
import { registerSource } from "../sources/source.ts";
import { enableAdapters } from "../reconciliation/agent.ts";
import { runStatus } from "./status.ts";

/**
 * A home whose `.claude/skills` is an alias of `.agents/skills`, and a source in the folder `My Notes`,
 * which no source label can spell, declared as `notes`, with the user-default skill `valid`.
 */
const world = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-status-" }));
  const home = path.join(root, "home");
  const source = path.join(root, "My Notes");
  const options = {
    environment: { TACK_STATE_DIR: path.join(root, "state") },
    homeDirectory: home,
  } satisfies StateOptions;
  yield* fs.makeDirectory(path.join(source, "skills", "valid"), { recursive: true });
  yield* fs.writeFileString(
    path.join(source, "tack.yaml"),
    "version: 1\nname: notes\nskills:\n  - path: skills\n",
  );
  yield* fs.writeFileString(
    path.join(source, "skills", "valid", "SKILL.md"),
    skillText("valid", { tack: ["user-activation: default"], body: "" }),
  );
  yield* fs.makeDirectory(path.join(home, ".agents", "skills"), { recursive: true });
  yield* fs.makeDirectory(path.join(home, ".claude"), { recursive: true });
  yield* fs.symlink(path.join("..", ".agents", "skills"), path.join(home, ".claude", "skills"));
  yield* initializeState(options);
  const registered = yield* registerSource(options, { sourcePath: source });
  yield* enableAdapters(options, ["claude", "codex"]);
  const evidenceFor = (adapter: "claude" | "codex") => ({
    adapter,
    address: {
      kind: "skill" as const,
      name: "valid",
      sourceRegistrationId: registered.registration.id,
    },
    sourceDirectoryPath: path.join(source, "skills", "valid"),
    sourceRegistrationId: registered.registration.id,
    target: { _tag: "user" as const, canonicalPath: home },
  });
  return { fs, path, root, home, source, options, evidenceFor };
});

const tagsOf = (report: Effect.Success<ReturnType<typeof runStatus>>) =>
  report.destinations.map((destination) => [
    destination.adapter,
    destination._tag,
    destination.sharing?.role,
  ]);

it.layer(LiveTestLayer)("status observation", (test) => {
  test.effect("classifies a shared alias destination by what the writing adapter finds", () =>
    Effect.gen(function* () {
      const { fs, path, home, options } = yield* world;
      const status = () => runStatus(options, { cwd: home, selector: { _tag: "user" } });
      const before = yield* status();
      expect(tagsOf(before)).toEqual([
        ["codex", "expected-absent", "writer"],
        ["claude", "expected-absent", "shared"],
      ]);
      // The declared name labels the source, whatever its folder is called.
      const registered = before.sources.find(({ registration }) =>
        registration.canonicalPath.endsWith("My Notes"),
      );
      expect(registered).toMatchObject({
        status: "healthy",
        label: "notes",
        labelOrigin: "declared",
      });

      const physical = path.join(home, ".agents", "skills", "valid");
      yield* fs.writeFileString(physical, "operator-owned\n");
      // Tack never linked here, so the entry is hand-made, for the adapter sharing the directory too.
      expect(tagsOf(yield* status())).toEqual([
        ["codex", "hand-made", "writer"],
        ["claude", "hand-made", "shared"],
      ]);
    }),
  );

  test.effect(
    "keeps an entry over a link Tack still owes the removal of foreign, not hand-made",
    () =>
      Effect.gen(function* () {
        const { fs, path, home, options, evidenceFor } = yield* world;
        yield* fs.writeFileString(
          path.join(home, ".agents", "skills", "valid"),
          "operator-owned\n",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            pendingRemovals: [
              {
                cause: "clean" as const,
                evidence: evidenceFor("codex"),
                lastResult: { _tag: "blocked" as const, message: "replacement present" },
              },
            ],
          },
        }));
        const report = yield* runStatus(options, { cwd: home, selector: { _tag: "user" } });
        expect(tagsOf(report)).toEqual([
          ["codex", "foreign-entry", "writer"],
          ["claude", "foreign-entry", "shared"],
        ]);
      }),
  );

  test.effect("keeps the record a shared adapter made before its directory became an alias", () =>
    Effect.gen(function* () {
      const { home, options, evidenceFor } = yield* world;
      // Both adapters linked the skill before `.claude/skills` became an alias.
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: { ...state.data, agentLinks: [evidenceFor("claude"), evidenceFor("codex")] },
      }));
      const report = yield* runStatus(options, { cwd: home, selector: { _tag: "user" } });
      // The first adapter holding a record writes the physical link; the other only shares it.
      expect(tagsOf(report)).toEqual([
        ["codex", "expected-absent", "shared"],
        ["claude", "expected-absent", "writer"],
      ]);
      expect(report.destinations.map((destination) => destination.evidence?.adapter)).toEqual([
        "codex",
        "claude",
      ]);
    }),
  );

  test.effect("reports a project root below a file as an unhealthy root", () =>
    Effect.gen(function* () {
      const { fs, path, root, options, evidenceFor } = yield* world;
      const file = path.join(root, "file");
      yield* fs.writeFileString(file, "not a directory\n");
      const blocked = path.join(file, "repo");
      const recorded = {
        ...evidenceFor("codex"),
        target: { _tag: "project-root" as const, canonicalPath: blocked, projectName: "demo" },
      };
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          projects: [
            { gitCommonDirectory: path.join(root, "git"), name: "demo", roots: [blocked] },
          ],
          agentLinks: [recorded],
        },
      }));
      const report = yield* runStatus(options, {
        cwd: root,
        selector: { _tag: "project", projectName: "demo" },
      });
      expect(report.projects[0]?.roots).toMatchObject([{ health: "unhealthy", path: blocked }]);
      // Only the recorded link is listed, and its target cannot be observed.
      expect(
        report.destinations.map((destination) => [destination._tag, destination.targetHealth]),
      ).toEqual([["observation-failed", "unhealthy"]]);
    }),
  );

  test.effect("reports an imports section that does not read as a problem of its source", () =>
    Effect.gen(function* () {
      const { fs, path, home, source, options } = yield* world;
      yield* fs.writeFileString(
        path.join(source, "tack.yaml"),
        "version: 1\nname: notes\nimports: []\nskills:\n  - path: skills\n",
      );
      const report = yield* runStatus(options, { cwd: home, selector: { _tag: "user" } });
      expect(report.imports).toMatchObject({
        total: 0,
        locallyChanged: 0,
        problems: [{ code: "imports-invalid", message: expect.stringContaining("line 3") }],
      });
    }),
  );
});
