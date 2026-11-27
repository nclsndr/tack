import { BundleDigestSchema, BundleFileSchema } from "./bundle-facts.ts";
import { Predicate, Schema, SchemaIssue } from "effect";
import { CanonicalPathSchema, PortableNameSchema } from "../identity/identity-schema.ts";
import { Yaml } from "../runtime-neutral.ts";

/** The one source declaration version Tack reads and writes. */
export const sourceDeclarationVersion = 1 as const;

/** The identity Tack gives one registration: a version-4 UUID. */
export const SourceRegistrationIdSchema = Schema.String.check(Schema.isUUID(4));

/** A human-facing label that cannot be confused with a registration ID. */
export const SourceLabelSchema = PortableNameSchema.check(
  Schema.makeFilter((label) =>
    Schema.is(SourceRegistrationIdSchema)(label)
      ? ["A source name must not look like a source registration ID."]
      : [],
  ),
);

/**
 * The source name a folder suggests: its name in lowercase, each run of other characters a hyphen,
 * cut to the label's length. Undefined when nothing usable is left, as for `___` or an ID.
 */
export const suggestedSourceName = (folderName: string): string | undefined => {
  const name = folderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
  return Schema.is(SourceLabelSchema)(name) ? name : undefined;
};

/**
 * Why a `tack.yaml` without `name` is refused, and the line to add, suggested from the folder. The
 * name never falls back to the folder itself: `depends-on` and `source:` references name the source
 * the same way on every machine, whatever its folder is called there.
 */
export const missingSourceNameMessage = (folderName: string) => {
  const suggested = suggestedSourceName(folderName);
  return suggested === undefined
    ? `tack.yaml has no name. Add a name: line with lowercase letters, digits and hyphens: the name is the source label that depends-on and source: references use on every machine.`
    : `tack.yaml has no name. Add "name: ${suggested}" to it: the name is the source label that depends-on and source: references use on every machine.`;
};

/** A person or team named by a source author, without access-control meaning. */
const MaintainerSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    value.trim().length === 0 ? ["A maintainers entry must not be empty."] : [],
  ),
);

/**
 * The resource keys of a declaration. `docs` is a resource key, but a source that declares only
 * `docs` still has its resource folders checked.
 */
export const declarationResourceKeys = [
  "skills",
  "commands",
  "context",
  "scripts",
  "docs",
] as const;

/** The declared path that names the source folder itself, the one that holds the `tack.yaml`. */
export const sourceFolderPath = ".";

/** The resource keys that hold an entry whose path is `.`, in declaration key order. */
export const keysAtSourceFolder = (value: { readonly [key: string]: unknown }) =>
  declarationResourceKeys.filter((key) => {
    const entries = value[key];
    return (
      Array.isArray(entries) &&
      entries.some(
        (entry: unknown) =>
          Predicate.hasProperty(entry, "path") === true && entry.path === sourceFolderPath,
      )
    );
  });

/**
 * What a `.` entry of each key lists instead, resource by resource: resources at the top of the
 * source folder have no one folder that holds them.
 */
const eachOf = {
  skills: "each skill folder",
  commands: "each command file",
  context: "each context file",
  scripts: "each script",
  docs: "each docs folder",
} as const satisfies Record<(typeof declarationResourceKeys)[number], string>;

/**
 * A declaration with a `.` entry declares one resource kind: the folder that holds its
 * `tack.yaml` is that kind's folder, so another resource key would read the same files. Each
 * other resource key is an issue at its own field. Both the runtime and the authoring schema
 * check it.
 */
export const oneKindAtSourceFolder = Schema.makeFilter(
  (value: { readonly [key: string]: unknown }) => {
    const [key] = keysAtSourceFolder(value);
    if (key === undefined) return [];
    return declarationResourceKeys
      .filter((other) => other !== key && value[other] !== undefined)
      .map((other) => ({
        path: [other],
        issue: `The ${key} entry "." declares the source folder itself, so this tack.yaml declares ${key} only. List ${eachOf[key]} instead of ".", or name the folder that holds the ${key}, or move ${other} to a tack.yaml of its own folder.`,
      }));
  },
);

