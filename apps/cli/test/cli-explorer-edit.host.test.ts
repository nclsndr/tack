import { skillText } from "./support/source-tree.ts";
import { fakeGit } from "./support/fake-git.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Option, Path, Queue, Ref, Terminal } from "effect";
import { SecureRandom } from "effect/crypto";
import type { Namespace } from "../src/domain/choices/choice-schema.ts";
import { explorerEntries } from "../src/cli/explorer/entries.ts";
import { renderExplorerFrame } from "../src/cli/explorer/frame.ts";
import { makeStyle } from "../src/cli/human/style.ts";
import type { CatalogReport } from "../src/domain/sources/catalog-report.ts";
import { stagedState } from "../src/cli/explorer/edit.ts";
import { initialExplorerState, pendingChanges, stepExplorer } from "../src/cli/explorer/model.ts";
import { exploreSelection } from "../src/cli/routes/explore.ts";
import { TerminalContext } from "../src/cli/human/terminal-context.ts";
import { Git } from "../src/services/git.ts";
import { enableAdapters } from "../src/features/reconciliation/agent.ts";
import type { RouteServices } from "../src/cli/envelope/route-services.ts";
import { loadExplorer, makeExplorerEditor } from "../src/cli/explorer/editor.ts";
import { Source, makeSourceService, registerSource } from "../src/features/sources/source.ts";
import { mutateStateFixture, stateOptionsAt } from "./support/state-fixture.ts";
import {
  choice,
  key,
  on,
  press,
  sourceRegistrationId,
  unwatchedTerminalSize,
} from "./support/explorer.ts";
import { initializeState, readState } from "../src/services/state-store.ts";
import { type State } from "../src/domain/state/state-schema.ts";
import { makeExplorerDestinations } from "../src/cli/explorer/profile-editor.ts";

const user: Namespace = { _tag: "user" };

it("asks for review before leaving with staged changes and refuses to review nothing", () => {
  const editing = on(initialExplorerState("Tack explorer", [choice("review")], user), "review");
  const nothing = press(editing, "c");
  expect(nothing.edit?.notice).toBe("Nothing is staged.");
  expect(stepExplorer(editing, key("q"))._tag).toBe("quit");

  const staged = press(editing, "i");
  const warned = press(staged, "q");
  expect(warned.edit?.notice).toContain("discarded");
  expect(stepExplorer(warned, key("q"))._tag).toBe("quit");
  // Any other key clears the warning, so leaving needs the warning again.
  const cleared = press(warned, "down");
  expect(cleared.edit?.notice).toBeUndefined();
  expect(press(cleared, "q").edit?.notice).toContain("discarded");
  expect(stepExplorer(staged, key("c"))._tag).toBe("review");
});

it("previews staged state in memory without touching the snapshot", () => {
  const editing = press(
    on(initialExplorerState("Tack explorer", [choice("review")], user), "review"),
    "i",
  );
  const snapshot = emptyState();
  const staged = stagedState(snapshot, user, pendingChanges(editing));
  expect(staged.data.userChoices).toEqual([
    { address: { kind: "skill", name: "review", sourceRegistrationId }, decision: "include" },
  ]);
  expect(snapshot.data.userChoices).toEqual([]);
});

