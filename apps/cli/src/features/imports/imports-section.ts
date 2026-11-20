import { Yaml } from "../../domain/runtime-neutral.ts";
import { Result } from "effect";
import { deepStrictEqual } from "../../domain/identity/portable.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { decodeImportRecord, type ImportRecord } from "../../domain/imports/import-record.ts";
import {
  applyDeclarationTextEdits,
  type DeclarationTextEdit,
} from "../../domain/sources/declaration-text.ts";

/** Why the imports section cannot be read or edited, with the 1-based line to fix. */
export type ImportsSectionError = {
  readonly line: number;
  readonly message: string;
};

/** Where the section sits in the file, as 1-based inclusive line numbers. */
type ImportsSectionSpan = {
  /** The first line of the section: Tack's comment line when present, else the key line. */
  readonly startLine: number;
  /** The `imports:` key line. */
  readonly keyLine: number;
  /** The last line that belongs to the section. */
  readonly endLine: number;
};

/** The records of a `tack.yaml` and where they sit; `span` is absent when there is no section. */
export type ImportsSection = {
  readonly records: ReadonlyArray<ImportRecord>;
  readonly span?: ImportsSectionSpan;
};

/** The one comment line Tack writes directly above the `imports:` key. */
export const importsSectionComment =
  "# Written by tack import. Edit the skill folders freely; do not edit this section by hand.";

const failure = (line: number, message: string) =>
  Result.fail<ImportsSectionError>({ line, message });

