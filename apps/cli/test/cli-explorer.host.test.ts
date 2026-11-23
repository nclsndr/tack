import { fakeGit } from "./support/fake-git.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { unwatchedTerminalSize } from "./support/explorer.ts";
import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Queue,
  Ref,
  Schema,
  Terminal,
} from "effect";
import {
  agentMarkers,
  TerminalContext,
  type TerminalContextShape,
} from "../src/cli/host/human/terminal-context.ts";
import { parseInvocation } from "../src/cli/commands/index.ts";
import { Git } from "../src/services/git.ts";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";
import {
  initialExplorerState,
  selectedRow,
  stepExplorer,
  visibleEntries,
  visibleRows,
  type ExplorerEntry,
  type ExplorerKey,
  type ExplorerState,
} from "../src/cli/host/human/explorer/model.ts";
import { renderExplorerFrame } from "../src/cli/host/human/explorer/frame.ts";
import { runExplorer } from "../src/cli/host/human/explorer/session.ts";
import { makeStyle } from "../src/cli/host/human/style.ts";
import { ReaderCorpusLive } from "../src/platform/reader/search.ts";
import { initializeState, readState } from "../src/services/state-store.ts";
import { registerSource } from "../src/features/sources/source.ts";
import { exploreSelection } from "../src/cli/host/routes/explore.ts";
import { loadExplorer } from "../src/cli/host/human/explorer/editor.ts";
import { CatalogReportSchema } from "../src/domain/sources/catalog-report.ts";
import { SkillChoiceSchema } from "../src/domain/choices/choice-schema.ts";
import { explorerEntries } from "../src/cli/host/human/explorer/entries.ts";

const interactive: TerminalContextShape = {
  columns: 80,
  environment: { TERM: "xterm" },
  stdinIsTerminal: true,
  stdoutIsTerminal: true,
};

const forbiddenTerminal = Terminal.make({
  columns: Effect.die("Explorer read terminal dimensions before refusal."),
  rows: Effect.die("Explorer read terminal dimensions before refusal."),
  size: Effect.die("Explorer watched the terminal size before refusal."),
  display: () => Effect.die("Explorer drew before refusal."),
  readInput: Effect.die("Explorer read keys before refusal."),
  readLine: Effect.die("Explorer read a line before refusal."),
});

/** An empty home: the refusal resolves the default state under `HOME` before it refuses. */
const throwawayHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "tack-explore-home-" });
});

it.layer(LiveTestLayer)("explore refuses non-interactive callers", (test) => {
  test.effect("does not touch the terminal for pipes, markers, CI or a dumb terminal", () =>
    Effect.gen(function* () {
      expect(yield* parseInvocation(["explore"])).toEqual({ invocation: { _tag: "explore" } });
      for (const context of [
        undefined,
        { ...interactive, stdinIsTerminal: false },
        { ...interactive, stdoutIsTerminal: false },
        { ...interactive, environment: { TERM: "dumb" } },
        { ...interactive, environment: { TERM: "xterm", CI: "1" } },
        ...agentMarkers.map((marker) => ({
          ...interactive,
          environment: { TERM: "xterm", TACK_FORMAT: "human", [marker]: "1" },
        })),
      ]) {
        const { exit, stdout } = yield* runHost({
          args: ["--json", "explore"],
          git: fakeGit("/tmp", []),
          env: { HOME: yield* throwawayHome },
          ...(context === undefined ? {} : { terminal: context }),
        }).pipe(Effect.provideService(Terminal.Terminal, forbiddenTerminal));
        const envelope = decodeEnvelope(stdout);
        expect(envelope).toMatchObject({
          command: "explore",
          classification: "invalid-invocation",
          diagnostics: [{ code: "terminal-required" }],
        });
        expect(exit._tag).toBe("Failure");
      }
    }),
  );

  test.effect("a named destination cannot start a session in a pipe either", () =>
    Effect.gen(function* () {
      const { exit, stdout } = yield* runHost({
        args: ["--json", "explore", "--user"],
        git: fakeGit("/tmp", []),
        env: { HOME: yield* throwawayHome },
      }).pipe(Effect.provideService(Terminal.Terminal, forbiddenTerminal));
      expect(exit._tag).toBe("Failure");
      expect(stdout).toContain("terminal-required");
    }),
  );
});