it.layer(LiveTestLayer)("browse destinations", (test) => {
  test.effect(
    "edits existing manifests through canonical source aliases and keeps failures in the current destination",
    () =>
      Effect.gen(function* () {
        const { options, fs, path, root } = yield* withWorkspace();
        const sourcePath = path.join(root, "source");
        yield* fs.writeFileString(
          path.join(sourcePath, "tack.yaml"),
          "version: 2\nname: tools\nskills: [{path: skills}]\ncommands: [{path: lint.md}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
        );
        yield* fs.writeFileString(
          path.join(sourcePath, "ci.yaml"),
          "version: 1\nname: ci\nmembers: [review]\n",
        );
        yield* fs.writeFileString(path.join(sourcePath, "lint.md"), "Lint");
        yield* fs.writeFileString(
          path.join(sourcePath, "skills/review/SKILL.md"),
          skillText("review", {
            description: "Review",
            tack: ["dependencies:", "  - kind: command", "    name: lint"],
            body: "",
          }),
        );
        yield* fs.symlink(sourcePath, path.join(root, "alias"));
        const style = makeStyle({ color: false, width: 120, homeDirectory: root });
        const destinations = yield* makeExplorerDestinations({
          stateOptions: options,
          style,
          cwd: root,
          context: yield* Effect.context<RouteServices>(),
        });
        const initial = initialExplorerState("Tack explorer", []);
        const opened = yield* destinations.open(initial, {
          _tag: "profile",
          sourcePath: path.join(root, "alias"),
          profileName: "ci",
          create: false,
        });
        expect(opened.state.edit?.namespace).toMatchObject({ sourcePath, profileName: "ci" });
        if (opened.editor === undefined) throw new Error("Expected profile editor.");
        const reviewLines = yield* opened.editor.preview([]);
        expect(reviewLines.join("\n")).toContain("Required dependencies (1)");
        for (const line of reviewLines) expect(line).not.toMatch(/[\r\n]/);
        expect(reviewLines).toEqual(
          expect.arrayContaining([
            "--- before",
            "version: 1",
            "name: ci",
            "members: [review]",
            "+++ after",
          ]),
        );
        const member = opened.state.entries.find(
          (entry) => entry.address?.name === "review",
        )?.address;
        if (member === undefined) throw new Error("Missing review fixture.");
        expect(
          (yield* opened.editor.preview([
            { kind: "member", address: member, included: false },
          ])).join("\n"),
        ).toContain("Direct members (0)");
        const saved = yield* opened.editor.apply([
          { kind: "member", address: member, included: false },
        ]);
        expect(saved.entries, saved.lines.join("\n")).toBeDefined();
        expect(
          Bun.YAML.parse(yield* fs.readFileString(path.join(sourcePath, "ci.yaml"))),
        ).toMatchObject({ members: [] });
        for (const destination of [
          { _tag: "profile", sourcePath, profileName: "ci", create: true },
          { _tag: "profile", sourcePath, profileName: "absent", create: false },
        ] as const) {
          const refused = yield* destinations.open(initial, destination);
          expect(refused.editor).toBeUndefined();
          expect(refused.state.preview?.title).toBe("Cannot change destination");
        }
        const project = yield* destinations.open(initial, projectNamespace);
        expect(project.state.edit?.namespace).toEqual(projectNamespace);
        expect(destinations.options.map((entry) => entry.label)).toContain("tools/ci");
        yield* fs.writeFileString(
          path.join(sourcePath, "ci.yaml"),
          "version: 1\nname: ci\nmembers: [review]\n",
        );
        expect((yield* opened.editor.apply([])).entries).toBeUndefined();
        yield* fs.writeFileString(
          path.join(sourcePath, "ci.yaml"),
          "version: 99\nname: ci\nmembers: []\n",
        );
        expect(
          (yield* destinations.open(initial, {
            _tag: "profile",
            sourcePath,
            profileName: "ci",
            create: false,
          })).editor,
        ).toBeUndefined();
      }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );
  test.effect(
    "refuses portable-name collisions and stale profile saves without clearing staging",
    () =>
      Effect.gen(function* () {
        const { options, fs, path, root } = yield* withWorkspace();
        for (const source of ["one", "two"]) {
          const directory = path.join(root, source);
          yield* fs.makeDirectory(directory);
          yield* fs.writeFileString(
            path.join(directory, "tack.yaml"),
            "version: 1\nname: team\ncommands: [{path: audit.md}]\n",
          );
          yield* fs.writeFileString(path.join(directory, "audit.md"), "Audit");
          yield* registerSource(options, { sourcePath: directory });
        }
        const sourcePath = path.join(root, "source");
        const style = makeStyle({ color: false, width: 120, homeDirectory: root });
        const destinations = yield* makeExplorerDestinations({
          stateOptions: options,
          style,
          cwd: root,
          context: yield* Effect.context<RouteServices>(),
        });
        const opened = yield* destinations.open(initialExplorerState("Tack explorer", []), {
          _tag: "profile",
          sourcePath,
          profileName: "ci",
          create: true,
        });
        if (opened.editor === undefined) throw new Error("Expected profile editor.");
        const external = opened.state.entries.find(
          (entry) => entry.address?.name === "audit",
        )?.address;
        if (external === undefined) throw new Error("Expected audit fixture.");
        const pending = [{ kind: "member", address: external, included: true }] as const;
        expect((yield* opened.editor.preview(pending)).join("\n")).toContain(
          "distinct portable names",
        );
        expect((yield* opened.editor.apply(pending)).entries).toBeUndefined();
        expect(yield* fs.exists(path.join(sourcePath, "profiles/ci.yaml"))).toBe(false);
        for (const directory of ["one", "two"])
          yield* fs.writeFileString(
            path.join(root, directory, "tack.yaml"),
            `version: 1\nname: ${directory}\ncommands: [{path: audit.md}]\n`,
          );
        const repaired = yield* makeExplorerDestinations({
          stateOptions: options,
          style,
          cwd: root,
          context: yield* Effect.context<RouteServices>(),
        });
        const editor = (yield* repaired.open(initialExplorerState("Tack explorer", []), {
          _tag: "profile",
          sourcePath,
          profileName: "ci",
          create: true,
        })).editor;
        if (editor === undefined) throw new Error("Expected repaired profile editor.");
        expect((yield* editor.apply(pending)).entries).toBeDefined();
        expect(yield* fs.readFileString(path.join(sourcePath, "profiles/ci.yaml"))).toMatch(
          /source: (one|two)/,
        );
      }).pipe(Effect.provideService(Git, fakeGit("/tmp", []))),
  );
  test.effect("discards profile staging explicitly before saving to user selection", () =>
    Effect.gen(function* () {
      const { options, fs, path, root, userLink, projectLink } = yield* withWorkspace();
      // The chooser lists browse only, user, project demo, then the new profile.
      const { terminal } = yield* scriptedTerminal([
        input("d"),
        input("down", ""),
        input("down", ""),
        input("down", ""),
        input("return", ""),
        input("scratch"),
        input("return", ""),
        input("/"),
        input("review"),
        input("return", ""),
        input("i"),
        input("d"),
        input("d"),
        input("down", ""),
        input("return", ""),
        input("/"),
        input("review"),
        input("return", ""),
        input("i"),
        input("c"),
        input("y"),
        input("q"),
        input("q"),
      ]);
      yield* runEditing(options, terminal);
      expect(yield* fs.exists(path.join(root, "source/profiles/scratch.yaml"))).toBe(false);
      expect(yield* fs.exists(userLink)).toBe(true);
      expect(yield* fs.exists(projectLink)).toBe(false);
      expect((yield* readState(options)).data.userChoices).toHaveLength(1);
    }),
  );
  test.effect(
    "creates a profile inside the window, reviews closure, saves only its files and cancels destination changes",
    () =>
      Effect.gen(function* () {
        const { options, fs, path, root, userLink, projectLink } = yield* withWorkspace();
        const before = yield* readState(options);
        // d opens browse-only/user/project/new-profile choices; a new profile is the fourth.
        const { terminal, displayed } = yield* scriptedTerminal([
          input("d"),
          input("down", ""),
          input("down", ""),
          input("down", ""),
          input("return", ""),
          input("ci"),
          input("return", ""),
          input("/"),
          input("review"),
          input("return", ""),
          input("i"),
          input("d"),
          input("escape", ""),
          input("c"),
          input("y"),
          input("q"),
          input("q"),
        ]);
        yield* runEditing(options, terminal);
        const frames = (yield* Ref.get(displayed)).join("\n");
        expect(frames).toContain("Choose destination");
        expect(frames).toContain("Direct members (1)");
        // The review names each member by its shortest reference, as every other view does.
        expect(frames).toContain("  skill review");
        expect(frames).not.toMatch(/skill [0-9a-f-]{36}:review/);
        expect(frames).toContain("Required dependencies (0)");
        expect(frames).toContain("Pending edits");
        expect(yield* fs.readFileString(path.join(root, "source/profiles/ci.yaml"))).toContain(
          "review",
        );
        expect(yield* readState(options)).toEqual(before);
        expect(yield* fs.exists(userLink)).toBe(false);
        expect(yield* fs.exists(projectLink)).toBe(false);
      }),
  );
});

const emptyState = (): State => ({
  format: 1,
  data: {
    enabledAdapters: [],
    userChoices: [],
    links: [],
    projects: [],
    sources: [],
  },
});

const input = (name: string, text = name): Terminal.UserInput => ({
  input: Option.some(text),
  key: { name, ctrl: false, meta: false, shift: false },
});
const scriptedTerminal = Effect.fnUntraced(function* (keys: ReadonlyArray<Terminal.UserInput>) {
  const queue = yield* Queue.make<Terminal.UserInput, Cause.Done>();
  for (const pressed of keys) yield* Queue.offer(queue, pressed);
  const displayed = yield* Ref.make<ReadonlyArray<string>>([]);
  const terminal = Terminal.make({
    columns: Effect.succeed(100),
    rows: Effect.succeed(24),
    size: unwatchedTerminalSize,
    readInput: Effect.succeed(queue),
    readLine: Effect.succeed(""),
    display: (text) => Ref.update(displayed, (values) => [...values, text]),
  });
  return { terminal, displayed };
});
const projectNamespace: Namespace = { _tag: "project", projectName: "demo" };

const withWorkspace = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "tack-browse-edit-" }),
  );
  const source = path.join(root, "source");
  const skill = path.join(source, "skills", "review");
  const options = stateOptionsAt(path.join(root, "state"), root);
  const project = path.join(root, "demo");
  yield* fs.makeDirectory(skill, { recursive: true });
  yield* fs.makeDirectory(path.join(source, "knowledge"), { recursive: true });
  yield* fs.makeDirectory(project, { recursive: true });
  yield* fs.writeFileString(
    path.join(source, "tack.yaml"),
    "version: 1\nname: source\nskills:\n  - path: skills\ndocs:\n  - name: handbook\n    path: knowledge\n",
  );
  yield* fs.writeFileString(path.join(source, "knowledge", "hello.md"), "# Hello\n");
  yield* fs.writeFileString(
    path.join(skill, "SKILL.md"),
    "---\nname: review\ndescription: Review a change.\n---\n# Review\n",
  );
  yield* initializeState(options);
  yield* registerSource(options, { sourcePath: source });
  yield* enableAdapters(options, ["claude"]);
  yield* mutateStateFixture(options, (state) => ({
    ...state,
    data: {
      ...state.data,
      projects: [{ name: "demo", gitCommonDirectory: path.join(root, "git"), roots: [project] }],
    },
  }));
  return {
    fs,
    path,
    root,
    project,
    userLink: path.join(root, ".claude", "skills", "review"),
    projectLink: path.join(project, ".claude", "skills", "review"),
    options,
  };
});

