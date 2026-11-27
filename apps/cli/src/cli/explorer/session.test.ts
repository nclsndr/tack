import { expect, it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Option, Path, Queue, Ref, Terminal } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { unwatchedTerminalSize } from "../../../test/support/explorer.ts";
import { ReaderCorpusLive } from "../../platform/reader/search.ts";
import { makeStyle } from "../human/style.ts";
import { initialExplorerState, type ExplorerEntry, type ExplorerState } from "./model.ts";
import type { ExplorerDestinations } from "./profile-editor.ts";
import { runExplorer } from "./session.ts";

const plain = makeStyle({ color: false, homeDirectory: undefined, width: 80 });
const sourceRegistrationId = "00000000-0000-4000-8000-000000000001";
const skill = (name: string): ExplorerEntry => ({
  id: `Skills/${name}`,
  section: "Skills",
  title: name,
  description: "",
  tags: [],
  facts: [],
  issue: false,
  address: { kind: "skill", name, sourceRegistrationId },
  editable: {
    kind: "choice",
    address: { kind: "skill", name, sourceRegistrationId },
    current: undefined,
  },
});

const typed = (name: string, text = name): Terminal.UserInput => ({
  input: Option.some(text),
  key: { name, ctrl: false, meta: false, shift: false },
});
/** A key such as an arrow that the terminal reports without any text. */
const bare = (name: string): Terminal.UserInput => ({
  input: Option.none(),
  key: { name, ctrl: false, meta: false, shift: false },
});

/** A terminal that answers `keys` in order and records every frame it is asked to draw. */
const scriptedTerminal = Effect.fnUntraced(function* (keys: ReadonlyArray<Terminal.UserInput>) {
  const queue = yield* Queue.make<Terminal.UserInput, Cause.Done>();
  for (const pressed of keys) yield* Queue.offer(queue, pressed);
  const displayed = yield* Ref.make<ReadonlyArray<string>>([]);
  const terminal = Terminal.make({
    columns: Effect.succeed(100),
    rows: Effect.succeed(20),
    size: unwatchedTerminalSize,
    readInput: Effect.succeed(queue),
    readLine: Effect.succeed(""),
    display: (text) => Ref.update(displayed, (values) => [...values, text]),
  });
  return { terminal, frames: Ref.get(displayed).pipe(Effect.map((values) => values.join("\n"))) };
});

const session = (
  initial: ExplorerState,
  keys: ReadonlyArray<Terminal.UserInput>,
  destinations?: ExplorerDestinations,
) =>
  Effect.gen(function* () {
    const { terminal, frames } = yield* scriptedTerminal(keys);
    const result = yield* Effect.scoped(
      runExplorer(initial, plain, undefined, undefined, destinations).pipe(
        Effect.provideService(Terminal.Terminal, terminal),
      ),
    );
    return { result, frames: yield* frames };
  });

it.layer(LiveTestLayer)("explorer session", (test) => {
  test.effect("reads a key that carries no text by its name", () =>
    Effect.gen(function* () {
      const { result, frames } = yield* session(
        initialExplorerState("Tack", [skill("a"), skill("b")]),
        [bare("down"), typed("q")],
      );
      expect(result).toEqual({ interrupted: false });
      expect(frames).toMatch(/› b/);
    }),
  );

  test.effect("says a docs folder without Markdown has nothing to read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "tack-session-docs-" });
      const directory = path.join(source, "knowledge");
      yield* fs.makeDirectory(directory);
      const docs: ExplorerEntry = {
        id: "Docs/guide",
        section: "Docs",
        title: "guide",
        description: "",
        tags: [],
        facts: [],
        issue: false,
        preview: { kind: "docs", path: directory, sourcePath: source, name: "guide" },
      };
      const { frames } = yield* session(initialExplorerState("Tack", [docs]), [
        typed("return", ""),
        typed("q"),
        typed("q"),
      ]).pipe(Effect.provide(ReaderCorpusLive));
      expect(frames).toContain("No Markdown files in the reader corpus.");
    }),
  );

  test.effect("names a docs folder whose reader configuration cannot be loaded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "tack-session-docs-" });
      const directory = path.join(source, "knowledge");
      yield* fs.makeDirectory(directory);
      yield* fs.writeFileString(path.join(directory, "chapter.md"), "# Chapter\n");
      const docs: ExplorerEntry = {
        id: "Docs/guide",
        section: "Docs",
        title: "guide",
        description: "",
        tags: [],
        facts: [],
        issue: false,
        preview: {
          kind: "docs",
          path: directory,
          sourcePath: source,
          name: "guide",
          readerConfig: { kind: "source", path: path.join(source, "missing.json") },
        },
      };
      const { frames } = yield* session(initialExplorerState("Tack", [docs]), [
        typed("return", ""),
        typed("q"),
        typed("q"),
      ]).pipe(Effect.provide(ReaderCorpusLive));
      expect(frames).toContain("Cannot load docs: ");
    }),
  );

  test.effect(
    "without an editor, a review or apply request leaves the staged state as it was",
    () =>
      Effect.gen(function* () {
        const initial = initialExplorerState("Tack", [skill("a")], { _tag: "user" });
        const { result, frames } = yield* session(initial, [
          typed("i"),
          typed("c"),
          typed("q"),
          typed("q"),
        ]);
        expect(result).toEqual({ interrupted: false });
        expect(frames).not.toContain("Review: user");
        expect(frames).toContain("Staged changes will be discarded");
      }),
  );

  test.effect("keeps the current editor when a destination cannot open", () =>
    Effect.gen(function* () {
      const opened: Array<string> = [];
      const destinations: ExplorerDestinations = {
        options: [
          {
            label: "Project demo",
            destination: { _tag: "project", projectName: "demo" },
          },
        ],
        open: (state, destination) => {
          opened.push(destination._tag);
          return Effect.succeed({
            state: {
              ...state,
              preview: { title: "Cannot change destination", lines: ["gone"], offset: 0 },
            },
            editor: undefined,
          });
        },
      };
      const initial = {
        ...initialExplorerState("Tack", [skill("a")]),
        destinations: destinations.options,
      };
      const { frames } = yield* session(
        initial,
        [typed("d"), typed("return", ""), typed("q"), typed("q")],
        destinations,
      );
      expect(opened).toEqual(["project"]);
      expect(frames).toContain("Cannot change destination");
    }),
  );

  test.effect("without destinations, choosing one only closes the menu", () =>
    Effect.gen(function* () {
      const initial = {
        ...initialExplorerState("Tack", [skill("a")]),
        destinations: [
          { label: "User", destination: { _tag: "user" } },
        ] satisfies ExplorerState["destinations"],
      };
      const { result, frames } = yield* session(initial, [
        typed("d"),
        typed("return", ""),
        typed("q"),
      ]);
      expect(frames).toContain("Choose destination");
      expect(result).toEqual({ interrupted: false });
    }),
  );
});