const plain = makeStyle({ color: false, homeDirectory: undefined, width: 80 });
const entry = (
  name: string,
  section = "Skills",
  preview?: ExplorerEntry["preview"],
): ExplorerEntry => ({
  id: `${section}/${name}`,
  section,
  title: name,
  description: `Description of ${name}`,
  tags: ["+demo"],
  facts: [["address", `shared skill ${name}`]],
  issue: false,
  address: { kind: "skill", name, sourceRegistrationId: "00000000-0000-4000-8000-000000000001" },
  ...(preview === undefined ? {} : { preview }),
});
const key = (name: string, input?: string): ExplorerKey => ({ name, input, ctrl: false });
const state = (entries: ReadonlyArray<ExplorerEntry>) =>
  initialExplorerState("Tack explorer", entries);
/** The title of the selected resource or issue; none while the cursor is on a folder. */
const selectedTitle = (current: ExplorerState) => {
  const row = selectedRow(current);
  return row?.kind === "entry" ? row.entry.title : undefined;
};

it("shows the catalog's resource facts, explicit choices and issues", () => {
  const sourceRegistrationId = "00000000-0000-4000-8000-000000000001";
  const address = { kind: "skill", name: "review", sourceRegistrationId };
  const report = Schema.decodeUnknownSync(CatalogReportSchema)({
    kind: "catalog",
    complete: false,
    resources: [
      {
        kind: "skill",
        address,
        origin: "builtin",
        sourcePath: "/source",
        sourceRegistrationId,
        directoryPath: "/source/skills/review",
        filePath: "/source/skills/review/SKILL.md",
        declaredPath: "vendor/skills",
        description: "Review a change.",
        activation: "opt-in",
        dependencies: [],
        projects: ["demo"],
      },
    ],
    issues: [
      {
        code: "skill-frontmatter-invalid",
        message: "Invalid frontmatter.",
        subject: {
          _tag: "resource",
          sourcePath: "/source",
          sourceRegistrationId,
          candidatePath: "/source/skills/broken/SKILL.md",
        },
      },
    ],
  });
  const choices = Schema.decodeUnknownSync(Schema.Array(SkillChoiceSchema))([
    { address, decision: "include", namespace: { _tag: "project", projectName: "demo" } },
  ]);
  const projected = explorerEntries(report, choices, (path) => path);
  expect(projected.map((candidate) => candidate.section)).toEqual(["Skills", "Issues"]);
  expect(projected[0]).toMatchObject({
    tags: ["built-in", "locked"],
    facts: expect.arrayContaining([
      ["declared by", "skills: vendor/skills"],
      ["activation", "project opt-in · user opt-in"],
      ["projects", "demo"],
    ]),
  });
  expect(projected[1]).toMatchObject({
    title: "/source/skills/broken/SKILL.md",
    facts: expect.arrayContaining([["code", "skill-frontmatter-invalid"]]),
  });
});

it("says a skills collection declared a resource that has no declared path", () => {
  const sourceRegistrationId = "00000000-0000-4000-8000-000000000001";
  const report = Schema.decodeUnknownSync(CatalogReportSchema)({
    kind: "catalog",
    complete: true,
    resources: [
      {
        kind: "skill",
        address: { kind: "skill", name: "git", sourceRegistrationId },
        origin: "registered",
        sourcePath: "/flat",
        sourceRegistrationId,
        directoryPath: "/flat/git",
        filePath: "/flat/git/SKILL.md",
        collection: true,
        description: "Use Git.",
        activation: "default",
        userActivation: "opt-in",
        dependencies: [],
        projects: [],
      },
    ],
    issues: [],
  });
  expect(explorerEntries(report, [], (path) => path)[0]?.facts).toContainEqual([
    "declared by",
    "skills collection",
  ]);
});