/** Runs one explorer session in a 100-column interactive terminal. */
const runExplore = (
  options: Parameters<typeof initializeState>[0],
  terminal: Terminal.Terminal,
  request: Parameters<typeof exploreSelection>[1],
  environment: Readonly<Record<string, string>> = { TERM: "xterm" },
) =>
  Effect.scoped(
    exploreSelection(options, request).pipe(
      Effect.provideService(Terminal.Terminal, terminal),
      Effect.provideService(TerminalContext, {
        columns: 100,
        environment,
        stdinIsTerminal: true,
        stdoutIsTerminal: true,
      }),
      Effect.provideService(Git, fakeGit("/tmp", [])),
      Effect.provide(BunServices.layer),
    ),
  );

/** Opens `namespace` from the workspace root, which no project contains. */
const runEditing = (
  options: Parameters<typeof initializeState>[0] & { readonly homeDirectory: string },
  terminal: Terminal.Terminal,
  namespace: Namespace = user,
  environment: Readonly<Record<string, string>> = { TERM: "xterm" },
) =>
  runExplore(
    options,
    terminal,
    { destination: namespace, cwd: options.homeDirectory },
    environment,
  );

const framesOf = (displayed: Ref.Ref<ReadonlyArray<string>>) =>
  Ref.get(displayed).pipe(Effect.map((values) => values.join("\n")));

