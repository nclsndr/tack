import { Effect, FileSystem, Option } from "effect";
import type { CheckFinding } from "../../domain/check/check-schema.ts";

type LocatedFinding = Omit<CheckFinding, "line"> & {
  readonly line?: number;
  readonly field?: string;
};

/**
 * The lines of the block-list items under the top-level key at line `start`, in order. Only items
 * at the first item's indentation count, so a list nested inside an item is passed over.
 */
const listItemLines = (lines: ReadonlyArray<string>, start: number) => {
  const end = lines.findIndex((line, index) => index > start && /^[^\s#-]/.test(line) === true);
  const items = lines.slice(start + 1, end < 0 ? undefined : end).flatMap((line, offset) => {
    const indent = line.match(/^(\s*)-(\s|$)/)?.[1];
    return indent === undefined ? [] : [{ indent: indent.length, line: start + 1 + offset }];
  });
  return items.filter(({ indent }) => indent === items[0]?.indent).map(({ line }) => line);
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
  const itemLines = item === undefined || start < 0 ? [] : listItemLines(lines, start);
  return {
    ...finding,
    line: Math.max(1, (itemLines[Number(item)] ?? start) + 1),
    message: finding.message,
    ...(finding.remedy === undefined ? {} : { remedy: finding.remedy }),
  };
});