it("filters in order and keeps a selection visible in a large catalog", () => {
  const entries = Array.from({ length: 400 }, (_, index) => entry(`item-${index}`));
  let current = state(entries);
  for (const pressed of [
    key("/", "/"),
    ...Array.from("item-39", (character) => key(character, character)),
  ]) {
    const step = stepExplorer(current, pressed);
    expect(step._tag).toBe("next");
    if (step._tag === "next") current = step.state;
  }
  expect(visibleEntries(current).map((candidate) => candidate.title)).toEqual([
    "item-39",
    ...Array.from({ length: 10 }, (_, index) => `item-39${index}`),
  ]);
  current = { ...current, filtering: false };
  const end = stepExplorer(current, key("end"));
  expect(end._tag).toBe("next");
  if (end._tag === "next") {
    expect(selectedTitle(end.state)).toBe("item-399");
    expect(renderExplorerFrame(end.state, { columns: 80, rows: 12 }, plain)).toContain(
      "› item-399",
    );
  }
  // p no longer picks: it neither quits on a resource nor on an empty filter.
  expect(stepExplorer(current, key("p", "p"))).toMatchObject({ _tag: "next" });
  const empty = stepExplorer({ ...current, query: "no such thing", cursor: 0 }, key("p", "p"));
  expect(empty).toMatchObject({ _tag: "next" });
});

it("draws one line below minimum size and a complete frame after resize", () => {
  const initial = state([entry("review")]);
  const small = renderExplorerFrame(initial, { columns: 20, rows: 5 }, plain);
  expect(small).toContain("Enlarge the termina");
  expect(small).not.toContain("\u001b[2;1H");
  const large = renderExplorerFrame(initial, { columns: 80, rows: 12 }, plain);
  expect(large).toContain("\u001b[12;1H");
  expect(large).toContain("review");
});

const input = (name: string, text = name, ctrl = false): Terminal.UserInput => ({
  input: Option.some(text),
  key: { name, ctrl, meta: false, shift: false },
});

const scriptedTerminal = Effect.fnUntraced(function* (
  keys: ReadonlyArray<Terminal.UserInput>,
  end = false,
) {
  const queue = yield* Queue.make<Terminal.UserInput, Cause.Done>();
  for (const pressed of keys) yield* Queue.offer(queue, pressed);
  if (end) yield* Queue.end(queue);
  const displayed = yield* Ref.make<ReadonlyArray<string>>([]);
  const terminal = Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(12),
    size: unwatchedTerminalSize,
    readInput: Effect.succeed(queue),
    readLine: Effect.succeed(""),
    display: (text) => Ref.update(displayed, (values) => [...values, text]),
  });
  return { terminal, displayed };
});

