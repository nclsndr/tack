import { fakeGit } from "../../../test/support/fake-git.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { mutateStateFixture, stateOptionsAt } from "../../../test/support/state-fixture.ts";
import type { Namespace } from "../../domain/choices/choice-schema.ts";
import { enableAdapters } from "../../features/reconciliation/agent.ts";
import { registerSource } from "../../features/sources/source.ts";
import { SourceLive } from "../../features/sources/source-live.ts";
import { Git } from "../../services/git.ts";
import { initializeState, readState } from "../../services/state-store.ts";
import type { RouteServices } from "../envelope/route-services.ts";
import { skillText, write } from "../../../test/support/source-tree.ts";
import { makeStyle } from "../human/style.ts";
import type { PendingChange } from "./edit.ts";
import { loadExplorer, makeExplorerEditor } from "./editor.ts";

/** The state block: the `user`, `projects` and `profiles` groups and their continuation lines. */
const stateLines = (facts: ReadonlyArray<readonly [string, string]>) => {
  const groups = new Set(["user", "projects", "profiles", ""]);
  const start = facts.findIndex(([label]) => label !== "" && groups.has(label));
  const end = facts.findIndex(([label], index) => index > start && groups.has(label) === false);
  return start < 0 ? [] : facts.slice(start, end < 0 ? undefined : end);
};

/**
 * One state line: the edited marker, the destination, its state, and where the state comes from.
 * States pad to the widest state of the resource's block.
 */
const stateLine = (edited: boolean, name: string, state: string, note = "", width = 14) =>
  `${edited ? "›" : " "} ${name.padEnd(11)}  ${note === "" ? state : `${state.padEnd(width)}  ${note}`}`;

/** A registered source with one skill and one docs folder, a project and the claude adapter. */
const workspace = Effect.fnUntraced(function* (adapters: ReadonlyArray<"claude"> = ["claude"]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-editor-" }));
  const source = path.join(root, "source");
  const project = path.join(root, "demo");
  const options = stateOptionsAt(path.join(root, "state"), root);
  yield* fs.makeDirectory(path.join(source, "skills", "review"), { recursive: true });
  yield* fs.makeDirectory(path.join(source, "knowledge"), { recursive: true });
  yield* fs.makeDirectory(project, { recursive: true });
  yield* fs.writeFileString(
    path.join(source, "tack.yaml"),
    "version: 1\nname: source\nskills:\n  - path: skills\ndocs:\n  - name: handbook\n    path: knowledge\n",
  );
  yield* fs.writeFileString(path.join(source, "knowledge", "hello.md"), "# Hello\n");
  yield* fs.writeFileString(
    path.join(source, "skills", "review", "SKILL.md"),
    skillText("review", { description: "Review a change.", body: "# Review\n" }),
  );
  yield* initializeState(options);
  yield* registerSource(options, { sourcePath: source });
  if (adapters.length > 0) yield* enableAdapters(options, adapters);
  yield* mutateStateFixture(options, (state) => ({
    ...state,
    data: {
      ...state.data,
      projects: [{ name: "demo", gitCommonDirectory: path.join(root, "git"), roots: [project] }],
    },
  }));
  const style = makeStyle({ color: false, width: 140, homeDirectory: root });
  const editorFor = (namespace: Namespace) =>
    Effect.gen(function* () {
      const loaded = yield* loadExplorer(options, style, namespace);
      const review = loaded.entries.find((entry) => entry.title === "review")?.address;
      const handbook = loaded.entries.find((entry) => entry.title === "handbook")?.address;
      if (review?.kind !== "skill" || handbook?.kind !== "docs")
        throw new Error("Missing fixture resources.");
      const editor = makeExplorerEditor({
        stateOptions: options,
        namespace,
        style,
        cwd: root,
        context: yield* Effect.context<RouteServices>(),
      });
      return { editor, review, handbook };
    });
  return { fs, path, root, source, project, options, style, editorFor };
});

