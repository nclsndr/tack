import { Schema } from "effect";
import { SourceDeclarationSchema } from "../sources/source-schema.ts";
import { expect, it } from "vitest";
import { publishProfileText } from "./publication-text.ts";

it("preserves unrelated declaration bytes and comments while publishing a new profile", () => {
  const text =
    "# team source\r\nversion: 1 # current\r\nname: tools\r\n# skills stay authored\r\nskills: [{path: skills}]\r\n";
  expect(publishProfileText(text, [{ name: "ci", path: "profiles/ci.yaml" }])).toEqual({
    text: "# team source\r\nversion: 2 # current\r\nname: tools\r\n# skills stay authored\r\nskills: [{path: skills}]\r\n\r\nprofiles:\r\n  - name: ci\r\n    path: profiles/ci.yaml\r\n",
  });
});
it("replaces only the profiles section and refuses ambiguous text layouts", () => {
  const publication = [{ name: "ci", path: "ci.yaml" }];
  expect(
    publishProfileText("version: 2\nprofiles: []\n# untouched\ncommands: []\n", publication),
  ).toMatchObject({ text: expect.stringContaining("path: ci.yaml\n# untouched\ncommands: []\n") });
  expect(publishProfileText("{version: 1, commands: []}\n", publication)).toHaveProperty("error");
});

it.each([
  "version: 2\nname: tools\nprofiles:\n- name: existing\n  path: existing.yaml\nskills: []\n",
  '"version": 2\nname: tools\n"profiles": [{name: existing, path: existing.yaml}]\ncommands: []\n',
  "version: 2\nprofiles:\n- name: existing\n# preserve this author note\n  path: existing.yaml\n# unrelated resource note\nskills: []\n",
])(
  "round-trips non-canonical YAML without dropping publications or changing unrelated values: %s",
  (input) => {
    const publications = [
      { name: "existing", path: "existing.yaml" },
      { name: "fresh", path: "profiles/fresh.yaml" },
    ];
    const result = publishProfileText(input, publications);
    expect(result.error).toBeUndefined();
    const before = Schema.decodeUnknownSync(SourceDeclarationSchema)(Bun.YAML.parse(input));
    expect(Bun.YAML.parse(result.text ?? "")).toEqual({
      ...before,
      version: 2,
      profiles: publications,
    });
    for (const comment of input.match(/#[^\n]*/g) ?? []) expect(result.text).toContain(comment);
  },
);

const ci = [{ name: "ci", path: "profiles/ci.yaml" }];

it("separates the new profiles section from text that does not end with a newline", () => {
  expect(publishProfileText("version: 1\nname: tools", ci)).toEqual({
    text: "version: 2\nname: tools\n\nprofiles:\n  - name: ci\n    path: profiles/ci.yaml\n",
  });
});

it("rewrites a quoted flow profiles key in place as a block list", () => {
  expect(
    publishProfileText(
      '"version": 2\nname: tools\n"profiles": [{name: ci, path: profiles/ci.yaml}]\ncommands: []\n',
      ci,
    ),
  ).toEqual({
    text: '"version": 2\nname: tools\nprofiles:\n  - { name: ci, path: profiles/ci.yaml }\ncommands: []\n',
  });
});

it("refuses a version that is an alias of another value", () => {
  expect(publishProfileText("skills: &one 1\nversion: *one\n", ci)).toEqual({
    error: "Use an explicit version: 1 or version: 2 value before publishing a profile.",
  });
});

it("refuses an edit that would also change a value aliasing the version", () => {
  expect(publishProfileText("version: &one 1\nskills: *one\n", ci)).toEqual({
    error: "Publishing would change unrelated declaration values. Review tack.yaml before saving.",
  });
});

it("refuses to edit a declaration that is not valid", () => {
  expect(publishProfileText("name: tools\n", ci)).toEqual({
    error:
      "Cannot safely edit this source declaration. Repair its YAML and check the source before saving.",
  });
});