it.layer(LiveTestLayer)("explorer sessions", (test) => {
  test.effect("applies a pasted filter, previews a file, picks, and restores the screen", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tack-explore-session-" });
      const file = path.join(root, "SKILL.md");
      yield* fs.writeFileString(file, "# Review\nPreview text\n");
      const initial = state([
        entry("git"),
        entry("review", "Skills", { kind: "file", path: file }),
      ]);
      const { terminal, displayed } = yield* scriptedTerminal([
        input("/", "/rev"),
        input("return", ""),
        input("return", ""),
        input("q"),
        input("p"),
        input("q"),
      ]);
      const result = yield* Effect.scoped(
        runExplorer(initial, plain).pipe(Effect.provideService(Terminal.Terminal, terminal)),
      );
      expect(result).toEqual({ interrupted: false });
      const frames = yield* Ref.get(displayed);
      expect(frames[0]).toBe("\u001b[?1049h\u001b[?25l");
      expect(frames.some((frame) => frame.includes("Preview text"))).toBe(true);
      expect(frames.at(-1)).toBe("\u001b[?1049l\u001b[?25h");
    }),
  );

  test.effect("quit, Ctrl+C, and end of input restore the screen with distinct results", () =>
    Effect.gen(function* () {
      for (const [keys, end, interrupted] of [
        [[input("q")], false, false],
        [[input("c", "\u0003", true)], false, true],
        [[], true, false],
      ] as const) {
        const { terminal, displayed } = yield* scriptedTerminal(keys, end);
        const result = yield* Effect.scoped(
          runExplorer(state([]), plain).pipe(Effect.provideService(Terminal.Terminal, terminal)),
        );
        expect(result).toEqual({ interrupted });
        expect((yield* Ref.get(displayed)).at(-1)).toBe("\u001b[?1049l\u001b[?25h");
      }
    }),
  );

  test.effect("redraws immediately on a terminal resize without a key", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.make<Terminal.UserInput, Cause.Done>();
      const resizes = yield* Queue.unbounded<"resize">();
      const columns = yield* Ref.make(20);
      const rows = yield* Ref.make(5);
      const displayed = yield* Ref.make<ReadonlyArray<string>>([]);
      const terminal = Terminal.make({
        columns: Ref.get(columns),
        rows: Ref.get(rows),
        size: unwatchedTerminalSize,
        readInput: Effect.succeed(queue),
        readLine: Effect.succeed(""),
        display: (text) =>
          Effect.gen(function* () {
            yield* Ref.update(displayed, (values) => [...values, text]);
            if (text.includes("Enlarge the termina")) {
              yield* Ref.set(columns, 80);
              yield* Ref.set(rows, 12);
              yield* Queue.offer(resizes, "resize");
            } else if (text.includes("\u001b[12;1H")) yield* Queue.offer(queue, input("q"));
          }),
      });
      yield* Effect.scoped(
        runExplorer(state([entry("review")]), plain, resizes).pipe(
          Effect.provideService(Terminal.Terminal, terminal),
        ),
      );
      const frames = yield* Ref.get(displayed);
      expect(frames.some((frame) => frame.includes("Enlarge the termina"))).toBe(true);
      expect(frames.some((frame) => frame.includes("\u001b[12;1H"))).toBe(true);
      expect(frames.at(-1)).toBe("\u001b[?1049l\u001b[?25h");
    }),
  );

  test.effect("restores the screen after a render failure", () =>
    Effect.gen(function* () {
      const { terminal: base, displayed } = yield* scriptedTerminal([]);
      const terminal = Terminal.make({
        columns: base.columns,
        rows: base.rows,
        size: base.size,
        readInput: base.readInput,
        readLine: base.readLine,
        display: (text) =>
          Ref.update(displayed, (values) => [...values, text]).pipe(
            Effect.flatMap(() =>
              text.includes("\u001b[1;1H") ? Effect.die("frame failure") : Effect.void,
            ),
          ),
      });
      const exit = yield* Effect.exit(
        Effect.scoped(
          runExplorer(state([]), plain).pipe(Effect.provideService(Terminal.Terminal, terminal)),
        ),
      );
      expect(exit._tag).toBe("Failure");
      expect((yield* Ref.get(displayed)).at(-1)).toBe("\u001b[?1049l\u001b[?25h");
    }),
  );

  test.effect("uses the reader corpus for a docs preview", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "tack-explore-docs-" });
      const directory = path.join(source, "knowledge");
      yield* fs.makeDirectory(directory);
      yield* fs.writeFileString(
        path.join(source, "tack.yaml"),
        "version: 1\nname: docs-source\ndocs:\n  - name: guide\n    path: knowledge\n",
      );
      yield* fs.writeFileString(path.join(directory, "chapter.md"), "# Chapter\n");
      const docs = entry("guide", "Docs", {
        kind: "docs",
        path: directory,
        sourcePath: source,
        sourceRegistrationId: "00000000-0000-4000-8000-000000000001",

        name: "guide",
      });
      const { terminal, displayed } = yield* scriptedTerminal([
        input("return", ""),
        input("q"),
        input("q"),
      ]);
      yield* Effect.scoped(
        runExplorer(state([docs]), plain).pipe(
          Effect.provideService(Terminal.Terminal, terminal),
          Effect.provide(ReaderCorpusLive),
        ),
      );
      expect((yield* Ref.get(displayed)).some((frame) => frame.includes("chapter.md"))).toBe(true);
    }),
  );

  test.effect("keeps browsing after a preview file becomes unreadable", () =>
    Effect.gen(function* () {
      const missing = entry("missing", "Skills", { kind: "file", path: "/missing/SKILL.md" });
      const { terminal, displayed } = yield* scriptedTerminal([
        input("return", ""),
        input("q"),
        input("q"),
      ]);
      const result = yield* Effect.scoped(
        runExplorer(state([missing]), plain).pipe(
          Effect.provideService(Terminal.Terminal, terminal),
        ),
      );
      expect(
        (yield* Ref.get(displayed)).some((frame) => frame.includes("Cannot read this file")),
      ).toBe(true);
      expect(result).toEqual({ interrupted: false });
    }),
  );

  test.effect("browses a registered source without changing state, destinations or history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tack-explore-readonly-" });
      const source = path.join(root, "source");
      const skill = path.join(source, "skills", "review");
      const options = {
        environment: { TACK_STATE_DIR: path.join(root, "state") },
        homeDirectory: root,
      };
      yield* fs.makeDirectory(skill, { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "tack.yaml"),
        "version: 1\nname: source\nskills:\n  - path: skills\n",
      );
      yield* fs.writeFileString(
        path.join(skill, "SKILL.md"),
        "---\nname: review\ndescription: Review a change.\n---\n# Review\n",
      );
      yield* initializeState(options);
      yield* registerSource(options, { sourcePath: source });
      const destination = path.join(root, "destination");
      const history = path.join(root, "history");
      yield* fs.writeFileString(destination, "managed link marker");
      yield* fs.writeFileString(history, "run history marker");
      const before = yield* readState(options);
      // Outside every project the window opens on the chooser; Esc keeps it read-only.
      const { terminal, displayed } = yield* scriptedTerminal([
        input("escape", ""),
        input("/", "/rev"),
        input("return", ""),
        input("return", ""),
        input("q"),
        input("q"),
      ]);
      const outcome = yield* Effect.scoped(
        exploreSelection(options, { cwd: root }).pipe(
          Effect.provideService(Terminal.Terminal, terminal),
          Effect.provideService(TerminalContext, interactive),
          Effect.provideService(Git, fakeGit("/tmp", [])),
          Effect.provide(BunServices.layer),
        ),
      );
      expect(outcome).toMatchObject({
        classification: "success",
        result: { kind: "explore-session" },
      });
      expect(yield* readState(options)).toEqual(before);
      expect(yield* fs.readFileString(destination)).toBe("managed link marker");
      expect(yield* fs.readFileString(history)).toBe("run history marker");
      expect((yield* Ref.get(displayed)).at(-1)).toBe("\u001b[?1049l\u001b[?25h");
    }),
  );

  test.effect("loads each resource with the declaration that found it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tack-explore-declared-" });
      const source = path.join(root, "source");
      const options = {
        environment: { TACK_STATE_DIR: path.join(root, "state") },
        homeDirectory: root,
      };
      yield* fs.makeDirectory(path.join(source, "vendor", "skills", "pdf"), { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "tack.yaml"),
        "version: 1\nname: source\nskills:\n  - path: vendor/skills\n",
      );
      yield* fs.writeFileString(
        path.join(source, "vendor", "skills", "pdf", "SKILL.md"),
        "---\nname: pdf\ndescription: Read a PDF.\n---\n",
      );
      yield* initializeState(options);
      yield* registerSource(options, { sourcePath: source });
      const { entries } = yield* loadExplorer(options, plain, undefined);
      expect(entries.find((candidate) => candidate.title === "pdf")?.facts).toContainEqual([
        "declared by",
        "skills: vendor/skills",
      ]);
    }),
  );

  test.effect("reports Ctrl+C as interruption with exit 130 after restoring the screen", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tack-explore-interrupt-" });
      const options = {
        environment: { TACK_STATE_DIR: path.join(root, "state") },
        homeDirectory: root,
      };
      yield* initializeState(options);
      const { terminal, displayed } = yield* scriptedTerminal([input("c", "\u0003", true)]);
      const { exit, stdout } = yield* runHost({
        args: ["--state-dir", path.join(root, "state"), "explore", "--json"],
        git: fakeGit("/tmp", []),
        terminal: interactive,
        env: { HOME: root },
      }).pipe(Effect.provideService(Terminal.Terminal, terminal));
      const envelope = decodeEnvelope(stdout);
      expect(envelope).toMatchObject({
        command: "explore",
        classification: "interruption",
        diagnostics: [{ code: "interrupted" }],
      });
      if (Exit.isFailure(exit))
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          exitCode: 130,
        });
      else throw new Error("Ctrl+C unexpectedly succeeded.");
      expect((yield* Ref.get(displayed)).at(-1)).toBe("\u001b[?1049l\u001b[?25h");
    }),
  );
});

