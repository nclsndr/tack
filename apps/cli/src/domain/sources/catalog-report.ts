import { Schema } from "effect";
import { CanonicalPathSchema } from "../identity/identity-schema.ts";
import { ProjectNameSchema } from "../projects/project-schema.ts";
import { ResourceKindSchema, type ResourceKind } from "../resources/kinds.ts";
import {
  CommandAddressSchema,
  ContextAddressSchema,
  DocsAddressSchema,
  ResourceAddressSchema,
  ResourceDependencySchema,
  ScriptAddressSchema,
  SkillActivationSchema,
  SkillAddressSchema,
  type Catalog,
  type CatalogEntry,
  type CatalogEntryOf,
  type CatalogQuarantine,
} from "./catalog-schema.ts";
import {
  SourceRegistrationIdSchema,
  SourceLabelIssueSchema,
  SourceWarningSchema,
  SourceIssueSchema,
  SourceRegistrationSchema,
} from "./source-schema.ts";

/** Public source facts repeated once per source, including sources with no resources. */
const CatalogSourceSchema = Schema.Struct({
  registration: SourceRegistrationSchema,
  status: Schema.Literals(["healthy", "unhealthy"]),
  origin: Schema.optionalKey(Schema.Literals(["builtin", "bundle"])),
  issue: Schema.optionalKey(SourceIssueSchema),
  label: Schema.optionalKey(Schema.String),
  labelOrigin: Schema.optionalKey(Schema.Literals(["declared", "derived", "none", "clashing"])),
  maintainers: Schema.optionalKey(Schema.Array(Schema.String)),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  labelIssues: Schema.optionalKey(Schema.Array(SourceLabelIssueSchema)),
  warnings: Schema.optionalKey(Schema.Array(SourceWarningSchema)),
});

/**
 * The provenance every public resource carries: its source registration and location, whether
 * that source is bundled with Tack, and the directory that holds the resource.
 */
const provenanceFields = {
  directoryPath: CanonicalPathSchema,
  origin: Schema.Literals(["builtin", "bundle", "registered"]),
  sourcePath: CanonicalPathSchema,
  sourceRegistrationId: SourceRegistrationIdSchema,
};

/**
 * The declared path of the `tack.yaml` entry that put the resource in the catalog, present in
 * detailed output and wherever a view asks for it; a script always carries it.
 */
const declaredPathField = {
  declaredPath: Schema.optionalKey(Schema.String),
};

/** The complete authored frontmatter mapping, present only in detailed output. */
const frontmatterField = {
  frontmatter: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
};

const activationFields = {
  activation: SkillActivationSchema,
  dependencies: Schema.Array(ResourceDependencySchema),
  projects: Schema.Array(ProjectNameSchema),
  userActivation: Schema.optionalKey(SkillActivationSchema),
};

/*
 * Each variant fixes `kind` and its address's `kind` to the same literal, so a resource whose two
 * kinds disagree matches no variant and is rejected rather than repaired.
 */

/** Where an imported skill came from, and whether its folder still matches what Tack wrote. */
export const ImportedSkillSchema = Schema.Struct({
  /** The folder relative to the source root. */
  path: Schema.String,
  /** The canonical location without a ref, `<provider>:<text>`. */
  location: Schema.String,
  ref: Schema.Struct({
    kind: Schema.Literals(["default", "branch", "tag", "commit"]),
    request: Schema.optionalKey(Schema.String),
    tracking: Schema.Boolean,
  }),
  /** The full commit the import resolved to. */
  revision: Schema.String,
  local: Schema.Literals(["unchanged", "changed", "missing"]),
});

/** The key under which {@link CatalogReportOptions.imported} finds an entry's import facts. */
export const importedKey = (sourceRegistrationId: string, directoryPath: string) =>
  `${sourceRegistrationId}\u0000${directoryPath}`;

