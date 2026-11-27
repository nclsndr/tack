import { expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  declarationIssues,
  decodeSourceDeclaration,
  DeclarationSchema,
  missingSourceNameMessage,
} from "./source-schema.ts";

it.each([
  ["profiles", { profiles: [] }],
  ["bundle-support", { "bundle-support": {} }],
])("takes the %s key in a version 1 declaration", (_key, change) => {
  expect(
    Schema.decodeUnknownSync(DeclarationSchema)({ version: 1, name: "tools", ...change }),
  ).toEqual({ version: 1, name: "tools", ...change });
});

it("refuses any declaration version other than 1", () => {
  expect(() =>
    Schema.decodeUnknownSync(DeclarationSchema)({ version: 2, name: "tools", profiles: [] }),
  ).toThrow(`Expected 1
  at ["version"]`);
});

const decode = (value: unknown) =>
  Effect.runSync(
    decodeSourceDeclaration(value).pipe(
      Effect.map((declaration) => ({ declaration })),
      Effect.catch((error) => Effect.succeed({ error: error.message })),
    ),
  );

it.each([
  { version: 1, name: "personal", skills: [{ path: "." }], "depends-on": ["base"] },
  { version: 1, name: "prompts", commands: [{ path: "." }], maintainers: ["me"] },
  {
    version: 1,
    name: "notes",
    docs: [
      { name: "notes", path: "." },
      { name: "kb", path: "." },
    ],
  },
  { version: 1, name: "personal", skills: [{ path: "." }], profiles: [] },
  { version: 1, name: "personal", skills: [{ path: "." }, { path: "vendor" }] },
])("decodes a declaration whose . entries declare one kind: %j", (value) => {
  expect(decode(value)).toEqual({ declaration: value });
});

/** Every issue `parsed` has, as `declarationIssues` reports them for a folder named `brain`. */
const issuesOf = (parsed: unknown, format: "yaml" | "json" = "yaml") =>
  Effect.runSync(
    decodeSourceDeclaration(parsed).pipe(
      Effect.map(() => []),
      Effect.catch((error) => Effect.succeed(declarationIssues(parsed, error, "brain", format))),
    ),
  );

it("refuses another resource key beside a . entry, at each other key", () => {
  expect(
    issuesOf({
      version: 1,
      name: "brain",
      skills: [{ path: "vendor" }, { path: "." }],
      commands: [{ path: "prompts" }],
      docs: [],
    }),
  ).toEqual(
    ["commands", "docs"].map((other) => ({
      field: other,
      message: `${other}: The skills entry "." declares the source folder itself, so this tack.yaml declares skills only. List each skill folder instead of ".", or name the folder that holds the skills, or move ${other} to a tack.yaml of its own folder.`,
    })),
  );
  expect(issuesOf({ version: 1, name: "brain", context: [{ path: "." }], scripts: [] })).toEqual([
    {
      field: "scripts",
      message: `scripts: The context entry "." declares the source folder itself, so this tack.yaml declares context only. List each context file instead of ".", or name the folder that holds the context, or move scripts to a tack.yaml of its own folder.`,
    },
  ]);
});

it.each([
  {
    parsed: { version: 1, name: "personal", kind: "skills", "depends-on": ["base"] },
    yaml: ["version: 1", "name: personal", "depends-on:", "  - base", "skills:", "  - path: ."],
    json: '{"version":1,"name":"personal","depends-on":["base"],"skills":[{"path":"."}]}',
  },
  {
    parsed: { version: 1, name: "prompts", kind: "commands" },
    yaml: ["version: 1", "name: prompts", "commands:", "  - path: ."],
    json: '{"version":1,"name":"prompts","commands":[{"path":"."}]}',
  },
  {
    parsed: {
      version: 1,
      kind: "docs",
      name: "notes",
      reader: { navigation: { preset: "folders" } },
    },
    yaml: [
      "version: 1",
      "name: notes",
      "docs:",
      "  - name: notes",
      "    path: .",
      "    reader:",
      "      navigation:",
      "        preset: folders",
    ],
    json: '{"version":1,"name":"notes","docs":[{"name":"notes","path":".","reader":{"navigation":{"preset":"folders"}}}]}',
  },
])("refuses kind with the exact declaration to write instead: $parsed.kind", (row) => {
  const says =
    'A tack.yaml takes no kind key: a "." entry declares the folder that holds it. Write instead:';
  expect(issuesOf(row.parsed)).toEqual([
    { field: "kind", message: [says, ...row.yaml.map((line) => `  ${line}`)].join("\n") },
  ]);
  expect(issuesOf(row.parsed, "json")).toEqual([
    { field: "kind", message: `${says}\n  ${row.json}` },
  ]);
});

