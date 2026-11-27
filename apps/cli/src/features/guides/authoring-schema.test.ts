import { expect, it } from "vitest";
import { Effect, Exit, Schema } from "effect";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Yaml } from "../../domain/runtime-neutral.ts";
import { ProfilePublicationSchema } from "../../domain/profiles/profile-schema.ts";
import { decodeSourceDeclaration } from "../../domain/sources/source-schema.ts";
import { BundleSupportSchema } from "../profiles/bundle-support.ts";
import { AuthoringDeclarationSchema, authoringJsonSchema } from "./authoring-schema.ts";
import { docsEntrySchema } from "../sources/docs-discovery.ts";
import { decodeEntry } from "../sources/resource-declarations.ts";

const repository = join(import.meta.dirname, "../../../../..");

/** Whether `schema` decodes `value` and refuses any key it does not name, as the runtime does. */
const decodes = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema, { onExcessProperty: "error" })(value));

/** Whether a resource key holds a list whose every entry decodes. */
const entriesDecode = (value: unknown, decode: (entry: unknown) => boolean) =>
  value === undefined || (Array.isArray(value) && value.every((entry) => decode(entry)));

const decodesAs = (kind: "skill" | "script") => (entry: unknown) =>
  "error" in Effect.runSync(decodeEntry(kind, entry)) === false;

/**
 * Whether the runtime takes a declaration whole: its top level decodes, and every entry of each of
 * its resource keys decodes where catalog discovery, profiles and bundles decode them.
 */
const runtimeTakes = (parsed: unknown) => {
  const decoded = Effect.runSync(
    decodeSourceDeclaration(parsed).pipe(
      Effect.map((declaration) => ({ declaration })),
      Effect.catch(() => Effect.succeed(undefined)),
    ),
  );
  if (decoded === undefined) return false;
  const declaration = decoded.declaration;
  return (
    ["skills", "commands", "context"].every((key) =>
      entriesDecode(Reflect.get(declaration, key), decodesAs("skill")),
    ) &&
    entriesDecode(declaration.scripts, decodesAs("script")) &&
    entriesDecode(declaration.docs, (entry) => decodes(docsEntrySchema, entry)) &&
    entriesDecode(declaration.profiles, (entry) => decodes(ProfilePublicationSchema, entry)) &&
    (declaration["bundle-support"] === undefined ||
      decodes(BundleSupportSchema, declaration["bundle-support"]))
  );
};

/** A declaration without the `imports` key, which the authoring schema leaves to `tack import`. */
const withoutImports = (parsed: unknown) => {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "imports"));
};

/** Every tack.yaml the repository tracks, and every declaration its guidance shows. */
const fixtures = (() => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: repository, encoding: "utf8" })
    .split("\n")
    .filter((file) => file !== "");
  const files = tracked
    .filter((file) => /(^|\/)tack\.yaml$/.test(file))
    .map((file) => ({ name: file, text: readFileSync(join(repository, file), "utf8") }));
  const examples = tracked
    .filter((file) => /\.mdx?$/.test(file))
    .flatMap((file) =>
      [
        ...readFileSync(join(repository, file), "utf8").matchAll(
          /```(?:ya?ml|json)\n([\s\S]*?)```/g,
        ),
      ]
        .map((match) => match[1] ?? "")
        .filter((block) => /^(version: [12]\n|\{\s*"version": [12],\s*"name":)/.test(block))
        .map((text, index) => ({ name: `${file} example ${index + 1}`, text })),
    );
  return [...files, ...examples].map(({ name, text }) => ({
    name,
    parsed: Yaml.parse(text),
  }));
})();

