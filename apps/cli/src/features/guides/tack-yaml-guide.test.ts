import { expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { ProfilePublicationSchema } from "../../domain/profiles/profile-schema.ts";
import { declarationIssues, decodeSourceDeclaration } from "../../domain/sources/source-schema.ts";
import { BundleSupportEntrySchema } from "../profiles/bundle-support.ts";
import { docsEntrySchema } from "../sources/docs-discovery.ts";
import { decodeEntry } from "../sources/resource-declarations.ts";
import { authoringJsonSchema } from "./authoring-schema.ts";
import { tackYamlExample, tackYamlGuide } from "./tack-yaml-guide.ts";

const guide = tackYamlGuide();

/** The rows of the first key table under `heading`, as the guide prints them. */
const tableUnder = (heading: string) => {
  const section = (guide.split(`\n${heading}\n`)[1] ?? "").trimStart();
  const table = section.split("\n\n").find((block) => block.startsWith("| Key |")) ?? "";
  return [...table.matchAll(/^\| `([^`]+)` \| (yes|no) \|/gm)].map(([, key = "", required]) => ({
    key,
    required: required === "yes",
  }));
};

/** The fields a declaration decoder reports issues on, through the decoder `tack check` uses. */
const declarationFieldIssues = (parsed: unknown) =>
  Effect.runSync(
    decodeSourceDeclaration(parsed).pipe(
      Effect.map(() => []),
      Effect.catch((error) => Effect.succeed(declarationIssues(parsed, error, "brain", "yaml"))),
    ),
  );

/** The fields an entry decoder refuses, from its error message, or none when it decodes. */
const entryFieldIssues = (decode: (entry: unknown) => string | undefined) => (entry: unknown) => {
  const message = decode(entry);
  return message === undefined ? [] : [...message.matchAll(/at \["([^"]+)"\]/g)].map((m) => m[1]);
};

const schemaMessage = (schema: Schema.Codec<unknown, unknown>) => (entry: unknown) =>
  Effect.runSync(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error", errors: "all" })(entry).pipe(
      Effect.map(() => undefined),
      Effect.catch((error) => Effect.succeed(error.message)),
    ),
  );

const entryMessage = (kind: "skill" | "script") => (entry: unknown) =>
  Effect.runSync(
    decodeEntry(kind, entry).pipe(
      Effect.map((decoded) => ("error" in decoded ? decoded.error : undefined)),
    ),
  );

/**
 * One table of the guide, with a value its decoder takes for every key it requires, a value for any
 * other key, and the fields the decoder refuses in a value.
 */
type Table = {
  readonly heading: string;
  readonly minimal: Readonly<Record<string, unknown>>;
  readonly sample: (key: string) => unknown;
  readonly refused: (value: unknown) => ReadonlyArray<string | undefined>;
};

const tables: ReadonlyArray<Table> = [
  {
    heading: "## Keys",
    minimal: { version: 1, name: "brain" },
    sample: (key: string) => (key === "version" ? 2 : []),
    refused: (value: unknown) =>
      declarationFieldIssues(value).flatMap((issue) => issue.field ?? []),
  },
  {
    heading: "### Folder entries",
    minimal: { path: "skills" },
    sample: () => [],
    refused: entryFieldIssues(entryMessage("skill")),
  },
  {
    heading: "### Script entries",
    minimal: { name: "report", path: "report.ts", description: "Report" },
    sample: () => "x",
    refused: entryFieldIssues(entryMessage("script")),
  },
  {
    heading: "### Docs entries",
    minimal: { name: "handbook", path: "handbook" },
    sample: () => ({}),
    refused: entryFieldIssues(schemaMessage(docsEntrySchema)),
  },
  {
    heading: "### Profile publications",
    minimal: { name: "ci", path: "ci.yaml" },
    sample: () => "x",
    refused: entryFieldIssues(schemaMessage(ProfilePublicationSchema)),
  },
  {
    heading: "### Bundle support",
    minimal: { kind: "skill", name: "review", complete: true, files: [], prerequisites: [] },
    sample: () => "none",
    refused: entryFieldIssues(schemaMessage(BundleSupportEntrySchema)),
  },
];

it.each(tables)(
  "lists under $heading exactly the keys its decoder takes, and the ones it requires",
  ({ heading, minimal, sample, refused }) => {
    const rows = tableUnder(heading);
    expect(rows.length).toBeGreaterThan(1);
    // The required keys alone decode, and each is refused when it is left out.
    expect(rows.filter((row) => row.required).map((row) => row.key)).toEqual(Object.keys(minimal));
    expect(refused(minimal)).toEqual([]);
    for (const key of Object.keys(minimal)) {
      const { [key]: _left, ...without } = minimal;
      expect(refused(without), `${heading}: ${key} left out`).toContain(key);
    }
    // Every optional key it lists is a key its decoder knows, and a key it does not list is not.
    for (const { key } of rows.filter((row) => row.required === false))
      expect(refused({ ...minimal, [key]: sample(key) }), `${heading}: ${key}`).not.toContain(key);
    expect(refused({ ...minimal, unlisted: [] })).toContain("unlisted");
  },
);

it("prints an example that decodes as a declaration whose every entry decodes", () => {
  const block = /```json\n([\s\S]*?)```/.exec(guide)?.[1] ?? "";
  const parsed: unknown = JSON.parse(block);
  expect(parsed).toEqual(tackYamlExample);
  expect(Effect.runSync(decodeSourceDeclaration(parsed))).toEqual(tackYamlExample);
  for (const [key, kind] of [
    ["skills", "skill"],
    ["commands", "skill"],
    ["context", "skill"],
    ["scripts", "script"],
  ] as const)
    for (const entry of tackYamlExample[key])
      expect(entryMessage(kind)(entry), `${key} entry`).toBeUndefined();
  for (const entry of tackYamlExample.docs)
    expect(schemaMessage(docsEntrySchema)(entry)).toBeUndefined();
});

it("prints the JSON Schema of the authoring schema, which reads back as built", () => {
  const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  expect(blocks).toHaveLength(2);
  expect(JSON.parse(blocks[1] ?? "")).toEqual(authoringJsonSchema());
  // A short value stays on one line, so the schema reads without a line per bracket.
  expect(blocks[1]).toContain('"required": ["version","name"],');
});
