/**
 * The text codecs Tack used to take from Bun's globals, backed by shipped packages so the CLI runs
 * the same under Node and under Bun.
 */
import picomatch from "picomatch";
import { parseYaml, RepeatedYamlKeyError } from "@tackup/reader/yaml";
import { stringify } from "yaml";

/** Reads and writes YAML documents. */
export const Yaml = {
  /**
   * Parses one document as the docs reader does: a key repeated in one mapping is refused with
   * both of its lines, counted from `firstLine`.
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