/** Declarations at the edges of each form, which both schemas must judge alike. */
const matrix: ReadonlyArray<readonly [string, unknown]> = [
  ["a declaration", { version: 1, name: "tools", skills: [{ path: "skills" }] }],
  ["an unknown key", { version: 1, name: "tools", skils: [] }],
  ["a bad name", { version: 1, name: "Tools" }],
  ["no name", { version: 1 }],
  ["a bad depends-on", { version: 1, name: "tools", "depends-on": ["Base"] }],
  [
    "an entry key it does not name",
    { version: 1, name: "tools", skills: [{ path: "s", exclud: [] }] },
  ],
  ["an entry without a path", { version: 1, name: "tools", commands: [{}] }],
  [
    "patterns that are not a list",
    { version: 1, name: "tools", context: [{ path: "n", include: "*" }] },
  ],
  ["a resource key that is not a list", { version: 1, name: "tools", skills: { path: "skills" } }],
  [
    "a script",
    { version: 1, name: "tools", scripts: [{ name: "run", path: "run.ts", description: "Run" }] },
  ],
  [
    "a script without a description",
    { version: 1, name: "tools", scripts: [{ name: "run", path: "run.ts" }] },
  ],
  [
    "a script with a blank description",
    { version: 1, name: "tools", scripts: [{ name: "run", path: "run.ts", description: " " }] },
  ],
  [
    "a docs entry",
    { version: 1, name: "tools", docs: [{ name: "kb", path: "kb", reader: "r.yaml" }] },
  ],
  [
    "a docs entry with a bad name",
    { version: 1, name: "tools", docs: [{ name: "KB", path: "kb" }] },
  ],
  ["profiles under version 1", { version: 1, name: "tools", profiles: [] }],
  [
    "profiles under version 2",
    { version: 2, name: "tools", profiles: [{ name: "ci", path: "ci.yaml" }] },
  ],
  [
    "a profile with an extra key",
    { version: 2, name: "tools", profiles: [{ name: "ci", path: "ci.yaml", x: 1 }] },
  ],
  [
    "bundle support",
    {
      version: 2,
      name: "tools",
      "bundle-support": [
        {
          kind: "script",
          name: "run",
          complete: true,
          files: ["run.ts"],
          prerequisites: [],
          package: "none",
        },
      ],
    },
  ],
  [
    "incomplete bundle support",
    {
      version: 2,
      name: "tools",
      "bundle-support": [
        { kind: "script", name: "run", complete: false, files: [], prerequisites: [] },
      ],
    },
  ],
  ["version 3", { version: 3, name: "tools" }],
  ["a skills entry at .", { version: 1, name: "skills", skills: [{ path: "." }] }],
  [
    "a docs entry at . with its reader",
    { version: 1, name: "notes", docs: [{ name: "notes", path: ".", reader: {} }] },
  ],
  [
    "a skills entry at . beside another skills entry",
    { version: 1, name: "skills", skills: [{ path: "." }, { path: "vendor" }] },
  ],
  [
    "a skills entry at . beside commands",
    { version: 1, name: "skills", skills: [{ path: "." }], commands: [] },
  ],
  [
    "a docs entry at . beside scripts, under version 2",
    {
      version: 2,
      name: "notes",
      docs: [{ name: "notes", path: "." }],
      scripts: [{ name: "run", path: "run.ts", description: "Run" }],
    },
  ],
  [
    "a context entry at . beside docs",
    { version: 1, name: "n", context: [{ path: "." }], docs: [] },
  ],
  ["kind: skills", { version: 1, name: "skills", kind: "skills" }],
  ["a list", [{ version: 1, name: "tools" }]],
];

it("reads the repository's tack.yaml files and guidance examples", () => {
  expect(fixtures.filter(({ name }) => name.endsWith("tack.yaml")).length).toBeGreaterThanOrEqual(
    3,
  );
  expect(fixtures.length).toBeGreaterThan(10);
});

it.each([...fixtures.map(({ name, parsed }) => [name, parsed] as const), ...matrix])(
  "judges %s as the runtime decoders do",
  (_name, parsed) => {
    expect(decodes(AuthoringDeclarationSchema, withoutImports(parsed))).toBe(runtimeTakes(parsed));
  },
);

it("refuses imports, which only tack import writes, in every form that holds it", () => {
  for (const declaration of [
    { version: 1, name: "tools", imports: [] },
    { version: 1, name: "skills", skills: [{ path: "." }], imports: [] },
  ]) {
    expect(runtimeTakes(declaration)).toBe(true);
    expect(decodes(AuthoringDeclarationSchema, declaration)).toBe(false);
  }
});

/** Every subschema of a JSON Schema document, with the property name it describes, if any. */
const subschemas = (node: unknown, key?: string): ReadonlyArray<{ key?: string; node: object }> => {
  if (typeof node !== "object" || node === null) return [];
  const children = Object.entries(node).flatMap(([childKey, child]: [string, unknown]) =>
    Array.isArray(child)
      ? child.flatMap((item: unknown) => subschemas(item))
      : (childKey === "properties" || childKey === "$defs") &&
          typeof child === "object" &&
          child !== null
        ? Object.entries(child).flatMap(([name, value]: [string, unknown]) =>
            subschemas(value, name),
          )
        : subschemas(child),
  );
  return [{ ...(key === undefined ? {} : { key }), node }, ...children];
};

it("prints a JSON Schema that keeps the name pattern, refuses extra keys and leaves no key open", () => {
  const schema = authoringJsonSchema();
  const nodes = subschemas(schema);
  const objects = nodes.filter(({ node }) => Reflect.get(node, "type") === "object");
  expect(objects.length).toBeGreaterThan(5);
  for (const { node } of objects) expect(Reflect.get(node, "additionalProperties")).toBe(false);
  // Only the reader settings, which the docs reader decodes, take any value.
  expect(nodes.filter(({ node }) => Object.keys(node).length === 0).map(({ key }) => key)).toEqual([
    "reader",
  ]);
  expect(JSON.stringify(schema)).toContain('"pattern":"^[a-z0-9]+(?:-[a-z0-9]+)*$"');
  expect(JSON.stringify(schema)).toContain('"pattern":"\\\\S"');
});
