import { Schema } from "effect";
import { CanonicalPathSchema, PortableNameSchema } from "../identity/identity-schema.ts";
import { ProjectNameSchema } from "../projects/project-schema.ts";
import {
  dependencyTargetKinds,
  isLinkableKind,
  isSelectableKind,
  ResourceKindSchema,
  type LinkableKind,
  type ResourceKind,
  type SelectableKind,
} from "../resources/kinds.ts";
import { SourceRegistrationIdSchema } from "./source-schema.ts";

/** The only resource-metadata schema version supported by this Tack release. */
export const resourceMetadataVersion = 1 as const;

/** A portable Agent Skills name, shared by directory names and exact addresses. */
export const SkillNameSchema = PortableNameSchema;

/** The activation modes understood by the first catalog resolver. */
export const SkillActivationSchema = Schema.Literals(["default", "opt-in"]);

/**
 * The exact identity of one discovered skill. Every resource address is an exact identity: the
 * source registration that owns it, its kind and its name. No address can be written without its
 * source, so no consumer has to ask whether one was pinned.
 */
export const SkillAddressSchema = Schema.Struct({
  kind: Schema.Literal("skill"),
  name: SkillNameSchema,
  sourceRegistrationId: SourceRegistrationIdSchema,
});

/** The filename identity of one discovered command. */
export const CommandAddressSchema = Schema.Struct({
  kind: Schema.Literal("command"),
  name: SkillNameSchema,
  sourceRegistrationId: SourceRegistrationIdSchema,
});
/** The folder-relative identity of one context file. */
export const ContextAddressSchema = Schema.Struct({
  kind: Schema.Literal("context"),
  name: Schema.String,
  sourceRegistrationId: SourceRegistrationIdSchema,
});
/** The extensionless declared identity of one script entrypoint. */
export const ScriptAddressSchema = Schema.Struct({
  kind: Schema.Literal("script"),
  name: Schema.String.check(Schema.isMinLength(1)),
  sourceRegistrationId: SourceRegistrationIdSchema,
});
/** The source-local identity of a declared document directory. */
export const DocsAddressSchema = Schema.Struct({
  kind: Schema.Literal("docs"),
  name: SkillNameSchema,
  sourceRegistrationId: SourceRegistrationIdSchema,
});

/** Resources that may participate in namespace selection. */
export const SelectableAddressSchema = Schema.Union([
  SkillAddressSchema,
  CommandAddressSchema,
  ContextAddressSchema,
]);
export type SelectableAddress = typeof SelectableAddressSchema.Type;

/** Resources that adapters can deliver as managed symbolic links. */
export const LinkableAddressSchema = Schema.Union([SkillAddressSchema, CommandAddressSchema]);
export type LinkableAddress = typeof LinkableAddressSchema.Type;

/** Whether an address names a resource that takes part in namespace selection. */
export const isSelectableAddress = <Address extends { readonly kind: ResourceKind }>(
  address: Address,
): address is Extract<Address, { readonly kind: SelectableKind }> => isSelectableKind(address.kind);

/** Whether an address names a resource that adapters deliver as a managed link. */
export const isLinkableAddress = <Address extends { readonly kind: ResourceKind }>(
  address: Address,
): address is Extract<Address, { readonly kind: LinkableKind }> => isLinkableKind(address.kind);

/** The exact identity of any catalog resource, shared with quarantine diagnostics. */
export const ResourceAddressSchema = Schema.Union([
  SkillAddressSchema,
  CommandAddressSchema,
  ContextAddressSchema,
  ScriptAddressSchema,
  DocsAddressSchema,
]);
/** A validated catalog address. */
export type ResourceAddress = typeof ResourceAddressSchema.Type;

/**
 * Returns the canonical comparison and lookup key for one exact resource identity. This is the
 * only function that builds the key: every ledger, choice and attachment compares through it.
 */
export const resourceAddressIdentity = (
  address: Pick<ResourceAddress, "kind" | "name" | "sourceRegistrationId">,
) => `${address.sourceRegistrationId}\u0000${address.kind}\u0000${address.name}`;

