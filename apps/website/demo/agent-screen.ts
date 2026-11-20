import type { AgentCall, TurnFigures } from "./agent-walkthrough.ts";

/** The first lines of a call's output that the screen keeps, and how many it leaves out. */
export type KeptOutput = { readonly lines: ReadonlyArray<string>; readonly more: number };

/**
 * One row group of the agent screen. Consecutive tool calls share one `tools` block, which runs
 * until its last call's output lands. A reply shows its first `shown` words while it streams.
 */
export type AgentEntry =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "tools";
      readonly running: boolean;
      readonly calls: ReadonlyArray<{
        readonly call: AgentCall;
        readonly output: KeptOutput | undefined;
      }>;
    }
  | { readonly kind: "assistant"; readonly text: string; readonly shown: number }
  | { readonly kind: "status"; readonly text: string };

const escape = String.fromCharCode(27);
const ansi = new RegExp(`${escape}\\[[0-9;]*m`, "gu");

/** The first `keep` lines of `output` that hold more than colour codes and spaces. */
export const keptOutput = (output: string, keep: number): KeptOutput => {
  const lines = output.split("\n").filter((line) => line.replace(ansi, "").trim() !== "");
  return { lines: lines.slice(0, keep), more: Math.max(0, lines.length - keep) };
};

/**
 * Sums up a block of `count` calls the way a coding agent folds them: "Ran 2 shell commands", or
 * "Running 1 shell command…" while the last one runs.
 */
export const toolSummary = (count: number, running: boolean) =>
  `${running === true ? "Running" : "Ran"} ${count} shell ${count === 1 ? "command" : "commands"}${running === true ? "…" : ""}`;

/** `entries` with `call` added to the running block, or to a new one after anything else. */
export const withCall = (
  entries: ReadonlyArray<AgentEntry>,
  call: AgentCall,
): ReadonlyArray<AgentEntry> => {
  const last = entries.at(-1);
  const shown = { call, output: undefined };
  return last?.kind === "tools"
    ? [...entries.slice(0, -1), { ...last, running: true, calls: [...last.calls, shown] }]
    : [...entries, { kind: "tools", running: true, calls: [shown] }];
};

/** `entries` with the last call's `output` in place, keeping `keep` lines; its block stops running. */
export const withCallOutput = (
  entries: ReadonlyArray<AgentEntry>,
  output: string,
  keep: number,
): ReadonlyArray<AgentEntry> => {
  const last = entries.at(-1);
  if (last?.kind !== "tools") return entries;
  const calls = last.calls.map((shown, index) =>
    index === last.calls.length - 1 ? { ...shown, output: keptOutput(output, keep) } : shown,
  );
  return [...entries.slice(0, -1), { ...last, running: false, calls }];
};

/** `entries` with the last reply showing its first `count` words; anything else is left alone. */
export const withReplyShown = (
  entries: ReadonlyArray<AgentEntry>,
  count: number,
): ReadonlyArray<AgentEntry> => {
  const last = entries.at(-1);
  return last?.kind === "assistant"
    ? [...entries.slice(0, -1), { ...last, shown: count }]
    : entries;
};

/** A run of a reply's text: plain, inline code, or bold. */
export type ReplySpan = { readonly kind: "text" | "code" | "bold"; readonly text: string };

/** A reply line: a paragraph line, a `- ` list item, or the gap of an empty line. */
export type ReplyBlock = {
  readonly kind: "paragraph" | "item" | "gap";
  readonly spans: ReadonlyArray<ReplySpan>;
};

const spansOf = (line: string): ReadonlyArray<ReplySpan> =>
  line
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/u)
    .filter((part) => part !== "")
    .map((part) =>
      part.startsWith("`")
        ? { kind: "code", text: part.slice(1, -1) }
        : part.startsWith("**")
          ? { kind: "bold", text: part.slice(2, -2) }
          : { kind: "text", text: part },
    );

/** Splits a reply into lines with their inline code and bold. */
export const replyBlocks = (text: string): ReadonlyArray<ReplyBlock> =>
  text
    .split("\n")
    .map((line) =>
      line === ""
        ? { kind: "gap", spans: [] }
        : line.startsWith("- ")
          ? { kind: "item", spans: spansOf(line.slice(2)) }
          : { kind: "paragraph", spans: spansOf(line) },
    );

/** A reply's words, a code or bold run counting as one, each with the space before it. */
const words = (text: string) => text.match(/\s*(`[^`]*`|\*\*[^*]*\*\*|\S+)/gu) ?? [];

/** How many words `text` streams in. */
export const wordCount = (text: string) => words(text).length;

/** The first `count` words of `text`, so a reply streams in without opening a span it cannot close. */
export const streamedText = (text: string, count: number) =>
  words(text).slice(0, count).join("").trimStart();

/** The live spinner's line: the verb, then the time and tokens once there are any. */
export const liveStatus = (verb: string, figures: TurnFigures) =>
  figures.seconds === 0 && figures.tokens === 0
    ? `${verb}…`
    : `${verb}… (${figures.seconds}s · ↓ ${figures.tokens} tokens)`;

/** The line a finished turn leaves behind. */
export const doneStatus = (verb: string, seconds: number) => `${verb} for ${seconds}s`;

/** The spinner's verbs, one pair per beat in turn: what it says live, and once the turn is done. */
export const spinnerVerbs = [
  { live: "Contemplating", done: "Crunched" },
  { live: "Pondering", done: "Worked" },
  { live: "Considering", done: "Churned" },
  { live: "Weighing", done: "Cooked" },
  { live: "Mulling", done: "Brewed" },
] as const;