it.layer(LiveTestLayer)("explorer editor", (test) => {
  test.effect("previews and applies an exclude that unlinks, then an unset that restores", () =>
    Effect.gen(function* () {
      const { fs, path, root, editorFor } = yield* workspace();
      const userLink = path.join(root, ".claude", "skills", "review");
      const { editor, review } = yield* editorFor({ _tag: "user" });
      const include: PendingChange = { kind: "choice", address: review, decision: "include" };
      const exclude: PendingChange = { kind: "choice", address: review, decision: "exclude" };
      const unset: PendingChange = { kind: "choice", address: review, decision: "unset" };
      yield* editor.apply([include]);
      expect(yield* fs.exists(userLink)).toBe(true);

      const preview = yield* editor.preview([exclude]);
      // The user then links nothing of the source, so its sources skill is unlinked too.
      expect(preview).toContain("claude → user: 2 to remove");
      expect(preview).toContain(
        "  unlink      .claude/skills/review  skill source:review (deselected)",
      );
      yield* editor.apply([exclude]);
      expect(yield* fs.exists(userLink)).toBe(false);

      const restored = yield* editor.apply([unset]);
      expect(restored.lines).toContain("saved   reset skill source:review");
      expect(restored.entries).toBeDefined();
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("groups each resource's state by user, projects and profiles", () =>
    Effect.gen(function* () {
      const { path, root, source, options, style } = yield* workspace();
      const skill = (name: string, ...tack: ReadonlyArray<string>) =>
        write(path.join(source, "skills", name, "SKILL.md"), skillText(name, { tack }));
      yield* skill("lint", "dependencies:", "  - kind: skill", "    name: format");
      yield* skill("format", "activation: opt-in");
      yield* skill("notes", "activation: opt-in");
      yield* skill("shared", "activation: opt-in");
      yield* skill("deploy", "projects: [other]");
      yield* skill("broken", "dependencies:", "  - kind: skill", "    name: absent");
      yield* skill("twin");
      // The source publishes the profile that other is fixed to, and one with no file, left out.
      yield* write(
        path.join(source, "tack.yaml"),
        "version: 1\nname: source\nskills:\n  - path: skills\ndocs:\n  - name: handbook\n    path: knowledge\nprofiles:\n  - name: team\n    path: profiles/team.yaml\n  - name: broken\n    path: profiles/broken.yaml\n",
      );
      yield* write(
        path.join(source, "profiles", "team.yaml"),
        "version: 1\nname: team\nmembers:\n  - notes\n  - lint\n",
      );
      // A same-name skill in another source, included in demo, supersedes the default twin.
      const extra = path.join(root, "extra");
      yield* write(
        path.join(extra, "tack.yaml"),
        "version: 1\nname: extra\nskills:\n  - path: skills\n",
      );
      yield* write(path.join(extra, "skills", "twin", "SKILL.md"), skillText("twin"));
      yield* registerSource(options, { sourcePath: extra });
      const sources = (yield* readState(options)).data.sources;
      const registration = sources.find((item) => item.canonicalPath === source);
      const extraRegistration = sources.find((item) => item.canonicalPath === extra);
      const address = (name: string, sourceRegistrationId = registration?.id ?? "") =>
        ({ kind: "skill", name, sourceRegistrationId }) as const;
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          userChoices: [
            { address: address("shared"), decision: "include" as const },
            { address: address("lint"), decision: "include" as const },
          ],
          projects: [
            ...state.data.projects.map((project) => ({
              ...project,
              choices: [
                { address: address("review"), decision: "exclude" as const },
                { address: address("notes"), decision: "include" as const },
                {
                  address: address("twin", extraRegistration?.id),
                  decision: "include" as const,
                },
              ],
            })),
            {
              name: "other",
              gitCommonDirectory: path.join(root, "git-other"),
              roots: [path.join(root, "other")],
              removingRoots: [],
            },
          ],
          // A fixed profile owns other: only its members are delivered there.
          profileApplications: [
            {
              namespace: { _tag: "project", projectName: "other" },
              profileName: "team",
              sourceRegistrationId: registration?.id ?? "",
              direct: [address("notes"), address("lint")],
              inventory: [address("notes"), address("lint"), address("format")],
              targets: [],
            },
          ],
        },
      }));
      const { entries } = yield* loadExplorer(options, style, {
        _tag: "project",
        projectName: "demo",
      });
      const byTitle = (title: string) =>
        entries.find(
          (entry) =>
            entry.title === title && entry.address?.sourceRegistrationId !== extraRegistration?.id,
        );
      expect(
        [
          "review",
          "notes",
          "lint",
          "format",
          "shared",
          "deploy",
          "broken",
          "twin",
          "use-tack",
          "handbook",
        ].map((title) => [title, byTitle(title)?.activity]),
      ).toEqual([
        ["review", { active: false, reason: "excluded" }],
        ["notes", { active: true, reason: "included" }],
        // The project selects it too, and sync leaves it to the user's link.
        ["lint", { active: true, reason: "default", viaUser: true }],
        ["format", { active: true, reason: "dependency", viaUser: true }],
        // The user scope delivers it, and every project's agent loads the user's skills.
        ["shared", { active: false, reason: "opt-in", viaUser: true }],
        ["deploy", { active: false, reason: "other project" }],
        ["broken", { active: false, reason: "blocked" }],
        ["twin", { active: false, reason: "superseded" }],
        ["use-tack", { active: false, reason: "locked", viaUser: true }],
        ["handbook", { active: false, reason: "detached" }],
      ]);
      const lines = (title: string) => stateLines(byTitle(title)?.facts ?? []);
      expect(byTitle("review")?.facts).toContainEqual(["address", "skill source:review"]);
      expect(byTitle("review")?.facts).toContainEqual([
        "activation",
        "project default · user opt-in",
      ]);
      expect(byTitle("review")?.facts.map(([label]) => label)).not.toContain("user activation");
      expect(byTitle("review")?.facts.map(([label]) => label)).not.toContain("choices");
      expect(lines("review")).toEqual([
        ["user", stateLine(false, "", "○ opt-in")],
        ["projects", stateLine(true, "demo", "○ excluded", "pick")],
        ["", stateLine(false, "other", "○ not a member", "fixed by source/team")],
        ["profiles", stateLine(false, "source/team", "○ not a member", "applied to other")],
      ]);
      expect(lines("notes")).toEqual([
        ["user", stateLine(false, "", "○ opt-in")],
        ["projects", stateLine(true, "demo", "● included", "pick", 10)],
        ["", stateLine(false, "other", "● member", "fixed by source/team", 10)],
        ["profiles", stateLine(false, "source/team", "● member", "applied to other", 10)],
      ]);
      expect(lines("format")).toContainEqual([
        "",
        stateLine(false, "other", "● required", "fixed by source/team · loaded through user", 12),
      ]);
      expect(lines("format")).toContainEqual([
        "profiles",
        stateLine(false, "source/team", "● required", "applied to other", 12),
      ]);
      expect(lines("shared")).toEqual([
        ["user", stateLine(false, "", "● included", "pick · loads in every project")],
        ["projects", stateLine(true, "demo", "○ opt-in", "loaded through user")],
        [
          "",
          stateLine(false, "other", "○ not a member", "fixed by source/team · loaded through user"),
        ],
        ["profiles", stateLine(false, "source/team", "○ not a member", "applied to other")],
      ]);
      expect(lines("broken")[1]).toEqual(["projects", stateLine(true, "demo", "✗ blocked")]);
      expect(lines("use-tack")[0]).toEqual([
        "user",
        stateLine(false, "", "● locked", "loads in every project", 8),
      ]);
      // Docs attach to projects only, and a profile never holds docs.
      expect(lines("handbook")).toEqual([
        ["projects", "› demo   ○ detached"],
        ["", "  other  ○ detached  fixed by source/team"],
      ]);
      expect(byTitle("review")?.tags).toEqual([]);
      const browsing = yield* loadExplorer(options, style, undefined);
      const review = browsing.entries.find((entry) => entry.title === "review");
      expect(review?.activity).toBeUndefined();
      expect(stateLines(review?.facts ?? [])).toEqual([
        ["user", stateLine(false, "", "○ opt-in")],
        ["projects", stateLine(false, "demo", "○ excluded", "pick")],
        ["", stateLine(false, "other", "○ not a member", "fixed by source/team")],
        ["profiles", stateLine(false, "source/team", "○ not a member", "applied to other")],
      ]);
      // A project fixed by a profile is read-only: every row says so instead of staging.
      const fixed = yield* loadExplorer(options, style, { _tag: "project", projectName: "other" });
      expect(fixed.fixedBy).toBe("source/team");
      const fixedReview = fixed.entries.find((entry) => entry.title === "review");
      expect(fixedReview?.editable).toEqual({ kind: "fixed", profile: "source/team" });
      expect(fixedReview?.activity).toEqual({ active: false, reason: "not a member" });
      expect(stateLines(fixedReview?.facts ?? [])[1]).toEqual([
        "projects",
        stateLine(false, "demo", "○ excluded", "pick"),
      ]);
      expect(stateLines(fixedReview?.facts ?? [])[2]).toEqual([
        "",
        stateLine(true, "other", "○ not a member", "fixed by source/team"),
      ]);
      expect(fixed.entries.find((entry) => entry.title === "use-tack")?.editable).toEqual({
        kind: "builtin",
      });
      expect((yield* loadExplorer(options, style, { _tag: "user" })).fixedBy).toBeUndefined();
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", [])), Effect.provide(SourceLive)),
  );

  test.effect("names resources by their source label in the review and the result", () =>
    Effect.gen(function* () {
      const { editorFor } = yield* workspace();
      const { editor, review } = yield* editorFor({ _tag: "user" });
      const include: PendingChange = { kind: "choice", address: review, decision: "include" };
      const preview = yield* editor.preview([include]);
      expect(preview).toContain("  include  skill source:review");
      expect(preview).toContain("  link        .claude/skills/review  skill source:review");
      expect(preview.join("\n")).not.toContain(review.sourceRegistrationId);
      const applied = yield* editor.apply([include]);
      expect(applied.lines).toContain("saved   include skill source:review");
      const reset = yield* editor.apply([{ kind: "choice", address: review, decision: "unset" }]);
      expect(reset.lines).toContain("saved   reset skill source:review");
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("previews a project skill left to the user's link", () =>
    Effect.gen(function* () {
      const { editorFor } = yield* workspace();
      const user = yield* editorFor({ _tag: "user" });
      yield* user.editor.apply([{ kind: "choice", address: user.review, decision: "include" }]);
      const { editor } = yield* editorFor({ _tag: "project", projectName: "demo" });
      const preview = yield* editor.preview([]);
      // The project still links its own sources skill, which lists the source of the skipped skill.
      expect(preview).toContain("claude → demo: 1 to link, 1 linked for the user");
      expect(preview).toContain("  skip        skill source:review (linked for the user)");
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("refuses a project exclude of a user-linked skill before saving any change", () =>
    Effect.gen(function* () {
      const { options, editorFor } = yield* workspace();
      const user = yield* editorFor({ _tag: "user" });
      yield* user.editor.apply([{ kind: "choice", address: user.review, decision: "include" }]);
      const { editor, review, handbook } = yield* editorFor({
        _tag: "project",
        projectName: "demo",
      });
      const batch: ReadonlyArray<PendingChange> = [
        {
          kind: "docs",
          resource: { sourceRegistrationId: handbook.sourceRegistrationId, name: handbook.name },
          attached: true,
        },
        { kind: "choice", address: review, decision: "exclude" },
      ];
      const refusal =
        "Project demo cannot hide skill review: the user namespace links it, so every agent in the project would still see it. Nothing was recorded. Run `tack pick exclude source:review --kind skill --user` to turn it off everywhere.";
      expect(yield* editor.preview(batch)).toEqual([`Cannot preview these changes: ${refusal}`]);
      const before = yield* readState(options);
      const applied = yield* editor.apply(batch);
      expect(applied.lines).toEqual([`stopped ${refusal}`]);
      expect((yield* readState(options)).data).toEqual(before.data);
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("keeps the changes saved before a failed one and says so", () =>
    Effect.gen(function* () {
      const { options, editorFor } = yield* workspace();
      const { editor, review, handbook } = yield* editorFor({
        _tag: "project",
        projectName: "demo",
      });
      const applied = yield* editor.apply([
        { kind: "choice", address: review, decision: "include" },
        {
          kind: "docs",
          resource: { sourceRegistrationId: handbook.sourceRegistrationId, name: "missing" },
          attached: true,
        },
      ]);
      expect(applied.lines[0]).toBe("saved   include skill source:review");
      expect(applied.lines[1]).toMatch(/^stopped /);
      expect(applied.lines[2]).toBe("Changes saved before this point remain; rerun to finish.");
      expect((yield* readState(options)).data.projects[0]?.choices).toEqual([
        { address: review, decision: "include" },
      ]);
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("previews relinking a link removed by hand as a replacement", () =>
    Effect.gen(function* () {
      const { fs, path, root, editorFor } = yield* workspace();
      const { editor, review } = yield* editorFor({ _tag: "user" });
      yield* editor.apply([{ kind: "choice", address: review, decision: "include" }]);
      yield* fs.remove(path.join(root, ".claude", "skills", "review"));
      const preview = yield* editor.preview([]);
      expect(preview).toContain("claude → user: 1 to link");
      expect(preview).toContain("  replace     .claude/skills/review  skill source:review");
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("previews adopting an unrecorded link that is exactly Tack's", () =>
    Effect.gen(function* () {
      const { fs, path, root, source, editorFor } = yield* workspace();
      const skills = path.join(root, ".claude", "skills");
      yield* fs.makeDirectory(skills, { recursive: true });
      yield* fs.symlink(
        path.relative(skills, path.join(source, "skills", "review")),
        path.join(skills, "review"),
      );
      const { editor, review } = yield* editorFor({ _tag: "user" });
      const preview = yield* editor.preview([
        { kind: "choice", address: review, decision: "include" },
      ]);
      // The sources skill is linked beside the adopted link.
      expect(preview).toContain("claude → user: 1 to link, 1 to adopt");
      expect(preview).toContain(
        "  adopt       .claude/skills/review  skill source:review (already linked)",
      );
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("previews forgetting the record of a removed link that is no longer selected", () =>
    Effect.gen(function* () {
      const { fs, path, root, editorFor } = yield* workspace();
      const { editor, review } = yield* editorFor({ _tag: "user" });
      yield* editor.apply([{ kind: "choice", address: review, decision: "include" }]);
      yield* fs.remove(path.join(root, ".claude", "skills", "review"));
      const preview = yield* editor.preview([
        { kind: "choice", address: review, decision: "exclude" },
      ]);
      // The user then links nothing of the source, so its sources skill is unlinked.
      expect(preview).toContain("claude → user: 1 to remove, 1 to forget");
      expect(preview).toContain("  forget      .claude/skills/review  record only");
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("previews an agent directory blocked by a file as a conflict without a path", () =>
    Effect.gen(function* () {
      const { fs, path, root, editorFor } = yield* workspace();
      yield* fs.makeDirectory(path.join(root, ".claude"), { recursive: true });
      yield* fs.writeFileString(path.join(root, ".claude", "skills"), "not a directory\n");
      const { editor, review } = yield* editorFor({ _tag: "user" });
      const preview = yield* editor.preview([
        { kind: "choice", address: review, decision: "include" },
      ]);
      expect(preview).toContain("claude → user: 1 conflict");
      expect(preview).toContain("  conflict    destination-directory-conflict (left untouched)");
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("previews two selected skills that need one destination as a collision", () =>
    Effect.gen(function* () {
      const { fs, path, root, options, editorFor } = yield* workspace();
      const other = path.join(root, "other");
      yield* fs.makeDirectory(path.join(other, "skills", "review"), { recursive: true });
      yield* fs.writeFileString(
        path.join(other, "tack.yaml"),
        "version: 1\nname: other\nskills:\n  - path: skills\n",
      );
      yield* fs.writeFileString(
        path.join(other, "skills", "review", "SKILL.md"),
        skillText("review", { description: "Another review.", body: "# Review\n" }),
      );
      yield* registerSource(options, { sourcePath: other });
      const { editor } = yield* editorFor({ _tag: "user" });
      const reviews = (yield* loadExplorer(
        options,
        makeStyle({ color: false, width: 140, homeDirectory: root }),
        {
          _tag: "user",
        },
      )).entries.flatMap((entry) =>
        entry.title === "review" && entry.address?.kind === "skill" ? [entry.address] : [],
      );
      expect(reviews).toHaveLength(2);
      const preview = yield* editor.preview(
        reviews.map((address): PendingChange => ({ kind: "choice", address, decision: "include" })),
      );
      expect(preview.join("\n")).toMatch(/claude → user: .*1 collision/);
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("says there is nothing to plan for without an enabled adapter", () =>
    Effect.gen(function* () {
      const { editorFor } = yield* workspace([]);
      const { editor, review } = yield* editorFor({ _tag: "user" });
      const preview = yield* editor.preview([
        { kind: "choice", address: review, decision: "include" },
      ]);
      expect(preview).toContain("No adapter and target to plan for (see tack adapter).");
      const applied = yield* editor.apply([
        { kind: "choice", address: review, decision: "include" },
      ]);
      expect(applied.lines).toContain("skills  nothing to link or remove");
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("a user editor saves no docs change, which only a project can hold", () =>
    Effect.gen(function* () {
      const { options, editorFor } = yield* workspace();
      const { editor, handbook } = yield* editorFor({ _tag: "user" });
      const before = yield* readState(options);
      const applied = yield* editor.apply([
        {
          kind: "docs",
          resource: { sourceRegistrationId: handbook.sourceRegistrationId, name: handbook.name },
          attached: true,
        },
      ]);
      expect(applied.lines.some((line) => line.startsWith("saved"))).toBe(false);
      expect((yield* readState(options)).data.projects).toEqual(before.data.projects);
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );

  test.effect("detaches docs and reports a mount it could not place", () =>
    Effect.gen(function* () {
      const { fs, path, project, options, editorFor } = yield* workspace();
      const { editor, handbook } = yield* editorFor({ _tag: "project", projectName: "demo" });
      const resource = { sourceRegistrationId: handbook.sourceRegistrationId, name: handbook.name };
      yield* editor.apply([{ kind: "docs", resource, attached: true }]);
      const mount =
        (yield* readState(options)).data.links.find((link) => link.delivery._tag === "docs")
          ?.destinationPath ?? "";
      expect(mount.startsWith(path.join(project, ".tack", "docs"))).toBe(true);

      const preview = yield* editor.preview([{ kind: "docs", resource, attached: false }]);
      expect(preview).toContain("  detach  docs source:handbook");
      const detached = yield* editor.apply([{ kind: "docs", resource, attached: false }]);
      expect(detached.lines).toContain("saved   detach docs handbook");
      expect(yield* fs.exists(mount)).toBe(false);

      // Something the operator owns now sits where the mount goes, and Tack leaves it alone.
      yield* fs.makeDirectory(mount, { recursive: true });
      yield* fs.writeFileString(path.join(mount, "mine.md"), "mine\n");
      const blocked = yield* editor.apply([{ kind: "docs", resource, attached: true }]);
      expect(blocked.lines).toContain("docs    0 applied, 1 not applied");
      expect(blocked.lines.some((line) => line.startsWith("  blocked "))).toBe(true);
      expect(yield* fs.readFileString(path.join(mount, "mine.md"))).toBe("mine\n");
    }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );
});