const treed = (
  name: string,
  folders: ReadonlyArray<string>,
  options: { source?: string; section?: string } = {},
): ExplorerEntry => ({
  ...entry(name, options.section ?? "Skills"),
  tree: { ...(options.source === undefined ? {} : { source: options.source }), folders },
});
const press = (current: ExplorerState, ...pressed: ReadonlyArray<ExplorerKey>): ExplorerState => {
  let latest = current;
  for (const next of pressed) {
    const step = stepExplorer(latest, next);
    expect(step._tag).toBe("next");
    if (step._tag === "next") latest = step.state;
  }
  return latest;
};
const outline = (current: ExplorerState) =>
  visibleRows(current).map((row) =>
    row.kind === "folder"
      ? `${"  ".repeat(row.depth)}${row.expanded ? "v" : ">"} ${row.label} (${row.count})`
      : `${"  ".repeat(row.depth)}${row.entry.title}`,
  );

it("mirrors the source layout as a tree and merges single-folder chains", () => {
  const current = state([
    treed("building-effect-ai", ["skills", "00_effect"]),
    treed("handling-effect-errors", ["skills", "00_effect"]),
    treed("review", ["skills", "10_review"]),
    treed("git", ["skills"]),
    treed("loose", []),
    treed("review-docs", ["docs", "a", "b", "c"], { section: "Docs" }),
  ]);
  expect(outline(current)).toEqual([
    "v skills (4)",
    "  v 00_effect (2)",
    "    building-effect-ai",
    "    handling-effect-errors",
    "  v 10_review (1)",
    "    review",
    "  git",
    "loose",
    "v docs/a/b/c (1)",
    "  review-docs",
  ]);
});

