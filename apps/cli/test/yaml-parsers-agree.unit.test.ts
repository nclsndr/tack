import { afterAll, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReaderYaml } from "../../../packages/reader/src/config.ts";
import { Yaml } from "../src/domain/runtime-neutral.ts";

/**
 * The CLI parses tack.yaml and SKILL.md frontmatter, and the docs reader parses tack.yaml and its
 * settings files: one document must get one verdict from both.
 */
const documents: ReadonlyArray<readonly [string, string]> = [
  ["a declaration", "version: 1\nname: tools\nskills:\n  - path: skills\n"],
  ["the same key in two mappings", "docs:\n  - name: a\n    path: a\n  - name: b\n    path: b\n"],
  ["a repeated top key", "version: 1\nname: one\nname: two\n"],
  ["a repeated entry key", "docs:\n  - name: a\n    path: a\n    path: b\n"],
  ["a repeated flow key", "reader: {content: [], content: []}\n"],
  ["a repeated list key", "version: 1\nskills:\n  - path: a\nskills:\n  - path: b\n"],
  ["a key that is no scalar", "? [a, b]\n: 1\nname: x\n"],
  ["malformed YAML", "version: [\n"],
  ["two documents", "version: 1\n---\nversion: 1\n"],
];

const directory = await mkdtemp(join(tmpdir(), "tack-yaml-agree-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

/** A parser's verdict: the value, the repeated key's sentence, or that the text is malformed. */
const verdict = (parse: () => unknown) => {
  try {
    return { parsed: parse() };
  } catch (cause) {
    const message = Yaml.failure(cause);
    return message.startsWith("The key ") ? { repeated: message } : { malformed: true };
  }
};

const readerVerdict = async (file: string) => {
  try {
    return { parsed: await readReaderYaml(file) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const repeated = message.slice(`${file}: `.length);
    return message.startsWith(`${file}: The key `) ? { repeated } : { malformed: true };
  }
};

it.each(documents)(
  "parses %s to the same verdict in the CLI and the reader",
  async (name, text) => {
    const file = join(directory, `${name.replaceAll(" ", "-")}.yaml`);
    await writeFile(file, text);
    expect(await readerVerdict(file)).toEqual(verdict(() => Yaml.parse(text)));
  },
);

it("refuses every repeated key the matrix holds in both parsers", () => {
  expect(documents.filter(([, text]) => "repeated" in verdict(() => Yaml.parse(text))).length).toBe(
    4,
  );
});
