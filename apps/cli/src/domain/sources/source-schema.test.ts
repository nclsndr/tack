import { expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { decodeSourceDeclaration, ListDeclarationSchema } from "./source-schema.ts";

it.each([
  ["profiles", { profiles: [] }],
  ["bundle-support", { "bundle-support": {} }],
])("refuses the %s key in a version 1 declaration", (_key, change) => {
  expect(Schema.decodeUnknownSync(ListDeclarationSchema)({ version: 2, ...change })).toEqual({
    version: 2,
    ...change,
  });
  expect(() => Schema.decodeUnknownSync(ListDeclarationSchema)({ version: 1, ...change })).toThrow(
    "The profiles and bundle-support keys require source declaration version 2.",
  );
});

const decode = (value: unknown) =>
  Effect.runSync(
    decodeSourceDeclaration(value).pipe(
      Effect.map((declaration) => ({ declaration })),
      Effect.catch((error) => Effect.succeed({ error: error.message })),
    ),
  );

it.each([
  { version: 1, kind: "skills" },
  { version: 1, kind: "skills", name: "personal", maintainers: ["me"], "depends-on": ["base"] },
  { version: 1, kind: "skills", imports: [] },
  { version: 1, kind: "commands", name: "prompts", "depends-on": [] },
  { version: 1, kind: "docs", name: "notes", reader: { navigation: { preset: "folders" } } },
])("decodes the collection %j", (value) => {
  expect(decode(value)).toEqual({ declaration: value });
});

it.each([
  { value: { version: 1, kind: "skills", skills: [] }, says: "skills" },
  { value: { version: 1, kind: "commands", imports: [] }, says: "imports" },
  { value: { version: 1, kind: "docs" }, says: "name" },
  { value: { version: 1, kind: "docs", name: "notes", "depends-on": [] }, says: "depends-on" },
  { value: { version: 2, kind: "skills" }, says: "version" },
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
