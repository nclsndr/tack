/**
 * The text codecs Tack used to take from Bun's globals, backed by shipped packages so the CLI runs
 * the same under Node and under Bun.
 */
import picomatch from "picomatch";
import {
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  stringify,
  visit,
  type Range,
  type Scalar,
} from "yaml";

/**
 * A mapping of a YAML document names one key twice; a mapping takes each key once. The docs
 * reader refuses the same documents with the same sentence: `yaml-parsers-agree.unit.test.ts`
 * holds the two parsers to one verdict.
 */
export class RepeatedYamlKeyError extends Error {
  override name = "RepeatedYamlKeyError";
  /** The repeated key, as the document spells its value. */
  readonly key: string;
  /** The 1-based lines of its first and second occurrence in the file. */
  readonly lines: readonly [number, number];
  /**
   * @param list - Whether either occurrence holds a list, which the two merge into rather than
   *   one replacing the other.
   */
  constructor(key: string, lines: readonly [number, number], list: boolean) {
    super(
      `The key "${key}" appears twice, at lines ${lines[0]} and ${lines[1]}. ${list ? "Merge them into one list." : "Keep one of them."}`,
    );
    this.key = key;
    this.lines = lines;
  }
}

/** A scalar key with the range the parser gives it, which locates it in the text. */
type LocatedKey = Scalar & { readonly range: Range };

/** Whether a mapping key is a scalar the parser located; a key that is no scalar names no key. */
const isLocatedKey = (key: unknown): key is LocatedKey =>
  isScalar(key) && key.range !== null && key.range !== undefined;

/**
 * Parses one document: malformed YAML or several documents throw the parser's error, and a mapping
 * that names a key twice throws {@link RepeatedYamlKeyError} for the first one, its lines counted
 * from `firstLine`.
 */
const parseYaml = (text: string, firstLine = 1): unknown => {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: false });
  const [error] = document.errors;
  if (error !== undefined) throw error;
  const lineOf = (key: LocatedKey) => lineCounter.linePos(key.range[0]).line + firstLine - 1;
  let repeated: RepeatedYamlKeyError | undefined;
  visit(document, {
    Map(_, map) {
      const seen = new Map<unknown, { readonly key: LocatedKey; readonly value: unknown }>();
      for (const { key, value } of map.items) {
        if (isLocatedKey(key) === false) continue;
        const first = seen.get(key.value);
        if (first !== undefined) {
          repeated = new RepeatedYamlKeyError(
            String(key.value),
            [lineOf(first.key), lineOf(key)],
            isSeq(first.value) || isSeq(value),
          );
          return visit.BREAK;
        }
        seen.set(key.value, { key, value });
      }
      return undefined;
    },
  });
  if (repeated !== undefined) throw repeated;
  return document.toJS();
};

/** Reads and writes YAML documents. */
export const Yaml = {
  /**
   * Parses one document as the docs reader does: a key repeated in one mapping is refused with
   * both of its lines, counted from `firstLine`, the file line the text starts at.
   */
  parse: (text: string, firstLine?: number): unknown => parseYaml(text, firstLine),
  /** Why a text did not parse: a repeated key's own sentence, or the parser's error. */
  failure: (cause: unknown): string =>
    cause instanceof RepeatedYamlKeyError ? cause.message : String(cause),
  /** Writes block YAML with two-space indentation and a final newline. */
  stringify: (value: unknown): string => stringify(value, { indent: 2 }),
};

/** One glob pattern; dotfiles match like any other name. */
export class Glob {
  readonly #matches: (path: string) => boolean;
  constructor(pattern: string) {
    this.#matches = picomatch(pattern, { dot: true });
  }
  /** Whether a slash-separated relative path matches the pattern. */
  match(path: string): boolean {
    return this.#matches(path);
  }
}