/** Refuses an entry whose address and registration name different sources. */
const entrySourceAgreement = (entry: {
  readonly address: { readonly sourceRegistrationId: string };
  readonly sourceRegistrationId: string;
}) =>
  entry.address.sourceRegistrationId === entry.sourceRegistrationId
    ? []
    : ["A catalog entry's address and registration must name the same source."];

/** One exact skill or command dependency edge. */
export const ResourceDependencySchema = Schema.Struct({
  kind: Schema.Literals(dependencyTargetKinds),
  name: SkillNameSchema,
  optional: Schema.optionalKey(Schema.Literal(true)),
  source: Schema.optionalKey(Schema.String),
});

/** Tack-specific metadata embedded in the Agent Skills metadata carrier. */
export const TackMetadataSchema = Schema.Struct({
  activation: Schema.optionalKey(SkillActivationSchema),
  "user-activation": Schema.optionalKey(SkillActivationSchema),
  dependencies: Schema.optionalKey(Schema.Array(ResourceDependencySchema)),
  projects: Schema.optionalKey(Schema.Array(ProjectNameSchema)),
  version: Schema.Literal(resourceMetadataVersion),
});

/** Standard metadata keys retain their documented string constraints. */
const SkillCompatibilitySchema = Schema.String.check(Schema.isMinLength(1)).check(
  Schema.isMaxLength(500),
);

/**
 * The frontmatter carrier keeps unknown agent-specific fields while validating
 * the common Agent Skills fields Tack needs for discovery.
 */
