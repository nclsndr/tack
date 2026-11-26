import { Effect, FileSystem, Option } from "effect";
import type { CheckFinding } from "../../domain/check/check-schema.ts";
import { fieldLine } from "../../domain/sources/field-line.ts";

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
 * The index of the first direct child of the key at `parent` that `pattern` matches once
 * unindented, or -1. The block ends at the next non-blank line indented no deeper than the key, and
 * its direct children are its least indented lines, so a line inside a child's value never matches.
 */
const keyWithin = (lines: ReadonlyArray<string>, parent: number, pattern: RegExp) => {
  const parentLine = lines[parent];
  if (parentLine === undefined) return -1;
  const indent = indentOf(parentLine);
  const end = lines.findIndex(
    (line, index) => index > parent && line.trim() !== "" && indentOf(line) <= indent,
  );
  const block = lines.slice(parent + 1, end < 0 ? undefined : end);
  const childIndent = Math.min(
    ...block.filter((line) => line.trim() !== "").map((line) => indentOf(line)),
  );
  const child = block.findIndex(
    (line) => indentOf(line) === childIndent && pattern.test(line.trimStart()) === true,
  );
  return child < 0 ? -1 : parent + 1 + child;
};

/**
 * The one-based line of the dependency at `position` in the `metadata.tack` of a resource file's
 * frontmatter. Only the frontmatter is read, so a body line or another key named `dependencies`
 * never anchors it. Without a block list item it anchors at the closest key it finds:
 * `dependencies`, then `tack`, then `metadata`, then line 1.
 */
export const dependencyLine = (text: string, position: number) => {
  const lines = text.split(/\r?\n/);
  const closing =
    lines[0] === "---" ? lines.findIndex((line, index) => index > 0 && line === "---") : -1;
  const frontmatter = lines.slice(0, Math.max(closing, 0));
  const metadata = frontmatter.findIndex((line) => /^metadata\s*:/.test(line) === true);
  const tack = keyWithin(frontmatter, metadata, /^["']?tack["']?\s*:/);
  const dependencies = keyWithin(frontmatter, tack, /^["']?dependencies["']?\s*:/);
  const key = frontmatter[dependencies];
  const item =
    key === undefined
      ? undefined
      : listItemLines(frontmatter, dependencies, indentOf(key))[position];
  return ([item ?? -1, dependencies, tack, metadata].find((index) => index >= 0) ?? 0) + 1;
};

/**
 * Retains exact detector lines, or anchors YAML fields and list entries such as `skills[1]` when
 * their text is available. An entry that cannot be found anchors at the deepest key found.
 */
export const locateFinding = Effect.fnUntraced(function* (
  finding: LocatedFinding,
): Effect.fn.Return<CheckFinding, never, FileSystem.FileSystem> {
  if (finding.line !== undefined) return { ...finding, line: Math.max(1, finding.line) };
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(finding.file).pipe(Effect.option);
  const field =
    finding.field ?? (finding.code === "profile-publication-mismatch" ? "name" : undefined);
  return {
    ...finding,
    line: Option.isSome(text) === true ? fieldLine(text.value, field) : 1,
    message: finding.message,
    ...(finding.remedy === undefined ? {} : { remedy: finding.remedy }),
  };
});