it("groups by source first when entries carry several sources", () => {
  const current = state([
    treed("one", ["skills", "00_effect"], { source: "~/personal-brain" }),
    treed("two", ["skills"], { source: "~/personal-brain" }),
    treed("three", ["skills"], { source: "~/other" }),
  ]);
  expect(outline(current)).toEqual([
    "v ~/personal-brain (2)",
    "  v skills (2)",
    "    v 00_effect (1)",
    "      one",
    "    two",
    "v ~/other (1)",
    "  v skills (1)",
    "    three",
  ]);
});

it("expands, collapses and walks the tree from the keyboard", () => {
  let current = state([
    treed("a", ["skills", "00_effect"]),
    treed("b", ["skills", "00_effect"]),
    treed("c", ["skills", "10_other"]),
  ]);
  expect(outline(current)).toEqual([
    "v skills (3)",
    "  v 00_effect (2)",
    "    a",
    "    b",
    "  v 10_other (1)",
    "    c",
  ]);
  // Down to 00_effect, collapse with Left, then expand with Right.
  current = press(current, key("down"), key("left"));
  expect(outline(current)).toEqual([
    "v skills (3)",
    "  > 00_effect (2)",
    "  v 10_other (1)",
    "    c",
  ]);
  expect(current.cursor).toBe(1);
  current = press(current, key("right"));
  expect(visibleRows(current)).toHaveLength(6);
  // Right on an expanded folder enters it; Left on a leaf returns to its folder.
  current = press(current, key("right"));
  expect(selectedTitle(current)).toBe("a");
  current = press(current, key("left"));
  expect(selectedRow(current)).toMatchObject({ kind: "folder", label: "00_effect" });
  // Enter and Space toggle a folder without opening or picking anything.
  current = press(current, key("return"));
  expect(outline(current)[1]).toBe("  > 00_effect (2)");
  current = press(current, key("space", " "));
  expect(outline(current)[1]).toBe("  v 00_effect (2)");
  expect(stepExplorer(current, key("p", "p"))).toMatchObject({ _tag: "next" });
  expect(selectedTitle(current)).toBeUndefined();
  // Left on the top folder collapses it; Left again has nowhere to go.
  current = press(current, key("home"), key("h", "h"));
  expect(outline(current)).toEqual(["> skills (3)"]);
  expect(press(current, key("left")).cursor).toBe(0);
  // Navigation skips the entries of collapsed folders.
  current = press(current, key("l", "l"), key("down"), key("left"));
  expect(outline(current)).toEqual([
    "v skills (3)",
    "  > 00_effect (2)",
    "  v 10_other (1)",
    "    c",
  ]);
  current = press(current, key("down"), key("down"));
  expect(selectedTitle(current)).toBe("c");
});

