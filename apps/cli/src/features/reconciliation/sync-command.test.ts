import { skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { mutateStateFixture, stateOptionsAt } from "../../../test/support/state-fixture.ts";
import { initializeState, type StateOptions } from "../../services/state-store.ts";
import { attachDocs } from "../docs/docs.ts";
import { enableAdapters } from "./agent.ts";
import { registerSource } from "../sources/source.ts";
import { runSyncCommand } from "./sync-command.ts";

it.layer(LiveTestLayer)("combined sync", (test) => {
  test.effect("previews and applies resource links and docs mounts under one selector", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-sync-" }));
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const source = path.join(root, "source");
      yield* fs.makeDirectory(home);
      yield* fs.makeDirectory(project);
      yield* fs.makeDirectory(path.join(source, "skills", "review"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "knowledge"));
      yield* fs.writeFileString(
        path.join(source, "tack.yaml"),
        "version: 1\nname: source\nskills:\n  - path: skills\ndocs:\n  - name: handbook\n    path: knowledge\n",
      );
      yield* fs.writeFileString(
        path.join(source, "skills", "review", "SKILL.md"),
        skillText("review", { description: "Review", tack: ["activation: default"], body: "" }),
      );
      yield* fs.writeFileString(path.join(source, "knowledge", "start.md"), "# Start\n");
      const options: StateOptions = stateOptionsAt(path.join(root, "state"), home);
      yield* initializeState(options);
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          projects: [
            { name: "demo", gitCommonDirectory: path.join(root, "git"), roots: [project] },
          ],
        },
      }));
      yield* registerSource(options, { sourcePath: source });
      yield* attachDocs(options, { projectName: "demo" }, { reference: "handbook" });
      yield* enableAdapters(options, ["codex"]);
      const request = {
        apply: false,
        cwd: project,
        selector: { _tag: "project" as const, projectName: "demo" },
        includeOptional: false,
        noDocs: false,
      };
      const preview = yield* runSyncCommand(options, request);
      expect(
        preview.plan.resources?.plan.units
          .flatMap((unit) => unit.actions)
          .some((action) => {
            return action._tag === "link-create";
          }),
      ).toBe(true);
      expect(
        preview.plan.docs
          .flatMap((entry) => entry.actions)
          .some((action) => action.action === "create"),
      ).toBe(true);
      const docsPath = preview.plan.docs
        .flatMap((entry) => entry.actions)
        .find((action) => action.action === "create")?.evidence.destinationPath;
      expect(docsPath).toBeDefined();
      if (docsPath === undefined) throw new Error("Expected a docs mount action.");
      expect(yield* fs.exists(path.join(project, ".agents", "skills", "review"))).toBe(false);
      expect(yield* fs.exists(docsPath)).toBe(false);
      const applied = yield* runSyncCommand(options, { ...request, apply: true });
      expect(applied.applied?.docs.length).toBe(1);
      expect(yield* fs.readLink(path.join(project, ".agents", "skills", "review"))).toBeDefined();
      expect(yield* fs.readLink(docsPath)).toBeDefined();
      const again = yield* runSyncCommand(options, { ...request, apply: true });
      expect(
        again.plan.docs
          .flatMap((entry) => entry.actions)
          .every((action) => action.action === "keep"),
      ).toBe(true);
      const docsOnly = yield* runSyncCommand(options, {
        ...request,
        adapterOverride: [],
        apply: false,
      });
      expect(docsOnly.plan.resources).toBeUndefined();
      const linksOnly = yield* runSyncCommand(options, { ...request, noDocs: true });
      expect(linksOnly.plan.docs).toEqual([]);

      // A docs mount that owes its removal is reported for the synced project, unless docs are left out.
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          links: state.data.links.map((record) =>
            record.delivery._tag === "docs"
              ? { ...record, removal: { cause: "clean" as const } }
              : record,
          ),
        },
      }));
      const owed = yield* runSyncCommand(options, request);
      expect(owed.plan.docsPending.map((pending) => pending.evidence.destinationPath)).toEqual([
        docsPath,
      ]);
      expect(
        (yield* runSyncCommand(options, { ...request, noDocs: true })).plan.docsPending,
      ).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