it.layer(LiveTestLayer)("explore write sessions", (test) => {
  test.effect("writes nothing while previewing, and nothing when the operator declines", () =>
    Effect.gen(function* () {
      const { fs, userLink, options } = yield* withWorkspace();
      const before = yield* readState(options);
      const { terminal, displayed } = yield* scriptedTerminal([
        input("down", ""),
        input("i"),
        input("c"),
        input("n"),
        input("q"),
        input("q"),
      ]);
      yield* runEditing(options, terminal);
      const frames = yield* framesOf(displayed);
      expect(frames).toContain("Staged changes in the user namespace");
      expect(frames).toContain("Nothing has been written");
      expect(frames).toContain("tack sync would apply");
      expect(frames).toContain("link");
      expect(yield* readState(options)).toEqual(before);
      expect(yield* fs.exists(userLink)).toBe(false);
    }),
  );

  test.effect("persists the pick and links the skill only after confirmation", () =>
    Effect.gen(function* () {
      const { fs, userLink, options } = yield* withWorkspace();
      const { terminal, displayed } = yield* scriptedTerminal([
        input("down", ""),
        input("i"),
        input("c"),
        input("y"),
        input("q"),
        input("q"),
      ]);
      yield* runEditing(options, terminal);
      const frames = yield* framesOf(displayed);
      expect(frames).toContain("saved   include skill source:review");
      expect(frames).toContain("2 applied, 0 failed");
      expect((yield* readState(options)).data.userChoices).toMatchObject([
        {
          address: expect.objectContaining({ kind: "skill", name: "review" }),
          decision: "include",
        },
      ]);
      expect(yield* fs.exists(userLink)).toBe(true);
      // The list reloads from state, so the applied pick shows as the row's state.
      expect(frames).toContain("● included");
    }),
  );

  test.effect("counts a link changed outside Tack as one to release in the preview", () =>
    Effect.gen(function* () {
      const { fs, path, root, userLink, options } = yield* withWorkspace();
      const linked = yield* scriptedTerminal([
        input("down", ""),
        input("i"),
        input("c"),
        input("y"),
        input("q"),
        input("q"),
      ]);
      yield* runEditing(options, linked.terminal);
      // The operator points the link at their own copy, so excluding the skill only forgets it.
      const copy = path.join(root, "own-review");
      yield* fs.makeDirectory(copy);
      yield* fs.remove(userLink);
      yield* fs.symlink(copy, userLink);
      const { terminal, displayed } = yield* scriptedTerminal([
        input("down", ""),
        input("x"),
        input("c"),
        input("n"),
        input("q"),
        input("q"),
      ]);
      yield* runEditing(options, terminal);
      expect(yield* framesOf(displayed)).toContain("claude → user: 1 to release");
    }),
  );

  test.effect("leaving with staged changes writes nothing", () =>
    Effect.gen(function* () {
      const { fs, userLink, options } = yield* withWorkspace();
      const before = yield* readState(options);
      const { terminal, displayed } = yield* scriptedTerminal([
        input("down", ""),
        input("i"),
        input("q"),
        input("q"),
      ]);
      yield* runEditing(options, terminal);
      expect(yield* framesOf(displayed)).toContain("Staged changes will be discarded");
      expect(yield* readState(options)).toEqual(before);
      expect(yield* fs.exists(userLink)).toBe(false);
    }),
  );

  test.effect("previews a foreign destination as a conflict and never replaces it", () =>
    Effect.gen(function* () {
      const { fs, path, userLink, options } = yield* withWorkspace();
      yield* fs.makeDirectory(userLink, { recursive: true });
      const foreign = path.join(userLink, "SKILL.md");
      yield* fs.writeFileString(foreign, "someone else's skill\n");
      const { terminal, displayed } = yield* scriptedTerminal([
        input("down", ""),
        input("i"),
        input("c"),
        input("n"),
        input("q"),
        input("q"),
      ]);
      yield* runEditing(options, terminal);
      const preview = yield* framesOf(displayed);
      expect(preview).toContain("Nothing has been written");
      expect(preview).toContain("conflict    .claude/skills/review");
      expect(preview).toContain("(left untouched)");
      expect(preview).not.toContain("replace ");

      const confirmed = yield* scriptedTerminal([
        input("down", ""),
        input("i"),
        input("c"),
        input("y"),
        input("q"),
        input("q"),
      ]);
      yield* runEditing(options, confirmed.terminal);
      const frames = yield* framesOf(confirmed.displayed);
      expect(frames).toContain("1 conflict left unchanged");
      expect(frames).not.toContain("nothing to link or remove");
      expect(yield* fs.readFileString(foreign)).toBe("someone else's skill\n");
      expect((yield* fs.stat(userLink)).type).toBe("Directory");
    }),
  );

  test.effect("stages a project pick and a docs attachment and syncs both after confirmation", () =>
    Effect.gen(function* () {
      const { fs, path, project, projectLink, options } = yield* withWorkspace();
      const before = yield* readState(options);
      // The skills section precedes docs, so the cursor walks to the skill first, then to docs.
      const keys = (decision: ReadonlyArray<Terminal.UserInput>) => [
        input("down", ""),
        input("i"),
        input("down", ""),
        input("a"),
        ...decision,
      ];
      const declined = yield* scriptedTerminal(
        keys([input("c"), input("n"), input("q"), input("q")]),
      );
      yield* runEditing(options, declined.terminal, projectNamespace);
      const preview = yield* framesOf(declined.displayed);
      expect(preview).toContain("Staged changes in project demo");
      expect(preview).toContain("Docs mounts:");
      expect(yield* readState(options)).toEqual(before);
      expect(yield* fs.exists(projectLink)).toBe(false);

      const confirmed = yield* scriptedTerminal(
        keys([input("c"), input("y"), input("q"), input("q")]),
      );
      yield* runEditing(options, confirmed.terminal, projectNamespace);
      const frames = yield* framesOf(confirmed.displayed);
      expect(frames).toContain("saved   include skill source:review");
      expect(frames).toContain("saved   attach docs handbook");
      expect(frames).toContain("skills  2 applied, 0 failed");
      expect(frames).toContain("docs    1 applied, 0 not applied");
      const state = yield* readState(options);
      expect(state.data.projects[0]?.choices).toMatchObject([
        {
          address: expect.objectContaining({ kind: "skill", name: "review" }),
          decision: "include",
        },
      ]);
      expect(state.data.projects[0]?.docs?.attachments).toHaveLength(1);
      expect(state.data.userChoices).toEqual([]);
      expect(yield* fs.exists(projectLink)).toBe(true);
      const mount =
        state.data.links.find((link) => link.delivery._tag === "docs")?.destinationPath ?? "";
      expect(mount.startsWith(path.join(project, ".tack", "docs"))).toBe(true);
      expect(yield* fs.exists(mount)).toBe(true);
    }),
  );

  test.effect("an unregistered project is reported before any frame is drawn", () =>
    Effect.gen(function* () {
      const { options } = yield* withWorkspace();
      const { terminal, displayed } = yield* scriptedTerminal([input("q")]);
      const failure = yield* Effect.flip(
        runEditing(options, terminal, { _tag: "project", projectName: "ghost" }),
      );
      expect(failure).toMatchObject({ code: "choice-project-not-found" });
      expect(yield* Ref.get(displayed)).toEqual([]);
    }),
  );

  test.effect("opens the project that contains the working directory when no flag names one", () =>
    Effect.gen(function* () {
      const { project, options } = yield* withWorkspace();
      const { terminal, displayed } = yield* scriptedTerminal([input("q")]);
      yield* runExplore(options, terminal, { cwd: project });
      const frames = yield* framesOf(displayed);
      expect(frames).toContain("editing project demo");
      expect(frames).not.toContain("Choose destination");
    }),
  );

  test.effect("opens the named destination even inside another project", () =>
    Effect.gen(function* () {
      const { project, options } = yield* withWorkspace();
      const { terminal, displayed } = yield* scriptedTerminal([input("q")]);
      yield* runExplore(options, terminal, { destination: user, cwd: project });
      expect(yield* framesOf(displayed)).toContain("editing user");
    }),
  );

  test.effect("opens on the destination chooser outside every project, and Esc only reads", () =>
    Effect.gen(function* () {
      const { fs, root, userLink, options } = yield* withWorkspace();
      const before = yield* readState(options);
      const { terminal, displayed } = yield* scriptedTerminal([
        input("escape", ""),
        input("/"),
        input("review"),
        input("return", ""),
        input("i"),
        input("c"),
        input("q"),
      ]);
      yield* runExplore(options, terminal, { cwd: root });
      const frames = yield* framesOf(displayed);
      expect(frames).toContain("Choose destination");
      expect(frames).toContain("› Browse only");
      expect(frames).not.toContain("editing ");
      expect(yield* readState(options)).toEqual(before);
      expect(yield* fs.exists(userLink)).toBe(false);
    }),
  );

  test.effect("an agent marker or a pipe refuses a write session before any state read", () =>
    Effect.gen(function* () {
      const { fs, userLink, options } = yield* withWorkspace();
      const before = yield* readState(options);
      const { terminal, displayed } = yield* scriptedTerminal([input("q")]);
      for (const environment of [
        { TERM: "xterm", CODEX_CI: "1" },
        { TERM: "xterm", CLAUDECODE: "1" },
        { TERM: "dumb" },
      ]) {
        const failure = yield* Effect.flip(runEditing(options, terminal, user, environment));
        expect(failure).toMatchObject({ code: "terminal-required", command: "explore" });
      }
      expect(yield* Ref.get(displayed)).toEqual([]);
      expect(yield* readState(options)).toEqual(before);
      expect(yield* fs.exists(userLink)).toBe(false);
    }),
  );
});

