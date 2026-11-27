import { describe, expect, it } from "vitest";
import { parseYaml, RepeatedYamlKeyError } from "./yaml.ts";

describe("parseYaml", () => {
  it("parses one document", () => {
    expect(parseYaml("name: tools\nlist: [1, 2]\n")).toEqual({ name: "tools", list: [1, 2] });
    expect(parseYaml("")).toBeNull();
  });

  it.each([
    { case: "at the top", text: "name: a\nx: 1\nname: b\n", key: "name", lines: [1, 3] },
    {
      case: "in a nested mapping",
      text: "skills:\n  - path: a\n    exclude: []\n    path: b\n",
      key: "path",
      lines: [2, 4],
    },
    { case: "in a flow mapping", text: "a: {b: 1, b: 2}\n", key: "b", lines: [1, 1] },
  ])("refuses a key repeated $case, naming the key and both lines", ({ text, key, lines }) => {
    const error = (() => {
      try {
        parseYaml(text);
      } catch (cause) {
        return cause;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(RepeatedYamlKeyError);
    expect(error).toMatchObject({
      key,
      lines,
      message: `The key "${key}" appears twice, at lines ${lines[0]} and ${lines[1]}. Keep one of them.`,
    });
  });

  it.each([
    { case: "the first", text: "skills:\n  - path: a\nname: x\nskills: b\n" },
    { case: "the second", text: "skills: a\nskills:\n  - path: b\n" },
    { case: "a flow list", text: "skills: [a]\nskills: [b]\n" },
  ])("asks to merge a repeated key whose value is a list in $case", ({ text }) => {
    expect(() => parseYaml(text)).toThrow(
      /^The key "skills" appears twice, at lines \d+ and \d+\. Merge them into one list\.$/,
    );
  });

  it("counts lines from the first line the text starts at in its file", () => {
    expect(() => parseYaml("name: a\nname: b\n", 2)).toThrow(
      'The key "name" appears twice, at lines 2 and 3. Keep one of them.',
    );
  });

  it("passes over a key that is no scalar, which names no key to repeat", () => {
    expect(parseYaml("? [a, b]\n: 1\nname: x\n")).toEqual({ "[ a, b ]": 1, name: "x" });
  });

  it("keeps the same key in two mappings", () => {
    expect(parseYaml("a: {path: x}\nb: {path: y}\n")).toEqual({
      a: { path: "x" },
      b: { path: "y" },
    });
  });

  it("refuses malformed YAML and several documents", () => {
    expect(() => parseYaml("key: [unclosed\n")).toThrow();
    expect(() => parseYaml("a: 1\n---\nb: 2\n")).toThrow("multiple documents");
  });
});