it("keeps ancestors of filtered matches expanded", () => {
  let current = state([
    treed("alpha", ["skills", "00_effect"]),
    treed("beta", ["skills", "00_effect"]),
    treed("gamma", ["skills", "10_other"]),
  ]);
  current = press(current, key("down"), key("left"));
  expect(outline(current)).toContain("  > 00_effect (2)");
  current = press(current, key("/", "/"), ...Array.from("beta", (c) => key(c, c)));
  expect(outline(current)).toEqual(["v skills (1)", "  v 00_effect (1)", "    beta"]);
  expect(visibleEntries(current).map((candidate) => candidate.title)).toEqual(["beta"]);
  // A finished filter still shows every match; toggling is held until it is cleared.
  current = press(current, key("return"), key("home"), key("return"));
  expect(outline(current)).toEqual(["v skills (1)", "  v 00_effect (1)", "    beta"]);
  current = press(current, key("escape"));
  expect(outline(current)).toContain("  > 00_effect (2)");
});

it("handles deep nesting and a large catalog as a tree", () => {
  const deep = Array.from({ length: 12 }, (_, index) => `level-${index}`);
  const nested = state([treed("leaf", deep), treed("sibling", deep.slice(0, 6))]);
  expect(outline(nested)).toEqual([
    "v level-0/level-1/level-2/level-3/level-4/level-5 (2)",
    "  v level-6/level-7/level-8/level-9/level-10/level-11 (1)",
    "    leaf",
    "  sibling",
  ]);
  const entries = Array.from({ length: 400 }, (_, index) =>
    treed(`item-${index}`, ["skills", `group-${index % 20}`]),
  );
  let current = state(entries);
  expect(visibleRows(current)).toHaveLength(1 + 20 + 400);
  current = press(current, key("end"));
  expect(selectedTitle(current)).toBe("item-399");
  expect(renderExplorerFrame(current, { columns: 80, rows: 12 }, plain)).toContain("› ");
  expect(renderExplorerFrame(current, { columns: 80, rows: 12 }, plain)).toContain("item-399");
  // Collapsing the root hides all 420 rows below it; filtering stays immediate.
  current = press(current, key("home"), key("left"));
  expect(visibleRows(current)).toHaveLength(1);
  current = press(current, key("/", "/"), ...Array.from("item-39", (c) => key(c, c)));
  expect(visibleRows(current).filter((row) => row.kind === "entry")).toHaveLength(11);
});