it.each([user, projectNamespace])(
  "locks a release-owned skill for every staging key in %j",
  (namespace) => {
    const resource = {
      kind: "skill",
      origin: "builtin",
      address: { kind: "skill", name: "future-builtin", sourceRegistrationId },
      sourceRegistrationId,
      sourcePath: "/release/builtins",
      directoryPath: "/release/builtins/skills/future-builtin",
      filePath: "/release/builtins/skills/future-builtin/SKILL.md",
      activation: "opt-in",
      userActivation: "default",
      dependencies: [],
      projects: [],
      description: "Release-owned guidance.",
    } as const;
    const report = {
      kind: "catalog",
      complete: true,
      resources: [resource],
      issues: [],
    } satisfies Pick<CatalogReport, "kind" | "complete" | "resources" | "issues">;
    const entries = explorerEntries(report, [], (path) => path, {
      namespace,
      attachments: [],
    });
    expect(entries[0]?.tags).toEqual(["built-in", "locked"]);
    const initial = initialExplorerState("Tack explorer", entries, namespace);
    let latest = initial;
    for (const character of ["i", "x", "a", "i", "x"]) {
      const refused = press(latest, character);
      latest = refused;
      expect(refused.edit?.notice).toBe(
        "Built-in skills are managed by the release and cannot be changed here.",
      );
      expect(pendingChanges(refused)).toEqual([]);
      expect(stagedState(emptyState(), namespace, pendingChanges(refused))).toEqual(emptyState());
      expect(press(refused, "c").edit?.notice).toBe("Nothing is staged.");
    }
    const frame = renderExplorerFrame(
      initial,
      { rows: 30, columns: 140 },
      makeStyle({ color: false, width: 140, homeDirectory: undefined }),
    );
    expect(frame).toContain("built-in locked");
    expect(frame).not.toContain("i: include · x: exclude");
  },
);

