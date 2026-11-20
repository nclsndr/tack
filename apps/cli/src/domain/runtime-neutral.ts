/**
 * The text codecs Tack used to take from Bun's globals, backed by shipped packages so the CLI runs
 * the same under Node and under Bun.
 */
import picomatch from "picomatch";
import { parse, stringify } from "yaml";

/** Reads and writes YAML documents. */
export const Yaml = {
  /** Parses one document; a repeated key keeps its last value, as Tack always has. */
  parse: (text: string): unknown => parse(text, { uniqueKeys: false }),
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
