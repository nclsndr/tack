import { describe, expect, it } from "vitest";
import { Glob, Yaml } from "./runtime-neutral.ts";

describe("runtime-neutral YAML", () => {
  it("parses a mapping and refuses a repeated key, naming it and both of its lines", () => {
    expect(Yaml.parse("name: first\nlist: [1, 2]\n")).toEqual({ name: "first", list: [1, 2] });
    expect(() => Yaml.parse("name: first\nname: last\n")).toThrow(
      'The key "name" appears twice, at lines 1 and 2. Keep one of them.',
    );
  });

  it("asks to merge a repeated key whose value is a list", () => {
    expect(() => Yaml.parse("skills:\n  - path: a\nskills:\n  - path: b\n")).toThrow(
      'The key "skills" appears twice, at lines 1 and 3. Merge them into one list.',
    );
  });

  it("passes over a key that is no scalar, which names no key to repeat", () => {
    expect(Yaml.parse("? [a, b]\n: 1\nname: x\n")).toEqual({ "[ a, b ]": 1, name: "x" });
  });

  it("rejects malformed YAML", () => {
    expect(() => Yaml.parse("key: [unclosed\n")).toThrow();
  });

  it("writes block YAML with two-space indentation that parses back to the same value", () => {
    const value = { version: 1, skills: [{ path: "skills", include: ["*"] }], empty: [] };
    const text = Yaml.stringify(value);

    expect(text).toBe(
      'version: 1\nskills:\n  - path: skills\n    include:\n      - "*"\nempty: []\n',
    );
    expect(Yaml.parse(text)).toEqual(value);
  });
});

describe("runtime-neutral glob", () => {
  it.each([
    ["*.md", "guide.md", true],
    ["*.md", "nested/guide.md", false],
    ["**/*.md", "nested/guide.md", true],
    ["**/*.md", ".hidden/guide.md", true],
    [".*", ".env", true],
    ["drafts/", "drafts/", true],
    ["drafts/**", "drafts/one/two.md", true],
    ["{a,b}.ts", "b.ts", true],
    ["{a,b}.ts", "c.ts", false],
  ])("matches %s against %s as %s", (pattern, path, expected) => {
    expect(new Glob(pattern).match(path)).toBe(expected);
  });
});
