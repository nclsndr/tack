import { Schema, Struct } from "effect";
import { ProfilePublicationSchema } from "../../domain/profiles/profile-schema.ts";
import { collectionSchemas, ListDeclarationSchema } from "../../domain/sources/source-schema.ts";
import { BundleSupportEntrySchema } from "../profiles/bundle-support.ts";
import { docsEntrySchema } from "../sources/docs-discovery.ts";
import { folderEntrySchema, scriptEntrySchema } from "../sources/resource-declarations.ts";

/** The entries catalog discovery decodes, each named so a JSON Schema defines it once. */
const entries = {
  folder: folderEntrySchema.annotate({ identifier: "FolderEntry" }),
  script: scriptEntrySchema.annotate({ identifier: "ScriptEntry" }),
  docs: docsEntrySchema.annotate({ identifier: "DocsEntry" }),
  profile: ProfilePublicationSchema.annotate({ identifier: "ProfilePublication" }),
  bundle: BundleSupportEntrySchema.annotate({ identifier: "BundleSupport" }),
};

/** The resource keys of the list form, each a list of the entries its discovery decodes. */
const resourceLists = {
  skills: Schema.optionalKey(Schema.Array(entries.folder)),
  commands: Schema.optionalKey(Schema.Array(entries.folder)),
  context: Schema.optionalKey(Schema.Array(entries.folder)),
  scripts: Schema.optionalKey(Schema.Array(entries.script)),
  docs: Schema.optionalKey(Schema.Array(entries.docs)),
};

/** The list-form keys every version takes, as the runtime decoder reads them. */
const listFields = Struct.omit(ListDeclarationSchema.fields, [
  "version",
  "profiles",
  "bundle-support",
  "imports",
]);

/**
 * A `tack.yaml` as an author writes it, or `source add --config` takes it: the forms and keys the
 * runtime decoder takes, with each resource key a list of the entries catalog discovery decodes,
 * and without `imports`, which only `tack import add` writes. The runtime keeps its two tiers, so
 * one bad entry never makes a source unhealthy; this schema states the whole shape at once.
 */
export const AuthoringDeclarationSchema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), ...listFields, ...resourceLists }).annotate({
    title: "List form, version 1",
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    ...listFields,
    ...resourceLists,
    profiles: Schema.optionalKey(Schema.Array(entries.profile)),
    "bundle-support": Schema.optionalKey(Schema.Array(entries.bundle)),
  }).annotate({ title: "List form, version 2: profiles and bundle-support" }),
  Schema.Struct(Struct.omit(collectionSchemas.skills.fields, ["imports"])).annotate({
    title: "Skills collection",
  }),
  collectionSchemas.commands.annotate({ title: "Commands collection" }),
  collectionSchemas.docs.annotate({ title: "Docs collection" }),
]);

/**
 * The JSON Schema of {@link AuthoringDeclarationSchema}, draft 2020-12: it refuses keys a form does
 * not name, as the runtime decoder does, and defines each entry once under `$defs`.
 */
export const authoringJsonSchema = () => {
  const document = Schema.toJsonSchemaDocument(AuthoringDeclarationSchema, {
    onExcessProperty: "error",
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    $defs: document.definitions,
  };
};
