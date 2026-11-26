import { isScalar, LineCounter, parseDocument, visit, type Node } from "yaml";

/** A mapping of a YAML document names one key twice; a mapping takes each key once. */
export class RepeatedYamlKeyError extends Error {
  override name = "RepeatedYamlKeyError";
  /** The repeated key, as the document spells its value. */
  readonly key: string;
  /** The 1-based lines of its first and second occurrence in the file. */
  readonly lines: readonly [number, number];
  constructor(key: string, lines: readonly [number, number]) {
    super(
      `The key "${key}" appears twice, at lines ${lines[0]} and ${lines[1]}. Keep one of them.`,
    );
    this.key = key;
    this.lines = lines;
  }
}

/**
 * Parses one YAML document, as Tack and its docs reader read every `tack.yaml`, reader settings
 * file and `SKILL.md` frontmatter: malformed YAML or several documents throw the parser's error,
 * and a mapping that names a key twice throws {@link RepeatedYamlKeyError} for the first one.
 *
 * @param firstLine - The file line the text starts at, so frontmatter reports its file's lines.
 */
export const parseYaml = (text: string, firstLine = 1): unknown => {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: false });
  const [error] = document.errors;
  if (error !== undefined) throw error;
  const lineOf = (node: Node) => lineCounter.linePos(node.range?.[0] ?? 0).line + firstLine - 1;
  let repeated: RepeatedYamlKeyError | undefined;
  visit(document, {
    Map(_, map) {
      const seen = new Map<unknown, Node>();
      for (const { key } of map.items) {
        if (isScalar(key) === false) continue;
        const first = seen.get(key.value);
        if (first !== undefined) {
          repeated = new RepeatedYamlKeyError(String(key.value), [lineOf(first), lineOf(key)]);
          return visit.BREAK;
        }
        seen.set(key.value, key);
      }
      return undefined;
    },
  });
  if (repeated !== undefined) throw repeated;
  return document.toJS();
};
