import { Data, Effect, FileSystem, Option, Queue, Terminal } from "effect";
import { Prompt } from "effect/cli";
import { ReaderCorpus } from "../../services/reader-corpus.ts";
import type { Style } from "../human/style.ts";
import { renderExplorerFrame } from "./frame.ts";
import { destinationText } from "./edit.ts";
import type { ExplorerEditor } from "./editor.ts";
import type { ExplorerDestinations } from "./profile-editor.ts";
import {
  pendingChanges,
  stepExplorer,
  withAppliedEntries,
  withPreview,
  withReview,
  type ExplorerEntry,
  type ExplorerKey,
  type ExplorerState,
} from "./model.ts";

const Action = Data.taggedEnum<Prompt.ActionDefinition>();
const enterScreen = "\u001b[?1049h\u001b[?25l";
const leaveScreen = "\u001b[?1049l\u001b[?25h";
const previewLimit = 2000;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type ExplorerResult = {
  readonly interrupted: boolean;
};

const keysOf = (input: Terminal.UserInput): ReadonlyArray<ExplorerKey> => {
  const text = Option.getOrUndefined(input.input);
  const characters =
    text === undefined ? [] : Array.from(segmenter.segment(text), ({ segment }) => segment);
  if (characters.length > 1 && !input.key.ctrl)
    return characters.map((character) => ({ name: character, input: character, ctrl: false }));
  return [{ name: input.key.name, input: text, ctrl: input.key.ctrl }];
};

const loadPreview = Effect.fnUntraced(function* (entry: ExplorerEntry, style: Style) {
  const preview = entry.preview;
  // Coverage skip: unreachable guard; the model opens only entries that have a preview.
  /* v8 ignore next -- @preserve */
  if (preview === undefined) return [entry.title, []] as const;
  if (preview.kind === "docs") {
    const reader = yield* ReaderCorpus;
    const corpus = yield* reader
      .loadProject({
        project: { name: "explore", root: preview.sourcePath ?? preview.path },
        resources: [
          {
            name: preview.name ?? entry.title,
            sourceRegistrationId: preview.sourceRegistrationId ?? "explore",
            sourcePath: preview.sourcePath ?? preview.path,
            directoryPath: preview.path,
            ...(preview.readerConfig === undefined ? {} : { readerConfig: preview.readerConfig }),
          },
        ],
        issues: [],
      })
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({ documents: [], issues: [{ message: error.message }] }),
        ),
      );
    const lines = [
      ...corpus.documents.map((document) => document.relativePath),
      ...corpus.issues.map((issue) => `Cannot load docs: ${issue.message}`),
    ];
    return [
      style.path(preview.path),
      lines.length === 0 ? ["No Markdown files in the reader corpus."] : lines,
    ] as const;
  }
  const fs = yield* FileSystem.FileSystem;
  const lines = yield* fs.readFileString(preview.path).pipe(
    Effect.map((content) =>
      content
        .split(/\r?\n/)
        .slice(0, previewLimit)
        .map((line) => line.replaceAll("\t", "  ")),
    ),
    Effect.catch((error) => Effect.succeed([`Cannot read this file: ${error.message}`])),
  );
  return [style.path(preview.path), lines] as const;
});

/** Runs one terminal session. The caller checks interactive eligibility before calling this. */
export const runExplorer = Effect.fnUntraced(function* (
  initial: ExplorerState,
  style: Style,
  suppliedResizeEvents?: Queue.Queue<"resize">,
  editor?: ExplorerEditor,
  destinations?: ExplorerDestinations,
) {
  let activeEditor = editor;
  const terminal = yield* Terminal.Terminal;
  const fileSystem = yield* FileSystem.FileSystem;
  const readerCorpus = yield* ReaderCorpus;
  const events = suppliedResizeEvents ?? (yield* Queue.unbounded<"resize">());
  const listener = () => {
    Queue.offerUnsafe(events, "resize");
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => process.stdout.on("resize", listener)),
    () => Effect.sync(() => process.stdout.off("resize", listener)),
  );
  const dimensions = Effect.all({ columns: terminal.columns, rows: terminal.rows });
  const prompt = Prompt.Custom<ExplorerState, ExplorerResult, "resize">(initial, events, {
    clear: () => Effect.succeed(""),
    render: (state, action) =>
      action._tag === "Submit"
        ? Effect.succeed("")
        : dimensions.pipe(Effect.map((size) => renderExplorerFrame(state, size, style))),
    process: (event, state) =>
      Effect.gen(function* () {
        if (event._tag === "Event") return Action.NextFrame({ state });
        let current = state;
        for (const key of keysOf(event.input)) {
          const step = stepExplorer(current, key);
          if (step._tag === "interrupt") return Action.Submit({ value: { interrupted: true } });
          if (step._tag === "quit") return Action.Submit({ value: { interrupted: false } });
          if (step._tag === "destination" && destinations !== undefined) {
            const opened = yield* destinations.open(step.state, step.destination);
            current = opened.state;
            if (opened.editor !== undefined) activeEditor = opened.editor;
          } else if (
            step._tag === "review" &&
            activeEditor !== undefined &&
            step.state.edit !== undefined
          ) {
            const lines = yield* activeEditor.preview(pendingChanges(step.state));
            current = withReview(step.state, {
              phase: "preview",
              title: `Review: ${destinationText(step.state.edit.namespace)}`,
              lines,
            });
          } else if (
            step._tag === "apply" &&
            activeEditor !== undefined &&
            step.state.edit !== undefined
          ) {
            const applied = yield* activeEditor.apply(pendingChanges(step.state));
            current =
              applied.nextState ??
              withAppliedEntries(step.state, applied.entries, {
                phase: "result",
                title: `${step.state.edit.namespace._tag === "profile" ? "Saved" : "Applied"}: ${destinationText(step.state.edit.namespace)}`,
                lines: applied.lines,
              });
          } else if (
            step._tag === "review" ||
            step._tag === "apply" ||
            step._tag === "destination"
          ) {
            current = step.state;
          } else if (step._tag === "open") {
            const [title, lines] = yield* loadPreview(step.entry, style).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(ReaderCorpus, readerCorpus),
            );
            current = withPreview(step.state, title, lines);
          } else current = step.state;
        }
        return Action.NextFrame({ state: current });
      }),
  });
  return yield* terminal.display(enterScreen).pipe(
    Effect.orDie,
    Effect.flatMap(() =>
      Prompt.run(prompt).pipe(
        Effect.catchTag("QuitError", () => {
          const completed: ExplorerResult = { interrupted: false };
          return Effect.succeed(completed);
        }),
      ),
    ),
    Effect.ensuring(Effect.orDie(terminal.display(leaveScreen))),
  );
});