it("draws folders and truncates long names with an ellipsis before the tags", () => {
  const long = "building-effect-persistence-and-workflows-extra-long";
  const current = state([treed(long, ["skills", "00_effect"]), treed("short", ["skills"])]);
  const frame = renderExplorerFrame(current, { columns: 80, rows: 12 }, plain);
  const text = frame.split("\u001b").join("\n");
  expect(text).toContain("▾ skills");
  expect(text).toContain("  ▾ 00_effect");
  const line = text.split("\n").find((candidate) => candidate.includes("building-")) ?? "";
  expect(line).toMatch(/building-[a-z-]+… +\+demo/);
  expect(line).not.toContain("extra-long");
  const folded = renderExplorerFrame(press(current, key("left")), { columns: 80, rows: 12 }, plain);
  expect(folded).toContain("▸ skills");
  expect(folded).not.toContain("00_effect");
});

it("projects directories relative to each source and groups several sources", () => {
  const sourceRegistrationId = "00000000-0000-4000-8000-000000000001";
  const skill = (name: string, sourcePath: string, directory: string) => ({
    kind: "skill",
    address: { kind: "skill", name, sourceRegistrationId },
    origin: "registered",
    sourcePath,
    sourceRegistrationId,
    directoryPath: `${sourcePath}/${directory}`,
    filePath: `${sourcePath}/${directory}/SKILL.md`,
    description: `About ${name}.`,
    activation: "default",
    dependencies: [],
    projects: [],
  });
  const docs = (name: string, sourcePath: string, directoryPath: string) => ({
    kind: "docs",
    address: { kind: "docs", name, sourceRegistrationId },
    origin: "registered",
    sourcePath,
    sourceRegistrationId,
    directoryPath,
    readerConfig: { kind: "source", path: sourcePath },
  });
  const project = (resources: ReadonlyArray<unknown>) =>
    explorerEntries(
      Schema.decodeUnknownSync(CatalogReportSchema)({
        kind: "catalog",
        complete: true,
        resources,
        issues: [],
      }),
      [],
      (path) => path.replace("/home/me", "~"),
    );
  const single = project([
    skill("ai", "/home/me/personal-brain", "skills/00_effect/ai"),
    skill("plain", "/home/me/personal-brain", "plain"),
    docs("tack", "/home/me/personal-brain", "/home/me/personal-brain/docs/tack"),
    docs("root", "/home/me/personal-brain", "/home/me/personal-brain"),
  ]);
  expect(single.map((candidate) => candidate.tree)).toEqual([
    { folders: ["skills", "00_effect"] },
    { folders: [] },
    { folders: ["docs"] },
    { folders: [] },
  ]);
  const several = project([
    skill("ai", "/home/me/personal-brain", "skills/00_effect/ai"),
    skill("other", "/home/me/other", "skills/other"),
    { ...skill("use-tack", "/opt/tack/builtin", "skills/use-tack"), origin: "builtin" },
  ]);
  expect(outline(initialExplorerState("Tack explorer", several))).toEqual([
    "v ~/personal-brain (1)",
    "  v skills/00_effect (1)",
    "    ai",
    "v ~/other (1)",
    "  v skills (1)",
    "    other",
    "v built-in (1)",
    "  use-tack",
  ]);
});