const keyMention = /^\s*["']?imports["']?\s*:/;
const columnZeroKey = /^["']?imports["']?[ \t]*:/;
const exactKey = /^imports:[ \t]*(?:#.*)?$/;
const refusalAdvice =
  "Tack owns this key. Write `imports:` as a block key at column 0, or remove it, then run the command again.";

type Line = {
  readonly content: string;
  readonly terminator: string;
};

const splitLines = (text: string): ReadonlyArray<Line> =>
  text.length === 0
    ? []
    : text.split(/(?<=\n)/).map((piece) => {
        const terminator = /\r?\n$/.exec(piece)?.[0] ?? "";
        return { content: piece.slice(0, piece.length - terminator.length), terminator };
      });

/** The file's own line ending: the first one found, LF when the file has none. */
const lineEndingOf = (text: string): string => (/\r?\n/.exec(text)?.[0] === "\r\n" ? "\r\n" : "\n");

const parseDocument = (
  text: string,
): Result.Result<Record<string, unknown>, ImportsSectionError> => {
  try {
    const parsed: unknown = Yaml.parse(text);
    return typeof parsed === "object" && parsed !== null && Array.isArray(parsed) === false
      ? Result.succeed(Object.fromEntries(Object.entries(parsed)))
      : failure(1, "tack.yaml must be a mapping at its top level.");
  } catch (error) {
    return failure(
      1,
      `tack.yaml does not parse as YAML: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
};

/** Lines that belong to the section after its key: indented content and column-0 `-` items. */
const isSectionContent = (content: string): boolean =>
  content.trim().length > 0 &&
  content.trimStart().startsWith("#") === false &&
  (/^\s/.test(content) || /^-(?:\s|$)/.test(content));

const isBlankOrComment = (content: string) =>
  content.trim().length === 0 || content.trimStart().startsWith("#");

type Located = {
  readonly lines: ReadonlyArray<Line>;
  readonly document: Record<string, unknown>;
  /** 0-based indexes; `end` is exclusive. */
  readonly span?: { readonly start: number; readonly key: number; readonly end: number };
};

const locate = (text: string): Result.Result<Located, ImportsSectionError> => {
  const lines = splitLines(text);
  const keyLines = lines.flatMap((line, index) =>
    columnZeroKey.test(line.content) ? [index] : [],
  );
  const repeated = keyLines[1];
  if (repeated !== undefined)
    return failure(repeated + 1, `The imports key appears more than once. ${refusalAdvice}`);
  return Result.flatMap(parseDocument(text), (document) => {
    const hasKey = Object.hasOwn(document, "imports");
    const keyIndex = keyLines[0];
    if (keyIndex === undefined) {
      if (hasKey === false) return Result.succeed({ lines, document });
      const mention = lines.findIndex((line) => keyMention.test(line.content));
      const anywhere = lines.findIndex((line) => line.content.includes("imports"));
      return failure(
        (mention === -1 ? Math.max(anywhere, 0) : mention) + 1,
        `The imports key is not a plain top-level block key. ${refusalAdvice}`,
      );
    }
    const key = lines[keyIndex];
    if (key === undefined || exactKey.test(key.content) === false)
      return failure(
        keyIndex + 1,
        `The imports key is written in a form Tack cannot own (flow style, anchor, tag or quoting). ${refusalAdvice}`,
      );
    const value = document["imports"];
    if (value !== null && Array.isArray(value) === false)
      return failure(keyIndex + 1, `The imports key must hold a list of records. ${refusalAdvice}`);
    const firstOther = lines.findIndex(
      (line, index) =>
        index > keyIndex &&
        isBlankOrComment(line.content) === false &&
        isSectionContent(line.content) === false,
    );
    const limit = firstOther === -1 ? lines.length : firstOther;
    const lastContent = lines.reduce(
      (last, line, index) =>
        index > keyIndex && index < limit && isSectionContent(line.content) ? index : last,
      keyIndex,
    );
    const end = lastContent + 1;
    const previous = lines[keyIndex - 1];
    const start = previous?.content === importsSectionComment ? keyIndex - 1 : keyIndex;
    return Result.succeed({ lines, document, span: { start, key: keyIndex, end } });
  });
};

const decodeRecords = (
  value: unknown,
  keyLine: number,
): Result.Result<ReadonlyArray<ImportRecord>, ImportsSectionError> => {
  const items: ReadonlyArray<unknown> = Array.isArray(value) ? value : [];
  const decoded = items.map((item, index) =>
    Result.mapError(decodeImportRecord(item), (reason): ImportsSectionError => ({
      line: keyLine,
      message: `Import record ${index + 1} in the block at line ${keyLine} is not valid: ${reason}`,
    })),
  );
  const failed = decoded.find(Result.isFailure);
  if (failed !== undefined) return Result.fail(failed.failure);
  const records = decoded.flatMap((entry) => (Result.isSuccess(entry) ? [entry.success] : []));
  const duplicate = records.find(
    (record, index) => records.findIndex((other) => other.path === record.path) !== index,
  );
  return duplicate === undefined
    ? Result.succeed(records)
    : failure(keyLine, `Two import records name the folder ${duplicate.path}.`);
};

/**
 * Reads the imports section of a `tack.yaml`. A file without the key has no records. Refuses an
 * `imports` key Tack cannot own as text (flow style, anchor, indented, repeated) and any record
 * that does not decode strictly.
 */
export const readImportsSection = (
  text: string,
): Result.Result<ImportsSection, ImportsSectionError> =>
  Result.flatMap(locate(text), (located): Result.Result<ImportsSection, ImportsSectionError> => {
    if (located.span === undefined) return Result.succeed({ records: [] });
    const { span } = located;
    return Result.map(decodeRecords(located.document["imports"], span.key + 1), (records) => ({
      records,
      span: { startLine: span.start + 1, keyLine: span.key + 1, endLine: span.end },
    }));
  });

const flowPattern = /^[A-Za-z0-9_./][A-Za-z0-9_./:@+-]*$/;

/** Writes a string plain when it round-trips as the same string in block and flow context. */
const scalar = (value: string): string => {
  if (flowPattern.test(value) === false) return JSON.stringify(value);
  try {
    const asValue = (parsed: unknown) =>
      typeof parsed === "object" && parsed !== null && "k" in parsed ? parsed.k : undefined;
    const block = asValue(Yaml.parse(`k: ${value}`));
    const flow = asValue(Yaml.parse(`{k: ${value}}`));
    return block === value && flow === value ? value : JSON.stringify(value);
  } catch {
    return JSON.stringify(value);
  }
};

const renderRecord = (record: ImportRecord): ReadonlyArray<string> => [
  `  - path: ${scalar(record.path)}`,
  `    location: ${scalar(record.location)}`,
  `    transport: ${record.transport}`,
  `    ref-kind: ${record["ref-kind"]}`,
  ...(record.ref === undefined ? [] : [`    ref: ${scalar(record.ref)}`]),
  `    revision: ${scalar(record.revision)}`,
  `    upstream-path: ${scalar(record["upstream-path"])}`,
  `    upstream-tree: ${scalar(record["upstream-tree"])}`,
  `    imported-at: ${scalar(record["imported-at"])}`,
  `    digest: ${scalar(record.digest)}`,
  ...(record.files.length === 0
    ? ["    files: []"]
    : [
        "    files:",
        ...record.files.map(
          (file) =>
            `      - { path: ${scalar(file.path)}, sha256: ${scalar(file.sha256)}, executable: ${file.executable} }`,
        ),
      ]),
];

const renderSection = (records: ReadonlyArray<ImportRecord>): ReadonlyArray<string> => [
  importsSectionComment,
  "imports:",
  ...records.flatMap(renderRecord),
];

const withoutImports = (document: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(document).filter(([key]) => key !== "imports"));

const dropOptionalUndefined = (record: ImportRecord): unknown => JSON.parse(JSON.stringify(record));

/**
 * Replaces the imports section of a `tack.yaml` with `records`, as text. Every byte outside the
 * section is kept; the section is rendered sorted by path, in block style, with the file's own line
 * ending, and appended after one blank line when absent. An empty list removes the section. The
 * result is parsed again and must keep every other top-level key and hold exactly the records;
 * otherwise nothing is returned. The file is never re-serialized.
 */
export const editImportsSection = (
  originalText: string,
  records: ReadonlyArray<ImportRecord>,
): Result.Result<string, ImportsSectionError> =>
  Result.flatMap(locate(originalText), (located) => {
    const sorted = [...records].sort((left, right) => compareCodeUnits(left.path, right.path));
    const checked = decodeRecords(sorted.map(dropOptionalUndefined), located.span?.key ?? 0);
    if (Result.isFailure(checked)) return Result.fail(checked.failure);
    const eol = lineEndingOf(originalText);
    const { lines, span } = located;
    const lengthOf = (parts: ReadonlyArray<Line>) =>
      parts.reduce((total, line) => total + line.content.length + line.terminator.length, 0);
    const rendered = sorted.length === 0 ? [] : renderSection(sorted);
    const edits = ((): ReadonlyArray<DeclarationTextEdit> => {
      if (span === undefined) {
        if (rendered.length === 0) return [];
        const endsWithBlank =
          originalText.length === 0 ||
          lines.length === 0 ||
          (lines.at(-1)?.content.trim().length === 0 && lines.at(-1)?.terminator !== "");
        const separator =
          originalText.length === 0
            ? ""
            : lines.at(-1)?.terminator === ""
              ? `${eol}${eol}`
              : endsWithBlank
                ? ""
                : eol;
        const end = originalText.length;
        return [{ start: end, end, text: `${separator}${rendered.join(eol)}${eol}` }];
      }
      const last = lines[span.end - 1];
      const finalTerminator = last?.terminator ?? "";
      return [
        {
          start: lengthOf(lines.slice(0, span.start)),
          end: lengthOf(lines.slice(0, span.end)),
          text: rendered.length === 0 ? "" : `${rendered.join(eol)}${finalTerminator}`,
        },
      ];
    })();
    const next = applyDeclarationTextEdits(originalText, edits);
    const reparsed = parseDocument(next);
    if (Result.isFailure(reparsed)) return Result.fail(reparsed.failure);
    const importsBack = reparsed.success["imports"];
    const importsMatch =
      sorted.length === 0
        ? importsBack === undefined
        : deepStrictEqual(importsBack, sorted.map(dropOptionalUndefined));
    if (
      importsMatch === false ||
      deepStrictEqual(withoutImports(reparsed.success), withoutImports(located.document)) === false
    )
      return failure(
        span?.key === undefined ? 1 : span.key + 1,
        "Tack could not rewrite the imports section without changing the rest of tack.yaml, so it wrote nothing.",
      );
    return Result.succeed(next);
  });
