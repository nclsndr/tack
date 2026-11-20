import { describe, expect, it } from "vitest";
import { Glob, Yaml } from "./runtime-neutral.ts";

describe("runtime-neutral YAML", () => {
  it("parses a mapping and keeps the last of duplicate keys", () => {
    expect(Yaml.parse("name: first\nname: last\nlist: [1, 2]\n")).toEqual({
      name: "last",
      list: [1, 2],
    });
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
