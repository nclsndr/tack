/* oxlint-disable eslint/no-control-regex -- Frame normalization intentionally removes ANSI escape codes. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, Option, Queue, Ref, Terminal } from "effect";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { unwatchedTerminalSize } from "./support/explorer.ts";
import { renderExplorerFrame } from "../src/cli/explorer/frame.ts";
import { runExplorer } from "../src/cli/explorer/session.ts";
import {
  initialExplorerState,
  stepExplorer,
  withAppliedEntries,
  withReview,
  type ExplorerEntry,
  type ExplorerState,
} from "../src/cli/explorer/model.ts";
import { makeStyle } from "../src/cli/human/style.ts";

const size = { columns: 80, rows: 14 };
const style = makeStyle({ color: false, homeDirectory: undefined, width: size.columns });
const sourceRegistrationId = "00000000-0000-4000-8000-000000000001";
const entry: ExplorerEntry = {
  id: "Skills/fixture-review",
  section: "Skills",
  title: "fixture-review",
  description: "Review a fixed change.",
  tags: ["source"],
  facts: [["address", "shared skill fixture-review"]],
  issue: false,
  address: { kind: "skill", name: "fixture-review", sourceRegistrationId },
  editable: {
    kind: "choice",
    address: { kind: "skill", name: "fixture-review", sourceRegistrationId },
    current: undefined,
  },
};
const staged = (): ExplorerState => {
  const initial = initialExplorerState("Tack explorer", [entry], { _tag: "user" });
  const step = stepExplorer(initial, { name: "i", input: "i", ctrl: false });
  if (step._tag !== "next") throw new Error("Could not stage the fixture.");
  return step.state;
};
const reviewLines = [
  "Staged changes in the user namespace",
  "  include  shared skill fixture-review",
  "",
  "Nothing has been written. This is the plan tack sync would apply:",
  "claude → user: 1 to link",
  "  link       .claude/skills/fixture-review  shared skill fixture-review",
  "  final review line",
];
const resultLines = [
  "saved   include shared skill fixture-review",
  "skills  2 applied, 0 failed, 0 skipped",
  "  final result line",
];
const review = () =>
  withReview(staged(), { phase: "preview", title: "Review: user", lines: reviewLines });
const result = () =>
  withAppliedEntries(staged(), [{ ...entry, tags: ["+user"] }], {
    phase: "result",
    title: "Applied: user",
    lines: resultLines,
  });

// Update with: UPDATE_EXPLORER_FRAMES=1 bun --bun vitest run apps/cli/test/cli-explorer-frames.host.test.ts
// Keep these text files in the same commit as an intentional frame change.
const plainFrame = (frame: string): string =>
  frame
    .replaceAll(/\u001b\[[0-9]+;1H/g, "\n")
    .replaceAll(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .slice(1)
    .map((line) => line.trimEnd())
    .join("\n") + "\n";

it("matches the fixed edit, review and result reference frames", () => {
  const frames = { edit: staged(), review: review(), result: result() };
  for (const [name, state] of Object.entries(frames)) {
    const file = join(import.meta.dirname, "snapshots", `explorer-${name}.txt`);
    const actual = plainFrame(renderExplorerFrame(state, size, style));
    if (process.env["UPDATE_EXPLORER_FRAMES"] === "1") writeFileSync(file, actual);
    expect(actual).toBe(readFileSync(file, "utf8"));
  }
});

it("keeps review and result content reachable across small, narrow and large sizes", () => {
  for (const [name, initial, finalLine] of [
    ["Review: user", review(), "final review line"],
    ["Applied: user", result(), "final result line"],
  ] as const) {
    const small = renderExplorerFrame(initial, { columns: 20, rows: 5 }, style);
    expect(small).toContain("Enlarge the termina");
    const narrow = renderExplorerFrame(initial, { columns: 40, rows: 8 }, style);
    expect(narrow).toContain(name);
    expect(narrow).toContain(name === "Review: user" ? "y apply these changes" : "↑↓ scroll");
    let current = initial;
    for (let index = 0; index < 8; index++) {
      const step = stepExplorer(current, { name: "down", ctrl: false });
      if (step._tag !== "next") throw new Error("Review scrolling stopped.");
      current = step.state;
    }
    expect(renderExplorerFrame(current, { columns: 40, rows: 8 }, style)).toContain(finalLine);
    const large = renderExplorerFrame(initial, { columns: 100, rows: 20 }, style);
    expect(large).toContain(finalLine);
  }
});

const input = (name: string, text = name): Terminal.UserInput => ({
  input: Option.some(text),
  key: { name, ctrl: false, meta: false, shift: false },
});

it.layer(LiveTestLayer)("review and result resize events", (test) => {
  test.effect("redraws both screens after resize without requiring another key", () =>
    Effect.gen(function* () {
      const keys = yield* Queue.unbounded<Terminal.UserInput>();
      const resizes = yield* Queue.unbounded<"resize">();
      const dimensions = yield* Ref.make({ columns: 80, rows: 14 });
      const phase = yield* Ref.make(0);
      const displayed = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Queue.offer(keys, input("i"));
      yield* Queue.offer(keys, input("c"));
      const terminal = Terminal.make({
        columns: Ref.get(dimensions).pipe(Effect.map((value) => value.columns)),
        rows: Ref.get(dimensions).pipe(Effect.map((value) => value.rows)),
        size: unwatchedTerminalSize,
        readInput: Effect.succeed(keys),
        readLine: Effect.succeed(""),
        display: (frame) =>
          Effect.gen(function* () {
            yield* Ref.update(displayed, (frames) => [...frames, frame]);
            const step = yield* Ref.get(phase);
            const reviewFrame = frame.includes("Review: user");
            const resultFrame = frame.includes("Applied: user");
            if (step === 0 || step === 2 || step === 3) {
              if (!reviewFrame) return;
            } else if (step === 4 || step === 6 || step === 7) {
              if (!resultFrame) return;
            } else if (!frame.includes("Enlarge the termina")) return;
            if (step >= 8) return;
            yield* Ref.set(phase, step + 1);
            if (step === 0 || step === 4) yield* Ref.set(dimensions, { columns: 20, rows: 5 });
            if (step === 1 || step === 5) yield* Ref.set(dimensions, { columns: 40, rows: 8 });
            if (step === 2 || step === 6) yield* Ref.set(dimensions, { columns: 100, rows: 20 });
            if ([0, 1, 2, 4, 5, 6].includes(step)) yield* Queue.offer(resizes, "resize");
            if (step === 3) yield* Queue.offer(keys, input("y"));
            if (step === 7) {
              yield* Queue.offer(keys, input("q"));
              yield* Queue.offer(keys, input("q"));
            }
          }),
      });
      const editor = {
        preview: () => Effect.succeed(reviewLines),
        apply: () => Effect.succeed({ lines: resultLines, entries: [entry] }),
      };
      yield* Effect.scoped(
        runExplorer(
          initialExplorerState("Tack explorer", [entry], { _tag: "user" }),
          style,
          resizes,
          editor,
        ).pipe(
          Effect.provideService(Terminal.Terminal, terminal),
          Effect.provide(BunServices.layer),
        ),
      );
      expect(yield* Ref.get(phase)).toBe(8);
      const frames = yield* Ref.get(displayed);
      expect(frames.filter((frame) => frame.includes("Enlarge the termina"))).toHaveLength(2);
      expect(
        frames.some((frame) => frame.includes("\u001b[8;1H") && frame.includes("Review: user")),
      ).toBe(true);
      expect(
        frames.some((frame) => frame.includes("\u001b[20;1H") && frame.includes("Review: user")),
      ).toBe(true);
      expect(
        frames.some((frame) => frame.includes("\u001b[8;1H") && frame.includes("Applied: user")),
      ).toBe(true);
      expect(
        frames.some((frame) => frame.includes("\u001b[20;1H") && frame.includes("Applied: user")),
      ).toBe(true);
      expect(frames.at(-1)).toBe("\u001b[?1049l\u001b[?25h");
    }),
  );
});
