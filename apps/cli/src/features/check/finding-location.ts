import { Effect, FileSystem, Option } from "effect";
import type { CheckFinding } from "../../domain/check/check-schema.ts";

type LocatedFinding = Omit<CheckFinding, "line"> & {
  readonly line?: number;
  readonly field?: string;
};

const indentOf = (line: string) => line.length - line.trimStart().length;

const isListItem = (line: string) => /^\s*-(\s|$)/.test(line);

/**
 * The lines of the block-list items under the key at line `start`, indented by `keyIndent`, in
 * order. The list ends at the next key at the key's indentation or less. Only items at the first
 * item's indentation count, so a list nested inside an item is passed over.
 */
const listItemLines = (lines: ReadonlyArray<string>, start: number, keyIndent: number) => {
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      line.trim() !== "" &&
      line.trimStart().startsWith("#") === false &&
      (indentOf(line) < keyIndent || (indentOf(line) === keyIndent && isListItem(line) === false)),
  );
  const items = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .flatMap((line, offset) =>
      isListItem(line) === true ? [{ indent: indentOf(line), line: start + 1 + offset }] : [],
    );
  return items.filter(({ indent }) => indent === items[0]?.indent).map(({ line }) => line);
};

/**
 * The one-based line of the dependency at `position` in a resource file's Tack metadata. A list
 * written inline anchors at its `dependencies:` key, and metadata with no such line at line 1.
 */
export const dependencyLine = (text: string, position: number) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*["']?dependencies["']?:/.test(line) === true);
  const key = lines[start];
  return key === undefined
    ? 1
    : (listItemLines(lines, start, indentOf(key))[position] ?? start) + 1;
};

/**
 * Retains exact detector lines, or anchors YAML fields and list entries such as `skills[1]` when
 * their text is available. An entry that cannot be found anchors at its key.
 */
export const locateFinding = Effect.fnUntraced(function* (
  finding: LocatedFinding,
): Effect.fn.Return<CheckFinding, never, FileSystem.FileSystem> {
  if (finding.line !== undefined) return { ...finding, line: Math.max(1, finding.line) };
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(finding.file).pipe(Effect.option);
  const lines = Option.isSome(text) === true ? text.value.split(/\r?\n/) : [];
  const field =
    finding.field?.split(/[.[]/)[0] ??
    (finding.code === "profile-publication-mismatch" ? "name" : undefined);
  const start = field === undefined ? -1 : lines.findIndex((line) => line.startsWith(`${field}:`));
  const item = finding.field?.match(/^[^.[]+\[(\d+)\]/)?.[1];
  const itemLines = item === undefined || start < 0 ? [] : listItemLines(lines, start, 0);
  return {
    ...finding,
    line: Math.max(1, (itemLines[Number(item)] ?? start) + 1),
    message: finding.message,
    ...(finding.remedy === undefined ? {} : { remedy: finding.remedy }),
  };
});
