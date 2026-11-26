import { expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  declarationIssues,
  decodeSourceDeclaration,
  ListDeclarationSchema,
  missingSourceNameMessage,
} from "./source-schema.ts";

it.each([
  ["profiles", { profiles: [] }],
  ["bundle-support", { "bundle-support": {} }],
])("refuses the %s key in a version 1 declaration", (_key, change) => {
  expect(
    Schema.decodeUnknownSync(ListDeclarationSchema)({ version: 2, name: "tools", ...change }),
  ).toEqual({
    version: 2,
    name: "tools",
    ...change,
  });
  expect(() =>
    Schema.decodeUnknownSync(ListDeclarationSchema)({ version: 1, name: "tools", ...change }),
  ).toThrow("The profiles and bundle-support keys require source declaration version 2.");
});

const decode = (value: unknown) =>
  Effect.runSync(
    decodeSourceDeclaration(value).pipe(
      Effect.map((declaration) => ({ declaration })),
      Effect.catch((error) => Effect.succeed({ error: error.message })),
    ),
  );

it.each([
  { version: 1, kind: "skills", name: "personal" },
  { version: 1, kind: "skills", name: "personal", maintainers: ["me"], "depends-on": ["base"] },
  { version: 1, kind: "skills", name: "personal", imports: [] },
  { version: 1, kind: "commands", name: "prompts", "depends-on": [] },
  { version: 1, kind: "docs", name: "notes", reader: { navigation: { preset: "folders" } } },
])("decodes the collection %j", (value) => {
  expect(decode(value)).toEqual({ declaration: value });
});

it.each([
  { value: { version: 1, kind: "skills", name: "personal", skills: [] }, says: "skills" },
  { value: { version: 1, kind: "commands", name: "prompts", imports: [] }, says: "imports" },
  { value: { version: 1, kind: "skills" }, says: "name" },
  { value: { version: 1, kind: "commands" }, says: "name" },
  { value: { version: 1, kind: "docs" }, says: "name" },
  { value: { version: 1, kind: "docs", name: "notes", "depends-on": [] }, says: "depends-on" },
  { value: { version: 2, kind: "skills", name: "personal" }, says: "version" },
  {
    value: { version: 1, kind: "skill" },
    says: "Write kind: skills. A folder with SKILL.md is one skill",
  },
  { value: { version: 1, kind: "scripts" }, says: "kind is skills, commands or docs" },
])("refuses the collection $value with one message", ({ value, says }) => {
  const decoded = decode(value);
  expect("error" in decoded ? decoded.error : undefined).toContain(says);
});

it("keeps the list form without a kind", () => {
  const value = { version: 1, name: "tools", skills: [{ path: "skills" }] };
  expect(decode(value)).toEqual({ declaration: value });
  expect(decode({ ...value, unknown: 1 })).toMatchObject({
    error: expect.stringContaining("unknown"),
  });
});

it("refuses the list form without a name", () => {
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

/** Every issue `parsed` has, as `declarationIssues` reports them for a folder named `brain`. */
const issuesOf = (parsed: unknown) =>
  Effect.runSync(
    decodeSourceDeclaration(parsed).pipe(
      Effect.map(() => []),
      Effect.catch((error) => Effect.succeed(declarationIssues(parsed, error, "brain"))),
    ),
  );

it("reports every issue of a declaration at once, each with its field", () => {
  expect(
    issuesOf({ version: 1, name: "brain", skils: [], maintainers: [""], "depends-on": ["Bad"] }),
  ).toEqual([
    {
      field: "skils",
      message: `Unknown key "skils". A list-form tack.yaml takes: ${Object.keys(ListDeclarationSchema.fields).join(", ")}.`,
    },
    { field: "maintainers[0]", message: "maintainers[0]: A maintainers entry must not be empty." },
    {
      field: "depends-on[0]",
      message: expect.stringMatching(/^depends-on\[0\]: Expected a string matching/),
    },
  ]);
});

it.each([
  {
    parsed: { version: 1, kind: "skills", name: "brain", docs: [] },
    says: 'Unknown key "docs". A skills collection takes: version, name, maintainers, kind, depends-on, imports.',
  },
  {
    parsed: { version: 1, kind: "docs", name: "brain", imports: [] },
    says: 'Unknown key "imports". A docs collection takes: version, name, maintainers, kind, reader.',
  },
])("names the keys a collection takes on an unknown key", ({ parsed, says }) => {
  expect(issuesOf(parsed)).toEqual([{ field: Object.keys(parsed).at(-1), message: says }]);
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

it("reports a rule over the whole declaration without a field", () => {
  expect(issuesOf({ version: 1, name: "brain", profiles: [] })).toEqual([
    { message: "The profiles and bundle-support keys require source declaration version 2." },
  ]);
});