/**
 * A source's `tack.yaml`: resource keys whose entries name the folders and files that hold
 * resources, where `.` names the source folder itself.
 */
export const DeclarationSchema = Schema.Struct({
  version: Schema.Literal(sourceDeclarationVersion),
  name: SourceLabelSchema,
  maintainers: Schema.optionalKey(Schema.Array(MaintainerSchema)),
  "depends-on": Schema.optionalKey(Schema.Array(SourceLabelSchema)),
  // Resource keys are decoded as unknown here and validated entry by entry by discovery, so one
  // bad entry never makes the whole source unhealthy.
  skills: Schema.optionalKey(Schema.Unknown),
  commands: Schema.optionalKey(Schema.Unknown),
  context: Schema.optionalKey(Schema.Unknown),
  scripts: Schema.optionalKey(Schema.Unknown),
  docs: Schema.optionalKey(Schema.Unknown),
  profiles: Schema.optionalKey(Schema.Unknown),
  "bundle-support": Schema.optionalKey(Schema.Unknown),
  // The imports section records provenance and is never a resource declaration. It is decoded as
  // unknown here, and only the import commands decode it strictly, so a bad record never makes
  // the source unhealthy for a release that knows the key.
  imports: Schema.optionalKey(Schema.Unknown),
}).check(oneKindAtSourceFolder);

/** A validated source declaration. */
export type SourceDeclaration = typeof DeclarationSchema.Type;

/** Every issue at once, and no key the shape does not name. */
const decodeOptions = { onExcessProperty: "error", errors: "all" } as const;

/**
 * Decodes a parsed `tack.yaml`, refusing keys it does not name and reporting every issue at once.
 */
export const decodeSourceDeclaration = (parsed: unknown) =>
  Schema.decodeUnknownEffect(DeclarationSchema, decodeOptions)(parsed);

/** The resource keys a retired `kind` key named, each now declared by a `.` entry. */
const retiredKinds = ["skills", "commands", "docs"] as const;

/** How a declaration is written: a `tack.yaml`, or the JSON `source add --config` takes. */
export type DeclarationFormat = "yaml" | "json";

/**
 * Why a declaration with the retired `kind` key is refused, with the declaration to write instead:
 * the same keys, and the kind's resource key with one `.` entry. A docs entry takes the source
 * name and the `reader` settings.
 */
const kindMessage = (parsed: { readonly [key: string]: unknown }, format: DeclarationFormat) => {
  const { kind, ...rest } = parsed;
  const retired = retiredKinds.find((known) => known === kind);
  if (retired === undefined)
    return `A tack.yaml takes no kind key. Declare the folder that holds it as a "." entry, such as skills: [{ path: "." }]; tack guide tack-yaml lists every key.`;
  const { reader, ...others } = rest;
  const replacement =
    retired === "docs"
      ? {
          ...others,
          docs: [
            {
              name: rest["name"],
              path: sourceFolderPath,
              ...(reader === undefined ? {} : { reader }),
            },
          ],
        }
      : { ...rest, [retired]: [{ path: sourceFolderPath }] };
  const text = format === "json" ? JSON.stringify(replacement) : Yaml.stringify(replacement);
  return `A tack.yaml takes no kind key: a "." entry declares the folder that holds it. Write instead:\n${text
    .trimEnd()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}`;
};

/** One reason a parsed declaration does not decode, and the field it concerns when it has one. */
export type DeclarationIssue = { readonly field?: string; readonly message: string };

/**
 * The messages the formatter gives the two leaves whose message names their key: it knows the
 * key only by the path it reports beside the message.
 */
const leafMarkers = { unexpected: "\u0000unexpected-key", missing: "\u0000missing-key" } as const;

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === "UnexpectedKey"
      ? leafMarkers.unexpected
      : issue._tag === "MissingKey"
        ? leafMarkers.missing
        : SchemaIssue.defaultLeafHook(issue),
});

/**
 * A decode path as a field: `["depends-on", 0]` is `depends-on[0]`. The formatter reports each
 * segment as a plain key, never as a Standard Schema segment object.
 */
const fieldOf = (path: ReadonlyArray<unknown>) =>
  path.reduce<string>(
    (field, key) =>
      typeof key === "number"
        ? `${field}[${key}]`
        : field === ""
          ? String(key)
          : `${field}.${String(key)}`,
    "",
  );