/** A skill directory and its `SKILL.md` document. */
const SkillResourceSchema = Schema.Struct({
  kind: Schema.Literal("skill"),
  address: SkillAddressSchema,
  ...provenanceFields,
  ...declaredPathField,
  ...activationFields,
  ...frontmatterField,
  /** Present on a skill that came from an import: the `imported` tag. */
  imported: Schema.optionalKey(Schema.Literal(true)),
  /** With details, where the imported skill came from; see {@link ImportedSkillSchema}. */
  import: Schema.optionalKey(ImportedSkillSchema),
  description: Schema.String,
  filePath: CanonicalPathSchema,
});

/** A command Markdown file; its description is present when the frontmatter declares one. */
const CommandResourceSchema = Schema.Struct({
  kind: Schema.Literal("command"),
  address: CommandAddressSchema,
  ...provenanceFields,
  ...declaredPathField,
  ...activationFields,
  ...frontmatterField,
  description: Schema.optionalKey(Schema.String),
  filePath: CanonicalPathSchema,
});

/** An uninterpreted context file. */
const ContextResourceSchema = Schema.Struct({
  kind: Schema.Literal("context"),
  address: ContextAddressSchema,
  ...provenanceFields,
  ...declaredPathField,
  filePath: CanonicalPathSchema,
});

/** A declared script entrypoint; discovery never imports it. */
const ScriptResourceSchema = Schema.Struct({
  kind: Schema.Literal("script"),
  address: ScriptAddressSchema,
  ...provenanceFields,
  declaredPath: Schema.String,
  description: Schema.String,
  filePath: CanonicalPathSchema,
});

/** A source-declared document directory and its reader configuration. */
const DocsResourceSchema = Schema.Struct({
  kind: Schema.Literal("docs"),
  address: DocsAddressSchema,
  ...provenanceFields,
  ...declaredPathField,
  readerConfig: Schema.Struct({ kind: Schema.Literal("source"), path: CanonicalPathSchema }),
});

/** One validated catalog resource, discriminated directly by `kind`. */
export const CatalogResourceSchema = Schema.Union([
  SkillResourceSchema,
  CommandResourceSchema,
  ContextResourceSchema,
  ScriptResourceSchema,
  DocsResourceSchema,
]);
export type CatalogResource = typeof CatalogResourceSchema.Type;

/**
 * What one catalog issue is about. A resource subject names the rejected candidate, with its kind
 * and address only when they are known; a source subject names a registration with a health or
 * label issue.
 */
const CatalogIssueSubjectSchema = Schema.Union([
  Schema.TaggedStruct("resource", {
    address: Schema.optionalKey(ResourceAddressSchema),
    candidateKind: Schema.optionalKey(ResourceKindSchema),
    candidatePath: CanonicalPathSchema,
    field: Schema.optionalKey(Schema.String),
    sourcePath: CanonicalPathSchema,
    sourceRegistrationId: SourceRegistrationIdSchema,
  }),
  Schema.TaggedStruct("source", {
    origin: provenanceFields.origin,
    sourcePath: CanonicalPathSchema,
    sourceRegistrationId: SourceRegistrationIdSchema,
  }),
]);

/** One discovery problem that kept a candidate or a whole source out of the catalog. */
const CatalogIssueSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  subject: CatalogIssueSubjectSchema,
});
export type CatalogIssue = typeof CatalogIssueSchema.Type;

/**
 * The public catalog: validated resources, the issues that kept anything out, and whether the
 * resources cover every requested source and candidate. An empty complete catalog proves absence;
 * an empty incomplete one does not.
 */
