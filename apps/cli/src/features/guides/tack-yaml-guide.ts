import { Schema } from "effect";
import { ProfilePublicationSchema } from "../../domain/profiles/profile-schema.ts";
import { DeclarationSchema } from "../../domain/sources/source-schema.ts";
import { BundleSupportEntrySchema } from "../profiles/bundle-support.ts";
import { authoringJsonSchema } from "./authoring-schema.ts";
import { docsEntrySchema } from "../sources/docs-discovery.ts";
import { folderEntrySchema, scriptEntrySchema } from "../sources/resource-declarations.ts";

/** A struct schema whose keys a table lists, by the fields it decodes. */
type Fields = { readonly [key: string]: Schema.Top };

/** What each key of `F` takes, in words: one entry per key, so a new key needs its words. */
type Described<F extends Fields> = { readonly [K in keyof F]: string };

/** What the keys of a declaration take. */
const declarationKeys = {
  version: "`1`. A `tack.yaml` that declares `profiles` or `bundle-support` takes `2`.",
  name: "The source label: lowercase letters, digits and single hyphens, at most 64 characters. `depends-on` and `source:` references name the source by it on every machine.",
  maintainers:
    "A list of the people or teams to contact about the source, such as `Ada <ada@example.com>`. It grants no permission.",
  "depends-on": "A list of source names whose resources this source's resources may depend on.",
  skills: "A list of folder entries, each a folder of skills or one skill folder.",
  commands: "A list of folder entries, each a folder of `.md` commands or one `.md` file.",
  context: "A list of folder entries, each a folder or one file of context.",
  scripts: "A list of script entries, each one `.ts` module.",
  docs: "A list of docs entries, each a folder of Markdown.",
  profiles: "A list of profile publications. Needs version 2.",
  "bundle-support":
    "A list of the support a profile bundle carries for one resource. Needs version 2.",
  imports:
    "The records `tack import add` writes, one per imported skill. Never write it: `source add --config` refuses it.",
} satisfies Described<typeof DeclarationSchema.fields>;

/** The entry shapes, each with the declaration keys that take it and what each of its keys takes. */
const entryShapes = [
  {
    title: "Folder entries",
    keys: "`skills`, `commands` and `context`",
    fields: folderEntrySchema.fields,
    described: {
      path: "The folder or file, relative to the source, written with `/` and without `.` or `..` segments; `.` alone for the source folder itself.",
      include:
        "Glob patterns that a resource's path inside the folder must match; any path when absent.",
      exclude:
        'Glob patterns that leave a resource, or a whole folder written with a trailing `/`, out, such as `"**/_*/**"` for archived folders.',
    } satisfies Described<typeof folderEntrySchema.fields>,
  },
  {
    title: "Script entries",
    keys: "`scripts`",
    fields: scriptEntrySchema.fields,
    described: {
      name: "The script's name: lowercase letters, digits and single hyphens.",
      path: "The `.ts` module, relative to the source, whose default export is a `defineScript` definition.",
      description: "What the script does, in one line.",
    } satisfies Described<typeof scriptEntrySchema.fields>,
  },
  {
    title: "Docs entries",
    keys: "`docs`",
    fields: docsEntrySchema.fields,
    described: {
      name: "The docs name: lowercase letters, digits and single hyphens.",
      path: "The folder of Markdown, relative to the source; `.` for the source folder itself.",
      reader:
        "Docs reader settings: an inline mapping, or a source-relative `.yaml` file that holds them.",
    } satisfies Described<typeof docsEntrySchema.fields>,
  },
  {
    title: "Profile publications",
    keys: "`profiles`",
    fields: ProfilePublicationSchema.fields,
    described: {
      name: "The profile's name: lowercase letters, digits and single hyphens.",
      path: "The profile file, relative to the source.",
    } satisfies Described<typeof ProfilePublicationSchema.fields>,
  },
  {
    title: "Bundle support",
    keys: "`bundle-support`",
    fields: BundleSupportEntrySchema.fields,
    described: {
      kind: "The resource's kind: `skill`, `command`, `context`, `script` or `docs`.",
      name: "The resource's name.",
      complete: "`true`: `files` lists everything the resource needs.",
      files: "The source-relative files and folders the resource needs.",
      prerequisites: "The runtime requirements it needs, without secrets.",
      package: "`none` for a resource that needs no package.",
    } satisfies Described<typeof BundleSupportEntrySchema.fields>,
  },
] as const;