export const SkillFrontmatterSchema = Schema.StructWithRest(
  Schema.Struct({
    "allowed-tools": Schema.optionalKey(Schema.String),
    compatibility: Schema.optionalKey(SkillCompatibilitySchema),
    description: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(1024)),
    license: Schema.optionalKey(Schema.String),
    metadata: Schema.optionalKey(Schema.Unknown),
    name: SkillNameSchema,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** The Agent Skills metadata mapping, before decoding its nested Tack string. */
export const MetadataCarrierSchema = Schema.StructWithRest(
  Schema.Struct({
    tack: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.String)],
);

/** Stable reasons for excluding one discovered skill from the catalog. */
export const CatalogQuarantineReasonSchema = Schema.Literals([
  "skill-address-duplicate",
  "resource-address-duplicate",
  "resource-unreadable",
  "resource-boundary-violation",
  "declaration-invalid",
  "declaration-entry-invalid",
  "declaration-path-invalid",
  "declaration-path-outside-source",
  "declaration-path-missing",
  "declaration-path-wrong-type",
  "declaration-path-overlap",
  "declaration-reaches-source",
  "command-name-invalid",
  "command-frontmatter-invalid",
  "command-metadata-invalid",
  "skill-directory-unreadable",
  "skill-file-unreadable",
  "skill-frontmatter-missing",
  "skill-frontmatter-root-not-mapping",
  "skill-frontmatter-schema-invalid",
  "skill-frontmatter-yaml-malformed",
  "skill-metadata-activation-invalid",
  "skill-metadata-dependency-duplicate",
  "skill-metadata-dependency-invalid",
  "skill-metadata-dependency-kind-unsupported",
  "skill-metadata-not-mapping",
  "skill-metadata-not-string",
  "skill-metadata-root-not-mapping",
  "skill-metadata-schema-invalid",
  "skill-metadata-version-unsupported",
  "skill-metadata-projects-invalid",
  "skill-metadata-yaml-malformed",
  "skill-name-mismatch",
]);

/** Marks a resource provided by the source bundled with this Tack release. */
const builtinOrigin = { origin: Schema.optionalKey(Schema.Literals(["builtin", "bundle"])) };

/** The declared path of the `tack.yaml` entry that put a resource in the catalog. */
const declaredByField = {
  declaredPath: Schema.optionalKey(Schema.String),
};

/** A validated, source-owned entry that can participate in later selection. */
export const SkillCatalogEntrySchema = Schema.Struct({
  ...builtinOrigin,
  ...declaredByField,
  activation: SkillActivationSchema,
  userActivation: Schema.optionalKey(SkillActivationSchema),
  address: SkillAddressSchema,
  dependencies: Schema.Array(ResourceDependencySchema),
  description: Schema.String,
  directoryPath: CanonicalPathSchema,
  frontmatter: Schema.Record(Schema.String, Schema.Unknown),
  projects: Schema.Array(ProjectNameSchema),
  skillFilePath: CanonicalPathSchema,
  sourcePath: CanonicalPathSchema,
  sourceRegistrationId: SourceRegistrationIdSchema,
}).check(Schema.makeFilter(entrySourceAgreement));

/** One quarantined discovered directory and its stable reason. */
export const CatalogQuarantineSchema = Schema.Struct({
  address: Schema.optionalKey(ResourceAddressSchema),
  /** The kind the candidate was discovered as, known even when its address is not. */
  candidateKind: Schema.optionalKey(ResourceKindSchema),
  code: CatalogQuarantineReasonSchema,
  directoryPath: CanonicalPathSchema,
  field: Schema.optionalKey(Schema.String),
  message: Schema.String,
  skillFilePath: Schema.optionalKey(CanonicalPathSchema),
  filePath: Schema.optionalKey(CanonicalPathSchema),
  sourcePath: CanonicalPathSchema,
  sourceRegistrationId: SourceRegistrationIdSchema,
});

/** A validated skill catalog assembled from current source contents. */
export type SkillCatalogEntry = typeof SkillCatalogEntrySchema.Type;

/** A quarantined catalog candidate. */
export type CatalogQuarantine = typeof CatalogQuarantineSchema.Type;

/** A command with optional frontmatter and versioned Tack metadata. */
const CommandCatalogEntrySchema = Schema.Struct({
  ...builtinOrigin,
  ...declaredByField,
  activation: SkillActivationSchema,
  userActivation: Schema.optionalKey(SkillActivationSchema),
  address: CommandAddressSchema,
  dependencies: Schema.Array(ResourceDependencySchema),
  frontmatter: Schema.Record(Schema.String, Schema.Unknown),
  projects: Schema.Array(ProjectNameSchema),
  directoryPath: CanonicalPathSchema,
  filePath: CanonicalPathSchema,
  sourcePath: CanonicalPathSchema,
  sourceRegistrationId: SourceRegistrationIdSchema,
}).check(Schema.makeFilter(entrySourceAgreement));

/** An uninterpreted context file. */
const ContextCatalogEntrySchema = Schema.Struct({
  ...builtinOrigin,
  ...declaredByField,
  address: ContextAddressSchema,
  directoryPath: CanonicalPathSchema,
  filePath: CanonicalPathSchema,
  sourcePath: CanonicalPathSchema,
  sourceRegistrationId: SourceRegistrationIdSchema,
}).check(Schema.makeFilter(entrySourceAgreement));

/** A declared TypeScript entrypoint, without executable-contract validation. */
const ScriptCatalogEntrySchema = Schema.Struct({
  ...builtinOrigin,
  address: ScriptAddressSchema,
  declaredPath: Schema.String,
  description: Schema.String,
  directoryPath: CanonicalPathSchema,
  filePath: CanonicalPathSchema,
  sourcePath: CanonicalPathSchema,
  sourceRegistrationId: SourceRegistrationIdSchema,
}).check(Schema.makeFilter(entrySourceAgreement));

/** A source-declared document directory and optional reader customization. */
const DocsCatalogEntrySchema = Schema.Struct({
  ...builtinOrigin,
  ...declaredByField,
  address: DocsAddressSchema,
  directoryPath: CanonicalPathSchema,
  sourcePath: CanonicalPathSchema,
  sourceRegistrationId: SourceRegistrationIdSchema,
  readerConfig: Schema.Struct({ kind: Schema.Literal("source"), path: CanonicalPathSchema }),
}).check(Schema.makeFilter(entrySourceAgreement));
export type DocsCatalogEntry = typeof DocsCatalogEntrySchema.Type;

/** Catalog resources eligible for selection, including undelivered context. */
const SelectableCatalogEntrySchema = Schema.Union([
  SkillCatalogEntrySchema,
  CommandCatalogEntrySchema,
  ContextCatalogEntrySchema,
]);
export type SelectableCatalogEntry = typeof SelectableCatalogEntrySchema.Type;

/** Catalog resources that have an adapter destination. */
const LinkableCatalogEntrySchema = Schema.Union([
  SkillCatalogEntrySchema,
  CommandCatalogEntrySchema,
]);
export type LinkableCatalogEntry = typeof LinkableCatalogEntrySchema.Type;

/** The single validated resource union reported by catalog and status. */
const CatalogEntrySchema = Schema.Union([
  SkillCatalogEntrySchema,
  CommandCatalogEntrySchema,
  ContextCatalogEntrySchema,
  ScriptCatalogEntrySchema,
  DocsCatalogEntrySchema,
]);
export type CatalogEntry = typeof CatalogEntrySchema.Type;

/** The catalog entry of one kind. */
export type CatalogEntryOf<Kind extends ResourceKind> = Extract<
  CatalogEntry,
  { readonly address: { readonly kind: Kind } }
>;

/** One function per resource kind, each taking the catalog entry of that kind. */
export type EntryKindHandlers<Args extends ReadonlyArray<unknown>, Result> = {
  readonly [Kind in ResourceKind]: (entry: CatalogEntryOf<Kind>, ...args: Args) => Result;
};

/** The handler of one kind, typed so that an entry of that kind is its only entry argument. */
const handlerOf = <Kind extends ResourceKind, Args extends ReadonlyArray<unknown>, Result>(
  handlers: EntryKindHandlers<Args, Result>,
  kind: Kind,
): ((entry: CatalogEntryOf<Kind>, ...args: Args) => Result) => handlers[kind];

/** Turns one handler per kind into a function of any catalog entry. */
export const byEntryKind =
  <Args extends ReadonlyArray<unknown>, Result>(handlers: EntryKindHandlers<Args, Result>) =>
  (entry: CatalogEntry, ...args: Args): Result =>
    handlerOf(handlers, entry.address.kind)(entry, ...args);

/** Narrows a catalog entry to the entries of one kind, read from its address. */
export const isEntryOfKind = <Entry extends CatalogEntry, Kind extends ResourceKind>(
  entry: Entry,
  kind: Kind,
): entry is Extract<Entry, { readonly address: { readonly kind: Kind } }> =>
  entry.address.kind === kind;

/** Returns the canonical file path carried by any catalog entry. */
export const catalogEntryPath = (entry: CatalogEntry): string => {
  if (isEntryOfKind(entry, "skill")) return entry.skillFilePath;
  if (isEntryOfKind(entry, "docs")) return entry.directoryPath;
  return entry.filePath;
};

/** The ephemeral result of resolving all currently healthy registered sources. */
export type Catalog = {
  readonly entries: ReadonlyArray<CatalogEntry>;
  readonly quarantined: ReadonlyArray<CatalogQuarantine>;
  readonly sources?: ReadonlyArray<import("./source-inspection.ts").SourceInspection>;
  readonly unhealthySources: ReadonlyArray<
    Extract<import("./source-inspection.ts").SourceInspection, { status: "unhealthy" }>
  >;
  /** What each healthy source's declarations contribute, keyed by registration ID. */
  readonly declarations?: Readonly<
    Record<string, ReadonlyArray<import("./declaration-facts.ts").DeclarationFacts>>
  >;
};

/** Returns all resources eligible for namespace selection. */
export const catalogSelectableEntries = (catalog: {
  readonly entries: ReadonlyArray<CatalogEntry>;
}): ReadonlyArray<SelectableCatalogEntry> =>
  catalog.entries.filter((entry): entry is SelectableCatalogEntry =>
    isSelectableKind(entry.address.kind),
  );

/** Returns all resources that can produce managed links. */
export const catalogLinkableEntries = (catalog: {
  readonly entries: ReadonlyArray<CatalogEntry>;
}): ReadonlyArray<LinkableCatalogEntry> =>
  catalog.entries.filter((entry): entry is LinkableCatalogEntry =>
    isLinkableKind(entry.address.kind),
  );

/**
 * Returns what one resource is on disk: the folder of a skill or docs, the file of the other kinds.
 * A managed link delivers this path, and a bundle copies it.
 */
export const entryRootPath = byEntryKind<[], string>({
  skill: (entry) => entry.directoryPath,
  command: (entry) => entry.filePath,
  context: (entry) => entry.filePath,
  script: (entry) => entry.filePath,
  docs: (entry) => entry.directoryPath,
});
