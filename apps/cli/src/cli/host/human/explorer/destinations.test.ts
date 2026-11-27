import { skillText } from "../../../../../test/support/source-tree.ts";
import { fakeGit } from "../../../../../test/support/fake-git.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../../../test/support/live-test-layer.ts";
import { mutateStateFixture, stateOptionsAt } from "../../../../../test/support/state-fixture.ts";
import type { ResourceAddress } from "../../../../domain/sources/catalog-schema.ts";
import { enableAdapters } from "../../../../features/reconciliation/agent.ts";
import { registerSource } from "../../../../features/sources/source.ts";
import { Git } from "../../../../services/git.ts";
import { initializeState, readState } from "../../../../services/state-store.ts";
import type { RouteServices } from "../../routes/route.ts";
import { makeStyle } from "../style.ts";
import { loadExplorer } from "./editor.ts";
import { initialEditState } from "./edit.ts";
import { initialExplorerState } from "./model.ts";
import { makeExplorerDestinations } from "./profile-editor.ts";

/**
 * One source whose `review` skill requires a `helper` skill that no source has, two projects, and
 * the user selection including `review`.
 */
const workspace = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-dest-" }));
  const source = path.join(root, "source");
  const options = stateOptionsAt(path.join(root, "state"), root);
  yield* fs.makeDirectory(path.join(source, "skills", "review"), { recursive: true });
  yield* fs.writeFileString(
    path.join(source, "tack.yaml"),
    "version: 2\nname: tools\nskills: [{path: skills}]\n",
  );
  yield* fs.writeFileString(
    path.join(source, "skills", "review", "SKILL.md"),
    skillText("review", {
      description: "Review",
      tack: ["dependencies:", "  - kind: skill", "    name: helper"],
      body: "",
    }),
  );
  for (const project of ["demo", "other"]) yield* fs.makeDirectory(path.join(root, project));
  yield* initializeState(options);
  yield* registerSource(options, { sourcePath: source });
  yield* enableAdapters(options, ["claude"]);
  const style = makeStyle({ color: false, width: 140, homeDirectory: root });
  const review = (yield* loadExplorer(options, style, undefined)).entries.find(
    (entry) => entry.title === "review",
  )?.address;
  if (review?.kind !== "skill") throw new Error("Missing review fixture.");
  yield* mutateStateFixture(options, (state) => ({
    ...state,
    data: {
      ...state.data,
      userChoices: [{ address: review, decision: "include" }],
      projects: ["demo", "other"].map((name) => ({
        name,
        gitCommonDirectory: path.join(root, name, ".git"),
        roots: [path.join(root, name)],
      })),
    },
  }));
  const destinations = (cwd: string) =>
    Effect.gen(function* () {
      return yield* makeExplorerDestinations({
        stateOptions: options,
        style,
        cwd,
        context: yield* Effect.context<RouteServices>(),
      });
    });
  return { fs, path, root, source, options, review, destinations };
});

const initial = initialExplorerState("Tack explorer", []);