/** Whether a struct field may be left out. */
const isOptional = (field: Schema.Top) => field.ast.context?.isOptional === true;

/** A table of the keys `fields` decodes, in its order, with whether each is required and its words. */
const keyTable = <F extends Fields>(fields: F, described: Described<F>) => [
  "| Key | Required | Takes |",
  "| --- | --- | --- |",
  ...Object.entries(fields).map(
    ([key, field]) =>
      `| \`${key}\` | ${isOptional(field) ? "no" : "yes"} | ${described[key as keyof F]} |`,
  ),
];

/** The widest line {@link compactJson} keeps a value on. */
const jsonWidth = 100;

/**
 * `value` as indented JSON that keeps each value short enough on one line, so a JSON Schema stays
 * readable without one line per bracket.
 */
const compactJson = (value: unknown, indent = ""): string => {
  const inline = JSON.stringify(value);
  if (indent.length + inline.length <= jsonWidth || typeof value !== "object" || value === null)
    return inline;
  const inner = `${indent}  `;
  const items = Array.isArray(value)
    ? value.map((item: unknown) => `${inner}${compactJson(item, inner)}`)
    : Object.entries(value).map(
        ([key, item]) => `${inner}${JSON.stringify(key)}: ${compactJson(item, inner)}`,
      );
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return `${open}\n${items.join(",\n")}\n${indent}${close}`;
};

/** A declaration that uses each kind of entry, as `source add --config` takes it. */
export const tackYamlExample = {
  version: 1,
  name: "brain",
  "depends-on": ["base-skills"],
  skills: [{ path: "personal/skills", exclude: ["**/_*/**"] }],
  commands: [{ path: "prompts" }],
  context: [{ path: "notes/rules.md" }],
  scripts: [{ name: "report", path: "tools/report.ts", description: "Write the weekly report" }],
  docs: [{ name: "handbook", path: "team/handbook" }],
};

/**
 * The `tack guide tack-yaml` text. Its key tables are built from the schemas that `tack check` and
 * `source add --config` decode a declaration and its entries with, in their order, so the guide
 * names every key this release takes and no other.
 */
export const tackYamlGuide = (): string =>
  [
    "# Write a tack.yaml",
    "",
    "A source's `tack.yaml` declares what Tack reads from it. Tack builds this guide from the schemas `tack check` and `tack source add --config` validate a declaration with, so it lists every key this release takes.",
    "",
    "Declare a folder that has no `tack.yaml` with its declaration as JSON: the same keys and values. Pass it as the value of `tack source add PATH --config '<json>'`, or pipe it to `--config -`, which reads standard input. The preview reports every issue at once, each with its field and its line, then shows the `tack.yaml` that `--apply` writes. Edit a `tack.yaml` that exists by hand, then run `tack check PATH`.",
    "",
    "```json",
    "{",
    // One key per line, its value on the same line, so the example stays short.
    Object.entries(tackYamlExample)
      .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join(",\n"),
    "}",
    "```",
    "",
    "## Keys",
    "",
    "A `tack.yaml` declares each folder or file that holds resources under the key of its kind.",
    "",
    ...keyTable(DeclarationSchema.fields, declarationKeys),
    "",
    "## The source folder",
    "",
    'An entry whose `path` is `.` declares the folder that holds the `tack.yaml` itself: a folder of skills, of commands or of docs, such as `"skills": [{ "path": "." }]`. Its walk passes over dot, underscore and `node_modules` names. A `tack.yaml` with a `.` entry declares that one kind: another resource key would read the same files, so `tack check` refuses it. A `context` entry is never `.`, since context would take every file.',
    "",
    "## Entries",
    "",
    "Each resource key takes a list of entries. A bad entry is quarantined alone: the rest of the source keeps working.",
    "",
    ...entryShapes.flatMap((shape) => [
      `### ${shape.title}`,
      "",
      `Under ${shape.keys}.`,
      "",
      ...keyTable<Fields>(shape.fields, shape.described),
      "",
    ]),
    "The `manage-tack-sources` skill holds the rules each entry follows: paths, patterns, overlap and nested sources.",
    "",
    "## JSON Schema",
    "",
    "The whole shape at once, for a JSON Schema validator or an editor. Tack builds it from the same entry schemas. It cannot state the rules that need the folder, such as a path that must exist, nor that a `.` entry leaves no other resource key, so `source add --config` and `tack check` remain the check.",
    "",
    "```json",
    compactJson(authoringJsonSchema()),
    "```",
    "",
  ].join("\n");