it.layer(LiveTestLayer)("built-in browse write boundary", (test) => {
  test.effect("rejects an injected built-in batch before any saved choice or sync", () =>
    Effect.gen(function* () {
      const { options, fs, path, root, userLink } = yield* withWorkspace();
      const before = yield* readState(options);
      const registration = before.data.sources[0];
      if (registration === undefined) throw new Error("Missing fixture source.");
      const source = makeSourceService(yield* SecureRandom.SecureRandom, fs, path, [registration]);
      yield* Effect.gen(function* () {
        const namespace = user;
        const style = makeStyle({ color: false, width: 140, homeDirectory: root });
        const loaded = yield* loadExplorer(options, style, namespace);
        const entry = loaded.entries.find((candidate) => candidate.title === "review");
        const address = entry?.address;
        if (address?.kind !== "skill") throw new Error("Missing fixture skill.");
        const editor = makeExplorerEditor({
          stateOptions: options,
          namespace,
          style,
          cwd: root,
          context: yield* Effect.context<RouteServices>(),
        });
        const pending = [
          { kind: "choice", address: { ...address, name: "ordinary" }, decision: "include" },
          { kind: "choice", address, decision: "exclude" },
        ] as const;
        expect((yield* editor.preview(pending)).join("\n")).toContain("managed by the release");
        expect((yield* editor.apply(pending)).lines.join("\n")).toContain("managed by the release");
        expect(yield* readState(options)).toEqual(before);
        expect(yield* fs.exists(userLink)).toBe(false);
      }).pipe(
        Effect.provideService(Source, source),
        Effect.provideService(Git, fakeGit("/tmp", [])),
      );
    }),
  );
});