export const CatalogReportSchema = Schema.Struct({
  kind: Schema.Literal("catalog"),
  /** Present when the report covers one resource kind, such as `catalog --kind script`. */
  scope: Schema.optionalKey(ResourceKindSchema),
  complete: Schema.Boolean,
  issues: Schema.Array(CatalogIssueSchema),
  sources: Schema.optionalKey(Schema.Array(CatalogSourceSchema)),
  resources: Schema.Array(CatalogResourceSchema),
}).check(
  Schema.makeFilter((report) => [
    ...(report.complete === (report.issues.length === 0)
      ? []
      : ["A catalog is complete exactly when it has no issues."]),
    ...(report.scope === undefined ||
    report.resources.every((resource) => resource.kind === report.scope)
      ? []
      : ["A scoped catalog contains only resources of its scope."]),
  ]),
);
export type CatalogReport = typeof CatalogReportSchema.Type;

/** How much of each resource a catalog report carries. */
export type CatalogReportOptions = {
  /** Adds each resource's complete authored frontmatter and its declared path. */
  readonly details?: boolean;
  /** Adds each resource's declared path alone, for views that show where a resource comes from. */
  readonly declaredBy?: boolean;
  /** Restricts the report to one resource kind and the issues that can concern it. */
  readonly scope?: CatalogReport["scope"];
  /** Includes one summary per source in the catalog command's public output. */
  readonly includeSources?: boolean;
  /**
   * The imported skills by {@link importedKey}. A skill found here carries the `imported` tag, and
   * with `details` its location, ref request, revision and local state.
   */
  readonly imported?: ReadonlyMap<string, typeof ImportedSkillSchema.Type> | undefined;
};

const frontmatterDescription = (frontmatter: Readonly<Record<string, unknown>>) => {
  const description = frontmatter["description"];
  return typeof description === "string" && description.trim().length > 0 ? { description } : {};
};

const activationOf = (entry: CatalogEntryOf<"skill"> | CatalogEntryOf<"command">) => ({
  activation: entry.activation,
  dependencies: entry.dependencies,
  projects: entry.projects,
  ...(entry.userActivation === undefined ? {} : { userActivation: entry.userActivation }),
});

/** What every report row is built from, whatever the entry's kind. */
type RowContext = {
  readonly provenance: Pick<
    CatalogResource,
    "directoryPath" | "origin" | "sourcePath" | "sourceRegistrationId"
  >;
  /** The declared path, when the options ask for it and the entry has one. */
  readonly declared: { readonly declaredPath?: string };
  readonly details: boolean;
  readonly imported: CatalogReportOptions["imported"];
};

/** How an entry of each kind becomes its public resource row. */
const resourceRows: {
  readonly [K in ResourceKind]: (
    entry: CatalogEntryOf<K>,
    context: RowContext,
  ) => Extract<CatalogResource, { readonly kind: K }>;
} = {
  skill: (entry, { provenance, declared, details, imported: importedSkills }) => {
    const imported = importedSkills?.get(
      importedKey(entry.sourceRegistrationId, entry.directoryPath),
    );
    return {
      kind: "skill",
      address: entry.address,
      ...provenance,
      ...declared,
      ...activationOf(entry),
      description: entry.description,
      filePath: entry.skillFilePath,
      ...(details ? { frontmatter: entry.frontmatter } : {}),
      ...(imported === undefined ? {} : { imported: true as const }),
      ...(imported === undefined || !details ? {} : { import: imported }),
    };
  },
  command: (entry, { provenance, declared, details }) => ({
    kind: "command",
    address: entry.address,
    ...provenance,
    ...declared,
    ...activationOf(entry),
    ...frontmatterDescription(entry.frontmatter),
    filePath: entry.filePath,
    ...(details ? { frontmatter: entry.frontmatter } : {}),
  }),
  context: (entry, { provenance, declared }) => ({
    kind: "context",
    address: entry.address,
    ...provenance,
    ...declared,
    filePath: entry.filePath,
  }),
  script: (entry, { provenance }) => ({
    kind: "script",
    address: entry.address,
    ...provenance,
    declaredPath: entry.declaredPath,
    description: entry.description,
    filePath: entry.filePath,
  }),
  docs: (entry, { provenance, declared }) => ({
    kind: "docs",
    address: entry.address,
    ...provenance,
    ...declared,
    readerConfig: entry.readerConfig,
  }),
};

