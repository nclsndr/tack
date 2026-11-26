import { expect, it } from "vitest";
import { fieldLine } from "./field-line.ts";

const yaml = [
  "version: 1",
  "name: tools",
  "skills:",
  "  - path: skills",
  "    exclude:",
  '      - "vendor/**"',
  "  - path: skills/vendor",
  "docs: [{name: kb, path: kb}]",
  "skils: []",
  "",
].join("\n");

const json = JSON.stringify(
  {
    version: 1,
    name: "tools",
    maintainers: ["ada", ""],
    skills: [{ path: "skills", exclude: ["vendor/**"] }, { path: "skills/vendor" }],
    skils: [],
  },
  null,
  2,
);

it.each([
  { text: yaml, field: "skills[1]", line: 7 },
  { text: yaml, field: "skills[0].exclude[0]", line: 6 },
  { text: yaml, field: "docs[0]", line: 8 },
  { text: yaml, field: "skils", line: 9 },
  // An entry past the end, or a key below one that is missing, anchors at the deepest key found.
  { text: yaml, field: "skills[2]", line: 3 },
  { text: yaml, field: "name.first", line: 2 },
  { text: json, field: "maintainers[1]", line: 6 },
  { text: json, field: "skills[1]", line: 15 },
  { text: json, field: "skils", line: 19 },
  // A field the text does not hold, no field, and text that does not parse anchor at line 1.
  { text: json, field: "scripts", line: 1 },
  { text: json, field: undefined, line: 1 },
  { text: "{ version: [", field: "version", line: 1 },
])("anchors $field at line $line", ({ text, field, line }) => {
  expect(fieldLine(text, field)).toBe(line);
});

it("anchors a repeated key at its last occurrence, the one a parse keeps", () => {
  expect(fieldLine("name: a\nname: b\n", "name")).toBe(2);
});