/**
 * Each issue of a declaration that {@link decodeSourceDeclaration} refused, in the order the
 * schema reports them. An unknown key names the keys its shape takes, read from the schema, and a
 * missing name suggests one from `folderName`.
 */
export const declarationIssues = (
  parsed: unknown,
  error: Schema.SchemaError,
  folderName: string,
  format: DeclarationFormat,
): ReadonlyArray<DeclarationIssue> =>
  // The retired kind key is the one issue to fix first: what replaces it decodes differently.
  Predicate.isObject(parsed) === true && "kind" in parsed
    ? [{ field: "kind", message: kindMessage(parsed, format) }]
    : formatIssues(error.issue).issues.map(({ path, message }): DeclarationIssue => {
        // The formatter gives every issue a path, the empty one for the declaration as a whole.
        const field = fieldOf(path ?? /* v8 ignore next -- @preserve */ []);
        if (field === "") return { message };
        if (message === leafMarkers.unexpected)
          return {
            field,
            message: `Unknown key "${field}". A tack.yaml takes: ${Object.keys(DeclarationSchema.fields).join(", ")}.`,
          };
        if (message === leafMarkers.missing)
          return {
            field,
            message:
              field === "name" ? missingSourceNameMessage(folderName) : `Missing key "${field}".`,
          };
        return { field, message: `${field}: ${message}` };
      });

/** A heads-up about a healthy source, which never changes its health or an exit code. */
export const SourceWarningSchema = Schema.Struct({
  code: Schema.Literal("source-declares-no-resources"),
  message: Schema.String,
});

/** A source label that cannot be used, without affecting source health. */
export const SourceLabelIssueSchema = Schema.Struct({
  code: Schema.Literals(["source-label-reserved", "source-label-clash"]),
  message: Schema.String,
});

/** A machine-local stable identity assigned to one source registration. */
const sourceValidationErrorCodes = [
  "source-missing",
  "source-not-directory",
  "declaration-missing",
  "declaration-malformed",
  "declaration-root-not-mapping",
  "declaration-schema-invalid",
  "declaration-version-unsupported",
  "declaration-resources-undeclared",
  "source-is-one-skill",
] as const;

const sourceStorageErrorCodes = ["source-access-failed", "declaration-access-failed"] as const;

const sourceHealthErrorCodes = ["source-location-changed", "source-bundle-changed"] as const;

/** Stable validation reasons for an unusable source path or declaration. */
export const SourceValidationErrorCodeSchema = Schema.Literals(sourceValidationErrorCodes);

/** Stable platform-failure reasons for source observation and registration. */
export const SourceStorageErrorCodeSchema = Schema.Literals(sourceStorageErrorCodes);

/** Stable identity and location drift reasons for a registered source. */
export const SourceHealthErrorCodeSchema = Schema.Literals(sourceHealthErrorCodes);

/** Every stable reason an unhealthy registered source can expose. */
export const SourceIssueCodeSchema = Schema.Literals([
  ...sourceValidationErrorCodes,
  ...sourceStorageErrorCodes,
  ...sourceHealthErrorCodes,
]);

/** JSON-safe health details retained independently from runtime error objects. */
export const SourceIssueSchema = Schema.Struct({
  code: SourceIssueCodeSchema,
  message: Schema.String,
  operation: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(CanonicalPathSchema),
  sourcePath: Schema.optionalKey(CanonicalPathSchema),
});

/** The persisted machine-owned record for one registered source. */
export const SourceRegistrationSchema = Schema.Struct({
  canonicalPath: CanonicalPathSchema,
  id: SourceRegistrationIdSchema,
  bundle: Schema.optionalKey(
    Schema.Struct({
      identity: BundleDigestSchema,
      sourceKey: PortableNameSchema,
      bindings: Schema.Record(SourceLabelSchema, SourceRegistrationIdSchema),
      sourceKeys: Schema.Record(SourceLabelSchema, PortableNameSchema),
      files: Schema.Array(BundleFileSchema),
    }),
  ),
});

/** A fully validated persisted source registration. */
export type SourceRegistration = typeof SourceRegistrationSchema.Type;