/** The row function of one kind, typed so that an entry of that kind is its only argument. */
const resourceRowOf = <K extends ResourceKind>(
  kind: K,
): ((entry: CatalogEntryOf<K>, context: RowContext) => CatalogResource) => resourceRows[kind];

/** Projects one internal catalog entry onto its public resource. */
const catalogResource = (
  entry: CatalogEntry,
  options: Pick<CatalogReportOptions, "details" | "declaredBy" | "imported"> = {},
): CatalogResource => {
  const details = options.details === true;
  return resourceRowOf(entry.address.kind)(entry, {
    provenance: {
      directoryPath: entry.directoryPath,
      origin: entry.origin ?? "registered",
      sourcePath: entry.sourcePath,
      sourceRegistrationId: entry.sourceRegistrationId,
    },
    declared:
      details === false && options.declaredBy !== true
        ? {}
        : entry.declaredPath !== undefined
          ? { declaredPath: entry.declaredPath }
          : {},
    details,
    imported: options.imported,
  });
};

/** Projects one quarantined candidate onto its public issue, without inventing an address. */
export const quarantineIssue = (quarantine: CatalogQuarantine): CatalogIssue => ({
  code: quarantine.code,
  message: quarantine.message,
  subject: {
    _tag: "resource",
    ...(quarantine.address === undefined ? {} : { address: quarantine.address }),
    ...(quarantine.candidateKind === undefined ? {} : { candidateKind: quarantine.candidateKind }),
    candidatePath: quarantine.filePath ?? quarantine.skillFilePath ?? quarantine.directoryPath,
    ...(quarantine.field === undefined ? {} : { field: quarantine.field }),
    sourcePath: quarantine.sourcePath,
    sourceRegistrationId: quarantine.sourceRegistrationId,
  },
});

/** Projects one unhealthy source onto its public issue. */
const unhealthySourceIssue = (source: Catalog["unhealthySources"][number]): CatalogIssue => ({
  code: source.issue.code,
  message: source.issue.message,
  subject: {
    _tag: "source",
    origin: source.origin ?? "registered",
    sourcePath: source.registration.canonicalPath,
    sourceRegistrationId: source.registration.id,
  },
});

/**
 * Whether an issue can concern resources of one kind: it does when its candidate is that kind, or
 * when nobody knows the candidate's kind, so the uncertainty stays visible.
 */
const issueConcerns = (issue: CatalogIssue, kind: NonNullable<CatalogReport["scope"]>) =>
  issue.subject._tag === "source" ||
  issue.subject.candidateKind === undefined ||
  issue.subject.candidateKind === kind;

/** Projects a resolved catalog onto its concise public report, or its detailed one on request. */
export const catalogReport = (
  catalog: Catalog,
  options: CatalogReportOptions = {},
): CatalogReport => {
  const { scope } = options;
  const issues = [
    ...catalog.unhealthySources.map(unhealthySourceIssue),
    ...(catalog.sources ?? []).flatMap((source) =>
      (source.labelIssues ?? []).map((issue): CatalogIssue => ({
        code: issue.code,
        message: issue.message,
        subject: {
          _tag: "source",
          origin: source.origin ?? "registered",
          sourcePath: source.registration.canonicalPath,
          sourceRegistrationId: source.registration.id,
        },
      })),
    ),
    ...catalog.quarantined.map(quarantineIssue),
  ].filter((issue) => scope === undefined || issueConcerns(issue, scope));
  return {
    kind: "catalog",
    ...(scope === undefined ? {} : { scope }),
    complete: issues.length === 0,
    issues,
    ...(options.includeSources === false ? {} : { sources: catalog.sources ?? [] }),
    resources: catalog.entries
      .filter((entry) => scope === undefined || entry.address.kind === scope)
      .map((entry) => catalogResource(entry, options)),
  };
};