it.layer(LiveTestLayer)("explorer destinations", (test) => {
  test.effect("offers to save the selection of the project the session started in first", () =>
    Effect.gen(function* () {
      const { path, root, destinations } = yield* workspace();
      const copies = (cwd: string) =>
        Effect.map(destinations(cwd), (loaded) =>
          loaded.options
            .map((option) => option.label)
            .filter((label) => label.startsWith("User + project")),
        );
      expect(yield* copies(path.join(root, "other", "nested"))).toEqual([
        "User + project other (default)",
        "User + project demo (default)",
      ]);
      expect(yield* copies(path.join(root, "demo"))).toEqual([
        "User + project demo (default)",
        "User + project other (default)",
      ]);
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("offers browse only first, which leaves the edited destination read-only", () =>
    Effect.gen(function* () {
      const { root, destinations } = yield* workspace();
      const loaded = yield* destinations(root);
      expect(loaded.options[0]).toEqual({ label: "Browse only", destination: { _tag: "browse" } });
      const editing = {
        ...initial,
        cursor: 3,
        query: "rev",
        edit: initialEditState({ _tag: "project", projectName: "demo" }),
      };
      const opened = yield* loaded.open(editing, { _tag: "browse" });
      expect(opened.editor).toBeUndefined();
      expect(opened.state.edit).toBeUndefined();
      expect(opened.state).toMatchObject({ cursor: 0, query: "" });
      const review = opened.state.entries.find((entry) => entry.title === "review");
      expect(review).toBeDefined();
      expect(review?.activity).toBeUndefined();
      expect(review?.editable).toBeUndefined();
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("names a profile's members with glyphs and marks its own state line", () =>
    Effect.gen(function* () {
      const { fs, path, root, source, options, destinations } = yield* workspace();
      yield* fs.makeDirectory(path.join(source, "skills", "helper"));
      yield* fs.writeFileString(
        path.join(source, "skills", "helper", "SKILL.md"),
        skillText("helper", { description: "Helper", body: "" }),
      );
      yield* fs.makeDirectory(path.join(source, "profiles"));
      yield* fs.writeFileString(
        path.join(source, "profiles", "ci.yaml"),
        "version: 1\nname: ci\nmembers:\n  - review\n",
      );
      yield* fs.writeFileString(
        path.join(source, "tack.yaml"),
        "version: 2\nname: tools\nskills: [{path: skills}]\nprofiles: [{name: ci, path: profiles/ci.yaml}]\n",
      );
      const loaded = yield* destinations(root);
      expect(
        loaded.options.map(({ group, label, note }) => [group ?? "", label, note ?? ""]),
      ).toEqual([
        ["", "Browse only", ""],
        ["Daily selections", "User", ""],
        ["Daily selections", "Project demo", ""],
        ["Daily selections", "Project other", ""],
        ["Profiles", "tools/ci", ""],
        ["Profiles", "New profile in tools", ""],
        ["Save selection as profile", "User + project demo (default)", ""],
        ["Save selection as profile", "Project demo only", ""],
        ["Save selection as profile", "User + project other (default)", ""],
        ["Save selection as profile", "Project other only", ""],
        ["Save selection as profile", "User only", ""],
      ]);
      const opened = yield* loaded.open(initial, {
        _tag: "profile",
        sourcePath: source,
        profileName: "ci",
        create: false,
      });
      const byTitle = (title: string) =>
        opened.state.entries.find((entry) => entry.title === title);
      expect(byTitle("review")?.activity).toEqual({ active: true, reason: "member" });
      expect(byTitle("helper")?.activity).toEqual({ active: true, reason: "required" });
      expect(byTitle("review")?.tags).toEqual([]);
      expect(byTitle("review")?.facts).toContainEqual(["profiles", "› tools/ci  ● member"]);
      expect(byTitle("helper")?.facts).toContainEqual(["profiles", "› tools/ci  ● required"]);
      // Once ci is applied to other, the chooser says so on both sides.
      const registration = (yield* readState(options)).data.sources.find(
        (item) => item.canonicalPath === source,
      );
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          profileApplications: [
            {
              namespace: { _tag: "project", projectName: "other" },
              profileName: "ci",
              sourceRegistrationId: registration?.id ?? "",
              direct: [],
              inventory: [],
              targets: [],
            },
          ],
        },
      }));
      const fixed = (yield* destinations(root)).options;
      expect(fixed.find((option) => option.label === "Project other")?.note).toBe(
        "fixed by tools/ci (read-only)",
      );
      expect(fixed.find((option) => option.label === "tools/ci")?.note).toBe("applied to other");
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("refuses to continue a selection copy whose required closure is blocked", () =>
    Effect.gen(function* () {
      const { root, review, destinations } = yield* workspace();
      const opened = yield* (yield* destinations(root)).open(initial, {
        _tag: "copy",
        input: { user: true },
      });
      if (opened.editor === undefined) throw new Error("Expected a copy editor.");
      // The unresolved pick is left out of the copy until the operator adds it back explicitly.
      const pending = [{ kind: "member", address: review, included: true }] as const;
      const preview = yield* opened.editor.preview(pending);
      expect(preview[0]).toBe("Input: user");
      expect(preview).toContain(
        `skill ${review.sourceRegistrationId}:review · explicit adjustment`,
      );
      expect(preview).toContain(
        "profile-copy-required: Required closure is blocked. Repair missing/ambiguous dependencies before saving.",
      );
      const applied = yield* opened.editor.apply(pending);
      expect(applied.nextState).toBeUndefined();
      expect(applied.lines).toEqual(preview);
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect(
    "shows a seeded profile with a broken closure as incomplete and does not save it",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, source, review, destinations } = yield* workspace();
        const seed = [{ address: review, origins: ["user"] }] satisfies ReadonlyArray<{
          readonly address: ResourceAddress;
          readonly origins: ReadonlyArray<string>;
        }>;
        const opened = yield* (yield* destinations(root)).open(initial, {
          _tag: "profile",
          sourcePath: source,
          profileName: "copied",
          create: true,
          seed,
        });
        if (opened.editor === undefined) throw new Error("Expected a profile editor.");
        const preview = yield* opened.editor.preview([]);
        expect(preview[0]).toBe("Structure: valid · Source linkage: incomplete");
        expect(preview).toContain("skill review · user");
        const applied = yield* opened.editor.apply([]);
        expect(applied.entries).toBeUndefined();
        expect(applied.lines[0]).toBe("Structure: valid · Source linkage: incomplete");
        expect(yield* fs.exists(path.join(source, "profiles", "copied.yaml"))).toBe(false);
      }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("refuses a seed whose sources cannot get distinct portable names", () =>
    Effect.gen(function* () {
      const { fs, path, root, source, destinations } = yield* workspace();
      const options = stateOptionsAt(path.join(root, "state"), root);
      for (const directory of ["one", "two"]) {
        yield* fs.makeDirectory(path.join(root, directory));
        yield* fs.writeFileString(
          path.join(root, directory, "tack.yaml"),
          "version: 1\nname: team\ncommands: [{path: audit.md}]\n",
        );
        yield* fs.writeFileString(path.join(root, directory, "audit.md"), "Audit");
        yield* registerSource(options, { sourcePath: path.join(root, directory) });
      }
      const style = makeStyle({ color: false, width: 140, homeDirectory: root });
      const audit = (yield* loadExplorer(options, style, undefined)).entries.find(
        (entry) => entry.title === "audit",
      )?.address;
      if (audit === undefined) throw new Error("Missing audit fixture.");
      const refused = yield* (yield* destinations(root)).open(initial, {
        _tag: "profile",
        sourcePath: source,
        profileName: "copied",
        create: true,
        seed: [{ address: audit, origins: ["user"] }],
      });
      expect(refused.editor).toBeUndefined();
      expect(refused.state.preview?.title).toBe("Cannot change destination");
      expect(refused.state.preview?.lines.join(" ")).toContain("distinct portable names");
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );
});