it("refuses a kind that never declared resources with the . entry to use", () => {
  expect(issuesOf({ version: 1, name: "brain", kind: "skill", skills: [] })).toEqual([
    {
      field: "kind",
      message:
        'A tack.yaml takes no kind key. Declare the folder that holds it as a "." entry, such as skills: [{ path: "." }]; tack guide tack-yaml lists every key.',
    },
  ]);
});

it("refuses a key the declaration does not name", () => {
  const value = { version: 1, name: "tools", skills: [{ path: "skills" }] };
  expect(decode(value)).toEqual({ declaration: value });
  expect(decode({ ...value, unknown: 1 })).toMatchObject({
    error: expect.stringContaining("unknown"),
  });
});

it("refuses a declaration without a name", () => {
  expect(decode({ version: 1, skills: [{ path: "skills" }] })).toMatchObject({
    error: expect.stringContaining("name"),
  });
});

it.each([
  { folder: "team-skills", says: 'Add "name: team-skills" to it' },
  { folder: "Team Skills", says: 'Add "name: team-skills" to it' },
  { folder: "___", says: "Add a name: line with lowercase letters, digits and hyphens" },
  { folder: "0EDF1F6F-C71B-40C6-BF98-FDE02235A02F", says: "Add a name: line" },
])("suggests a name for the folder $folder", ({ folder, says }) => {
  expect(missingSourceNameMessage(folder)).toContain(says);
});

it("reports every issue of a declaration at once, each with its field", () => {
  expect(
    issuesOf({ version: 1, name: "brain", skils: [], maintainers: [""], "depends-on": ["Bad"] }),
  ).toEqual([
    {
      field: "skils",
      message: `Unknown key "skils". A tack.yaml takes: ${Object.keys(DeclarationSchema.fields).join(", ")}.`,
    },
    { field: "maintainers[0]", message: "maintainers[0]: A maintainers entry must not be empty." },
    {
      field: "depends-on[0]",
      message: expect.stringMatching(/^depends-on\[0\]: Expected a string matching/),
    },
  ]);
});

it("suggests a name when the name is missing, beside the other issues", () => {
  expect(issuesOf({ version: 1, skils: [] })).toEqual([
    expect.objectContaining({ field: "skils" }),
    { field: "name", message: missingSourceNameMessage("brain") },
  ]);
});

it("names the field of a value of the wrong type", () => {
  expect(issuesOf({ version: 1, name: 5 })).toEqual([
    { field: "name", message: "name: Expected string" },
  ]);
});

it("names a missing key other than the name", () => {
  expect(issuesOf({ name: "brain" })).toEqual([
    { field: "version", message: 'Missing key "version".' },
  ]);
});

it("reports an issue with the whole declaration without a field", () => {
  expect(issuesOf("brain")).toEqual([{ message: expect.stringContaining("Expected object") }]);
});

it("decodes a source description and its rules", () => {
  const rules = { description: "Before editing any skill of this source.", body: "Branch first." };
  const value = { version: 1, name: "handbook", description: "The team handbook.", rules };
  expect(decode(value)).toEqual({ declaration: value });
});

it.each([
  [{ description: "" }, "description", "description: A source description must not be empty."],
  [{ description: "  " }, "description", "description: A source description must not be empty."],
  [
    { rules: { description: "Always.", body: " " } },
    "rules.body",
    "rules.body: The rules body must not be empty.",
  ],
  [
    { rules: { description: "", body: "Branch first." } },
    "rules.description",
    "rules.description: The rules description must not be empty.",
  ],
  [{ rules: { body: "Branch first." } }, "rules.description", 'Missing key "rules.description".'],
  [
    { rules: { description: "Always.", body: "Branch first.", when: "x" } },
    "rules.when",
    'Unknown key "rules.when". rules takes: description, body.',
  ],
])("refuses an unusable description or rules: %j", (change, field, message) => {
  expect(issuesOf({ version: 1, name: "brain", ...change })).toEqual([{ field, message }]);
});
