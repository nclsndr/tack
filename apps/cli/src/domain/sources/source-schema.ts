import { BundleDigestSchema, BundleFileSchema } from "../bundles/bundle-facts.ts";
import { Effect, Predicate, Schema } from "effect";
import { CanonicalPathSchema, PortableNameSchema } from "../identity/identity-schema.ts";

/** The original source version, used for declarations without profiles. */
export const sourceDeclarationVersion = 1 as const;
/** Profile publications require this source version, so older readers refuse them. */
export const profileSourceDeclarationVersion = 2 as const;

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

/** A person or team named by a source author, without access-control meaning. */
const MaintainerSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    value.trim().length === 0 ? ["A maintainers entry must not be empty."] : [],
  ),
);

/**
 * The list form of a source's `tack.yaml`: no `kind`, and resource keys whose entries name the
 * folders and files that hold resources.
 */
export const ListDeclarationSchema = Schema.Struct({
  version: Schema.Literals([sourceDeclarationVersion, profileSourceDeclarationVersion]),
  name: Schema.optionalKey(SourceLabelSchema),
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
}).check(
  Schema.makeFilter((value) =>
    value.version === 1 && (value.profiles !== undefined || value["bundle-support"] !== undefined)
      ? ["The profiles and bundle-support keys require source declaration version 2."]
      : [],
  ),
);

/** The list form of a validated declaration. */
type ListDeclaration = typeof ListDeclarationSchema.Type;

/** The keys every collection takes: it names no path, because its folder is the collection. */
const collectionFields = {
  version: Schema.Literal(sourceDeclarationVersion),
  name: Schema.optionalKey(SourceLabelSchema),
  maintainers: Schema.optionalKey(Schema.Array(MaintainerSchema)),
};

/**
 * The collections, by `kind`: the folder that holds the `tack.yaml` is the collection. Skills and
 * commands are read at its top only; a docs collection is the whole folder as one docs resource,
 * named by its required `name`, which is also the source label.
 */
const collectionSchemas = {
  skills: Schema.Struct({
    ...collectionFields,
    kind: Schema.Literal("skills"),
    "depends-on": Schema.optionalKey(Schema.Array(SourceLabelSchema)),
    imports: Schema.optionalKey(Schema.Unknown),
  }),
  commands: Schema.Struct({
    ...collectionFields,
    kind: Schema.Literal("commands"),
    "depends-on": Schema.optionalKey(Schema.Array(SourceLabelSchema)),
  }),
  docs: Schema.Struct({
    ...collectionFields,
    kind: Schema.Literal("docs"),
    name: SourceLabelSchema,
    reader: Schema.optionalKey(Schema.Unknown),
  }),
} as const;

/** The kinds a collection can hold, as its `kind` spells them. */
export const collectionKinds = ["skills", "commands", "docs"] as const;

/** A validated collection declaration. */
export type CollectionDeclaration =
  (typeof collectionSchemas)[keyof typeof collectionSchemas]["Type"];

/** A validated source declaration: the list form or one collection. */
export type SourceDeclaration = ListDeclaration | CollectionDeclaration;

/** Every shape of `tack.yaml`; decode it with {@link decodeSourceDeclaration} for one message. */
export const SourceDeclarationSchema = Schema.Union([
  ListDeclarationSchema,
  collectionSchemas.skills,
  collectionSchemas.commands,
  collectionSchemas.docs,
]);

/** Whether a declaration is a collection rather than the list form. */
export const isCollection = (
  declaration: SourceDeclaration,
): declaration is CollectionDeclaration => "kind" in declaration;

type CollectionKind = (typeof collectionKinds)[number];

const isCollectionKind = (kind: string): kind is CollectionKind =>
  collectionKinds.some((known) => known === kind);

/** The `kind` of a declaration, checked alone so a wrong value gets its own message. */
const CollectionKindSchema = Schema.Struct({
  kind: Schema.String.check(
    Schema.makeFilter((kind) =>
      kind === "skill"
        ? [
            "Write kind: skills. A folder with SKILL.md is one skill: register the folder that holds it.",
          ]
        : [],
    ),
  ).pipe(
    Schema.refine(isCollectionKind, {
      message: "A collection's kind is skills, commands or docs.",
    }),
  ),
});

/**
 * Decodes a parsed `tack.yaml`, refusing keys its shape does not name. A document with `kind` is a
 * collection: the kind is read first and then decoded with that collection's schema alone, so a
 * stray key or a wrong kind gets one precise message rather than a union error.
 */
export const decodeSourceDeclaration = (parsed: unknown) =>
  Predicate.hasProperty(parsed, "kind") === false
    ? Schema.decodeUnknownEffect(ListDeclarationSchema, { onExcessProperty: "error" })(parsed).pipe(
        Effect.map((declaration): SourceDeclaration => declaration),
      )
    : Schema.decodeUnknownEffect(CollectionKindSchema)(parsed).pipe(
        Effect.flatMap(({ kind }) =>
          Schema.decodeUnknownEffect(collectionSchemas[kind], { onExcessProperty: "error" })(
            parsed,
          ),
        ),
        Effect.map((declaration): SourceDeclaration => declaration),
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
