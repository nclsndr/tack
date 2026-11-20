import { Glob } from "../../domain/runtime-neutral.ts";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import {
  ResourceKindSchema,
  resourceKinds,
  type ResourceKind,
} from "../../domain/resources/kinds.ts";
import { SkillNameSchema, type CatalogQuarantine } from "../../domain/sources/catalog-schema.ts";
import { declaredPathSyntaxIssue, resolveDeclaredPath } from "./declared-path.ts";
import {
  declarationRecord,
  type DeclarationRecord,
} from "../../domain/sources/declaration-facts.ts";
import { isInside, isStrictlyInside } from "../../domain/identity/path-containment.ts";
import { catalogQuarantine, type ResourceCandidate } from "./discovery-support.ts";
import {
  isCollection,
  type SourceDeclaration,
  type SourceRegistration,
} from "../../domain/sources/source-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { declarationFileName } from "./declaration-file.ts";
import { marksSourceEdge } from "@tackup/reader/source-edges";
import { discoverDocs } from "./docs-discovery.ts";
import { profilePublications } from "./profile-publications.ts";

/** The kinds this module discovers from their resource keys; docs have their own discovery. */
type DeclaredKind = Exclude<ResourceKind, "docs">;
/** The kinds declared by a folder or one file, with include and exclude patterns. */
type FolderKind = Exclude<DeclaredKind, "script">;

/** The resource keys that name where resources of one kind live, with the kind each declares. */
export const declarationKinds = ResourceKindSchema.literals
  .filter((kind): kind is DeclaredKind => kind !== "docs")
  .map((kind) => ({ key: resourceKinds[kind].declarationKey, kind }));

/** The folder at a source root where an import stages its write, outside every declared path. */
export const importStagingFolderName = ".tack-import-staging";

/**
 * Compiles the include and exclude patterns of one declared folder. `selected` decides whether a
 * path relative to the folder is selected; `excludes` holds the exclude globs, which also match a
 * directory when given `path/` with a trailing slash. `excluded` decides whether an exclude names
 * a path, `prunes` whether the walk skips a folder, and `prunedFolder` names the first folder of a
 * `/`-separated folder path that the walk skips.
 */
export const patternSelector = (
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
) => {
  const includes = include?.map((pattern) => new Glob(pattern));
  const excludes = (exclude ?? []).map((pattern) => new Glob(pattern));
  const excluded = (relative: string) => excludes.some((glob) => glob.match(relative) === true);
  const prunes = (folder: string) => excluded(`${folder}/`);
  return {
    excludes,
    excluded,
    selected: (relative: string) =>
      (includes === undefined || includes.some((glob) => glob.match(relative) === true)) &&
      excluded(relative) === false,
    prunes,
    prunedFolder: (folder: string) => {
      const segments = folder === "" ? [] : folder.split("/");
      return segments
        .map((_, index) => segments.slice(0, index + 1).join("/"))
        .find((prefix) => prunes(prefix));
    },
  };
};

/** The patterns of one declared folder, compiled. */
type PatternSelector = ReturnType<typeof patternSelector>;

const patterns = Schema.optionalKey(Schema.Array(Schema.String));
const folderEntrySchema = Schema.Struct({
  path: Schema.String,
  include: patterns,
  exclude: patterns,
});
const scriptEntrySchema = Schema.Struct({
  name: SkillNameSchema,
  path: Schema.String,
  description: Schema.String.check(Schema.isPattern(/\S/)),
});

type FolderEntry = typeof folderEntrySchema.Type;
type ScriptEntry = typeof scriptEntrySchema.Type;

/** Where a declaration points, once its path passed the syntax and location rules. */
type DeclaredPlace = {
  /** Where the entry sits in the declaration, such as `skills entry "vendor/skills"`. */
  readonly label: string;
  readonly resolved: string;
  readonly declaredPath: string;
  readonly record: DeclarationRecord;
};

/** A folder-kind declaration that passed the type and pattern rules. */
type FolderDeclared = DeclaredPlace & {
  readonly kind: FolderKind;
  readonly entry: FolderEntry;
  /** Whether the entry names one resource rather than a folder of them. */
  readonly single: boolean;
};

/** A declaration whose path passed the syntax, location, type and pattern rules. */
type Declared =
  | FolderDeclared
  | (DeclaredPlace & { readonly kind: "script"; readonly entry: ScriptEntry });

const decodeFolderEntry = Schema.decodeUnknownEffect(folderEntrySchema, {
  onExcessProperty: "error",
});
const decodeScriptEntry = Schema.decodeUnknownEffect(scriptEntrySchema, {
  onExcessProperty: "error",
});

/** A decoded entry, with the kind whose shape it has. */
type DecodedEntry =
  | { readonly kind: "script"; readonly entry: ScriptEntry }
  | { readonly kind: FolderKind; readonly entry: FolderEntry };

/** Decodes one entry of a resource key, reporting why it does not decode instead of failing. */
export const decodeEntry = (
  kind: DeclaredKind,
  candidate: unknown,
): Effect.Effect<DecodedEntry | { readonly error: string }> =>
  (kind === "script"
    ? decodeScriptEntry(candidate).pipe(Effect.map((entry): DecodedEntry => ({ kind, entry })))
    : decodeFolderEntry(candidate).pipe(Effect.map((entry): DecodedEntry => ({ kind, entry })))
  ).pipe(Effect.catch((error) => Effect.succeed({ error: error.message })));

const entryPathOf = (candidate: unknown): string | undefined =>
  typeof candidate === "object" &&
  candidate !== null &&
  "path" in candidate &&
  typeof candidate.path === "string"
    ? candidate.path
    : undefined;

/** What a declaration row can show about an entry, even one that does not decode. */
const recordFor = (kind: DeclaredKind, candidate: unknown): DeclarationRecord => {
  const field = (key: string): unknown =>
    typeof candidate === "object" && candidate !== null ? Reflect.get(candidate, key) : undefined;
  const strings = (key: string): ReadonlyArray<string> | undefined => {
    const value: unknown = field(key);
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : undefined;
  };
  const path = entryPathOf(candidate);
  const name = field("name");
  const include = strings("include");
  const exclude = strings("exclude");
  return declarationRecord(kind, {
    ...(path === undefined ? {} : { path }),
    ...(typeof name === "string" ? { name } : {}),
    ...(include === undefined ? {} : { include }),
    ...(exclude === undefined ? {} : { exclude }),
  });
};

/** Quarantines one problem and records it under the declaration it concerns. */
const reporterFor =
  (source: SourceRegistration, quarantined: Array<CatalogQuarantine>) =>
  (
    record: DeclarationRecord,
    target: string,
    code: CatalogQuarantine["code"],
    message: string,
    kind: ResourceKind,
    address?: CatalogQuarantine["address"],
  ) => {
    quarantined.push(catalogQuarantine(source, target, code, message, address, undefined, kind));
    record.problems.push({ code, message, candidatePath: target });
  };

/** Reports one declaration problem against the declaration record and path it concerns. */
type ReportDeclarationIssue = ReturnType<typeof reporterFor>;

/** Drops every declaration problem, for a reader that needs only the entries that pass. */
const ignoreIssues: ReportDeclarationIssue = () => undefined;

/** A path observed inside its boundary: its canonical location and what it is. */
type Observed = { readonly canonical: string; readonly info: FileSystem.File.Info };

/** What the discovery of one source reads with and collects into. */
type Discovery = {
  readonly source: SourceRegistration;
  readonly path: Path.Path;
  readonly candidates: Array<ResourceCandidate>;
  /** Resolves a path, reporting it when it leaves its boundary or cannot be read. */
  readonly observe: (
    record: DeclarationRecord,
    target: string,
    boundary: string,
    kind: ResourceKind,
    address?: CatalogQuarantine["address"],
  ) => Effect.Effect<Observed | undefined>;
  /** Walks a declared folder, or only the content of one declared skill. */
  readonly walk: (declared: FolderDeclared, insideSkill: boolean) => Effect.Effect<void>;
};

/** What a candidate records about the declaration that found it. */
type FoundBy = {
  readonly declaredPath?: string;
  readonly collection?: true;
  readonly record: DeclarationRecord;
};

/** A file found under a folder declaration, before its kind decides whether it is a resource. */
type FoundFile = {
  readonly declared: FoundBy;
  /** The folder the resource's name is relative to. */
  readonly boundary: string;
  readonly filePath: string;
};

/** The address a skill or command name spells, or undefined when no address can spell it. */
const portableAddress = <Kind extends "skill" | "command">(
  kind: Kind,
  source: SourceRegistration,
  name: string,
) =>
  Schema.is(SkillNameSchema)(name) === true
    ? { kind, sourceRegistrationId: source.id, name }
    : undefined;

/** Adds the skill whose folder holds the observed `SKILL.md`. */
const addSkill = (
  discovery: Discovery,
  declared: FoundBy,
  directory: string,
  skillFile: Observed,
) => {
  const address = portableAddress("skill", discovery.source, discovery.path.basename(directory));
  discovery.candidates.push({
    source: discovery.source,
    kind: "skill",
    ...foundBy(declared),
    ...(address === undefined ? {} : { address }),
    filePath: skillFile.canonical,
  });
};

/** The fields a candidate takes from the declaration that found it. */
const foundBy = (declared: FoundBy) => ({
  ...(declared.declaredPath === undefined ? {} : { declaredPath: declared.declaredPath }),
  ...(declared.collection === undefined ? {} : { collection: declared.collection }),
  record: declared.record,
});

/** Adds the candidate a found file makes under a declaration of the given kind, if it makes one. */
const addFile = (discovery: Discovery, kind: FolderKind, found: FoundFile) => {
  const candidate = folderKinds[kind].fileCandidate(discovery, found);
  if (candidate !== undefined) discovery.candidates.push(candidate);
};

/** Adds the one file a command or context declaration names, named as if found in its folder. */
const addDeclaredFile = (declared: FolderDeclared, discovery: Discovery) =>
  Effect.sync(() =>
    addFile(discovery, declared.kind, {
      declared,
      boundary: discovery.path.dirname(declared.resolved),
      filePath: declared.resolved,
    }),
  );

/** What a folder kind accepts as its declared path and how it reads what the path holds. */
type FolderKindRules = {
  /** What the declared path must name, or undefined when the resolved path qualifies. */
  readonly misnamed: (type: FileSystem.File.Type, resolved: string) => string | undefined;
  /** What one resource of the kind is called when patterns cannot apply to it. */
  readonly one: string;
  /**
   * Whether a folder that holds `SKILL.md` is one resource rather than a folder of them. A kind
   * without skill folders declares one resource by naming one file.
   */
  readonly skillFolders: boolean;
  /** The code reported when a folder under the declaration cannot be read. */
  readonly unreadableFolder: CatalogQuarantine["code"];
  /** The candidate a file found under the declaration makes, or undefined when it is none. */
  readonly fileCandidate: (discovery: Discovery, found: FoundFile) => ResourceCandidate | undefined;
  /** Adds the candidate of a declaration that names one resource. */
  readonly discoverOne: (declared: FolderDeclared, discovery: Discovery) => Effect.Effect<void>;
};

/** One row per folder kind: every rule that differs between skills, commands and context. */
const folderKinds: { readonly [K in FolderKind]: FolderKindRules } = {
  skill: {
    misnamed: (type) => (type === "Directory" ? undefined : "a folder"),
    one: "skill",
    skillFolders: true,
    unreadableFolder: "skill-directory-unreadable",
    // A file outside any skill folder is not a resource.
    fileCandidate: () => undefined,
    discoverOne: Effect.fnUntraced(function* (declared, discovery) {
      const skillFile = yield* discovery.observe(
        declared.record,
        discovery.path.join(declared.resolved, "SKILL.md"),
        declared.resolved,
        declared.kind,
        portableAddress("skill", discovery.source, discovery.path.basename(declared.resolved)),
      );
      if (skillFile === undefined || skillFile.info.type !== "File") return;
      addSkill(discovery, declared, declared.resolved, skillFile);
      yield* discovery.walk(declared, true);
    }),
  },
  command: {
    misnamed: (type, resolved) =>
      type === "Directory"
        ? undefined
        : type !== "File"
          ? "a folder or one file"
          : resolved.endsWith(".md")
            ? undefined
            : "a folder or one .md file",
    one: "file",
    skillFolders: false,
    unreadableFolder: "resource-unreadable",
    fileCandidate: ({ source, path }, { declared, filePath }) => {
      const fileName = path.basename(filePath);
      if (fileName.endsWith(".md") === false) return undefined;
      const address = portableAddress("command", source, fileName.slice(0, -3));
      return {
        source,
        kind: "command",
        ...foundBy(declared),
        ...(address === undefined ? {} : { address }),
        filePath,
      };
    },
    discoverOne: addDeclaredFile,
  },
  context: {
    misnamed: (type) =>
      type === "Directory" || type === "File" ? undefined : "a folder or one file",
    one: "file",
    skillFolders: false,
    unreadableFolder: "resource-unreadable",
    fileCandidate: ({ source, path }, { declared, boundary, filePath }) => ({
      source,
      kind: "context",
      ...foundBy(declared),
      address: {
        kind: "context",
        sourceRegistrationId: source.id,
        name: path.relative(boundary, filePath).split(path.sep).join("/"),
      },
      filePath,
    }),
    discoverOne: addDeclaredFile,
  },
};

/**
 * A path one entry owns, as the overlap rule compares it: a skills, commands, context or scripts
 * entry, or a profile publication. Docs own nothing, since they are never linked by name.
 */
type Owner = {
  readonly kind: DeclaredKind | "profile";
  readonly label: string;
  readonly declaredPath: string;
  readonly resolved: string;
  readonly file: boolean;
  /** The patterns of a folder entry, which may exclude what lies inside it; else undefined. */
  readonly patterns: PatternSelector | undefined;
};

/** The `/`-separated path of `inner` relative to `outer`, which strictly holds it. */
const relativeInside = (path: Path.Path, outer: Owner, inner: Owner) =>
  path.relative(outer.resolved, inner.resolved).split(path.sep).join("/");

/**
 * The exclude that would take `inner` out of the walk of `outer`, or undefined when `outer` takes
 * no patterns or does not strictly hold `inner`.
 */
const excludeFor = (path: Path.Path, outer: Owner, inner: Owner) => {
  if (outer.patterns === undefined || isStrictlyInside(outer.resolved, inner.resolved) === false)
    return undefined;
  const relative = relativeInside(path, outer, inner);
  return inner.file === true ? relative : `${relative}/**`;
};

/**
 * Whether the walk of `outer` never reaches `inner`, which it strictly holds: an exclude prunes a
 * folder on the way, or excludes the file `inner` names. Equal paths are never pruned.
 */
const walkSkips = (path: Path.Path, outer: Owner, inner: Owner) => {
  if (outer.patterns === undefined || isStrictlyInside(outer.resolved, inner.resolved) === false)
    return false;
  const relative = relativeInside(path, outer, inner);
  const folder = inner.file === true ? relative.split("/").slice(0, -1).join("/") : relative;
  return (
    outer.patterns.prunedFolder(folder) !== undefined ||
    (inner.file === true && outer.patterns.excluded(relative) === true)
  );
};

/** The owners that share a file with `owner`. */
const overlapsOf = (path: Path.Path, owners: ReadonlyArray<Owner>, owner: Owner) =>
  owners.filter(
    (other) =>
      other !== owner &&
      ((isInside(owner.resolved, other.resolved) === true &&
        walkSkips(path, owner, other) === false) ||
        (isInside(other.resolved, owner.resolved) === true &&
          walkSkips(path, other, owner) === false)),
  );

/** Why `owner` is refused, naming the exclude that would end each overlap where one would. */
const overlapMessage = (path: Path.Path, owner: Owner, others: ReadonlyArray<Owner>) => {
  const fixes = others.flatMap((other) => {
    const [outer, inner] = isStrictlyInside(owner.resolved, other.resolved)
      ? [owner, other]
      : [other, owner];
    const exclude = excludeFor(path, outer, inner);
    return exclude === undefined ? [] : [`exclude: ["${exclude}"] to the ${outer.label}`];
  });
  return `The ${owner.label} overlaps the ${others.map((other) => other.label).join(", ")}. Each file may belong to one declaration, so none of them loads until the overlap is removed. ${fixes.length === 0 ? "Keep one of them." : `Add ${fixes.join(", add ")}, or keep one of them.`}`;
};

/**
 * Checks every resource entry of a declaration against the syntax, location and type rules, and
 * returns the ones that pass, with every path an entry owns: theirs and each readable profile
 * publication. Entries that fail are reported through `report`.
 */
const declaredOwners = Effect.fnUntraced(function* (
  root: string,
  declaration: SourceDeclaration,
  report: ReportDeclarationIssue,
  records: Array<DeclarationRecord>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const accepted: Array<Declared & { readonly owner: Owner }> = [];
  for (const { key, kind } of declarationKinds) {
    // A collection names no path, so it owns nothing the rule compares.
    const value: unknown = isCollection(declaration) ? undefined : declaration[key];
    if (value === undefined) continue;
    if (Array.isArray(value) === false) {
      const record = declarationRecord(kind, {});
      records.push(record);
      report(
        record,
        root,
        "declaration-entry-invalid",
        `${key} must be a list of declarations.`,
        kind,
      );
      continue;
    }
    for (const candidate of value as ReadonlyArray<unknown>) {
      const record = recordFor(kind, candidate);
      records.push(record);
      const declaredPath = entryPathOf(candidate);
      const target = declaredPath === undefined ? root : path.join(root, declaredPath);
      const pathLabel = `${key} entry${declaredPath === undefined ? "" : ` "${declaredPath}"`}`;
      const decoded = yield* decodeEntry(kind, candidate);
      if ("error" in decoded) {
        report(
          record,
          target,
          "declaration-entry-invalid",
          `The ${pathLabel} is invalid: ${decoded.error}`,
          kind,
        );
        continue;
      }
      // A script is named by its entry, so two scripts on one file read as two entries.
      const label = decoded.kind === "script" ? `${key} entry "${decoded.entry.name}"` : pathLabel;
      const entry = decoded.entry;
      const syntax = declaredPathSyntaxIssue(entry.path);
      if (syntax !== undefined) {
        report(record, target, "declaration-path-invalid", `The ${label}: ${syntax}`, kind);
        continue;
      }
      if (entry.path.split("/")[0] === importStagingFolderName) {
        report(
          record,
          target,
          "declaration-path-invalid",
          `The ${label} names the import staging folder ${importStagingFolderName}, where Tack stages an import while it writes. It is never a resource folder.`,
          kind,
        );
        continue;
      }
      const resolved = yield* resolveDeclaredPath(root, entry.path);
      if (resolved.ok === false) {
        report(record, target, resolved.code, `The ${label}: ${resolved.message}`, kind);
        continue;
      }
      const wrongType = (expected: string) =>
        report(
          record,
          target,
          "declaration-path-wrong-type",
          `The ${label} must name ${expected}.`,
          kind,
        );
      // A script is a named entry for one file; every other kind declares a folder or one file.
      if (decoded.kind === "script") {
        if (resolved.type !== "File" || resolved.resolved.endsWith(".ts") === false) {
          wrongType("a readable .ts file");
          continue;
        }
        accepted.push({
          kind: "script",
          label,
          record,
          resolved: resolved.resolved,
          declaredPath: decoded.entry.path,
          entry: decoded.entry,
          owner: {
            kind: "script",
            label,
            declaredPath: decoded.entry.path,
            resolved: resolved.resolved,
            file: true,
            patterns: undefined,
          },
        });
        continue;
      }
      const rules = folderKinds[decoded.kind];
      const misnamed = rules.misnamed(resolved.type, resolved.resolved);
      if (misnamed !== undefined) {
        wrongType(misnamed);
        continue;
      }
      if (resolved.resolved === path.join(root, declarationFileName)) {
        report(
          record,
          target,
          "declaration-path-invalid",
          `The ${label} names the source declaration, which is not a resource.`,
          kind,
        );
        continue;
      }
      const single =
        resolved.type === "File" ||
        (rules.skillFolders === true &&
          (yield* fs
            .exists(path.join(resolved.resolved, "SKILL.md"))
            .pipe(Effect.catch(() => Effect.succeed(false)))));
      if (
        single === true &&
        (decoded.entry.include !== undefined || decoded.entry.exclude !== undefined)
      ) {
        report(
          record,
          target,
          "declaration-entry-invalid",
          `The ${label} names one ${rules.one}, so include and exclude do not apply. Patterns need a declared folder.`,
          kind,
        );
        continue;
      }
      accepted.push({
        kind: decoded.kind,
        label,
        record,
        resolved: resolved.resolved,
        declaredPath: decoded.entry.path,
        entry: decoded.entry,
        single,
        owner: {
          kind: decoded.kind,
          label,
          declaredPath: decoded.entry.path,
          resolved: resolved.resolved,
          file: resolved.type === "File",
          patterns:
            single === true
              ? undefined
              : patternSelector(decoded.entry.include, decoded.entry.exclude),
        },
      });
    }
  }
  // A publication that fails its own rules is reported where the profile is read.
  const profiles = yield* Effect.forEach(
    profilePublications(root, declaration).publications,
    (publication) =>
      declaredPathSyntaxIssue(publication.path) !== undefined
        ? Effect.succeed([])
        : resolveDeclaredPath(root, publication.path).pipe(
            Effect.map((resolved): ReadonlyArray<Owner> =>
              resolved.ok === true && resolved.type === "File"
                ? [
                    {
                      kind: "profile",
                      label: `profiles entry "${publication.name}"`,
                      declaredPath: publication.path,
                      resolved: resolved.resolved,
                      file: true,
                      patterns: undefined,
                    },
                  ]
                : [],
            ),
          ),
  );
  return { accepted, owners: [...accepted.map(({ owner }) => owner), ...profiles.flat()] };
});

/**
 * Checks every declaration entry of a validated source and returns the ones that may be read:
 * syntax, location, type and overlap rules have passed. Two entries overlap when their paths are
 * equal or one holds the other, unless an exclude of the outer one prunes the inner path. Entries
 * that fail are reported through `report`, so catalog discovery and the import destination rules
 * share one definition.
 */
const acceptDeclarations = Effect.fnUntraced(function* (
  root: string,
  declaration: SourceDeclaration,
  report: ReportDeclarationIssue,
  records: Array<DeclarationRecord>,
) {
  const path = yield* Path.Path;
  const { accepted, owners } = yield* declaredOwners(root, declaration, report, records);
  return accepted.filter((declared) => {
    const others = overlapsOf(path, owners, declared.owner);
    if (others.length === 0) return true;
    report(
      declared.record,
      path.join(root, declared.declaredPath),
      "declaration-path-overlap",
      overlapMessage(path, declared.owner, others),
      declared.kind,
    );
    return false;
  });
});

/**
 * Why the profile published at `publicationPath` is refused because a skills, commands, context
 * or scripts entry also owns its file, or undefined when none does.
 */
export const profileOverlap = Effect.fnUntraced(function* (
  root: string,
  declaration: SourceDeclaration,
  publicationPath: string,
) {
  const path = yield* Path.Path;
  const { owners } = yield* declaredOwners(root, declaration, ignoreIssues, []);
  return owners
    .filter((owner) => owner.kind === "profile" && owner.declaredPath === publicationPath)
    .flatMap((owner) => {
      const others = overlapsOf(path, owners, owner);
      return others.length === 0 ? [] : [overlapMessage(path, owner, others)];
    })[0];
});

/**
 * Reads the top of a skills or commands collection: each folder there that holds `SKILL.md`, or
 * each `.md` file whose name is a command name. Dot and underscore names are never candidates,
 * and every other folder or file is ignored, so another source's folder is a boundary. A skill's
 * content is walked only to check that it stays inside the skill folder.
 */
const scanCollection = Effect.fnUntraced(function* (
  discovery: Discovery,
  kind: "skill" | "command",
  record: DeclarationRecord,
  report: ReportDeclarationIssue,
) {
  const fs = yield* FileSystem.FileSystem;
  const { path, source } = discovery;
  const root = source.canonicalPath;
  const label = `${resourceKinds[kind].declarationKey} collection`;
  const entries = yield* fs.readDirectory(root).pipe(
    Effect.catch((error) => {
      report(record, root, folderKinds[kind].unreadableFolder, error.message, kind);
      return Effect.succeed([] as ReadonlyArray<string>);
    }),
  );
  const names = [...entries]
    .filter((name) => name.startsWith(".") === false && name.startsWith("_") === false)
    .sort(compareCodeUnits);
  for (const name of names) {
    const target = path.join(root, name);
    if (kind === "command") {
      if (
        name.endsWith(".md") === false ||
        portableAddress(kind, source, name.slice(0, -3)) === undefined
      )
        continue;
      const file = yield* discovery.observe(record, target, root, kind);
      if (file !== undefined && file.info.type === "File")
        addFile(discovery, kind, {
          declared: { collection: true, record },
          boundary: root,
          filePath: file.canonical,
        });
      continue;
    }
    const holdsSkill = yield* fs.stat(path.join(target, "SKILL.md")).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
    if (holdsSkill === false) continue;
    const folder = yield* discovery.observe(record, target, root, kind);
    if (folder === undefined) continue;
    const skillFile = yield* discovery.observe(
      record,
      path.join(folder.canonical, "SKILL.md"),
      folder.canonical,
      kind,
      portableAddress(kind, source, path.basename(folder.canonical)),
    );
    if (skillFile === undefined) continue;
    addSkill(discovery, { collection: true, record }, folder.canonical, skillFile);
    yield* discovery.walk(
      {
        kind,
        label,
        record,
        resolved: folder.canonical,
        declaredPath: name,
        entry: { path: name },
        single: true,
      },
      true,
    );
  }
});

/**
 * Turns the resource declarations of a validated source into candidates and quarantines. Every
 * entry is checked on its own, so one bad entry quarantines only itself. A resource enters the
 * catalog only when a declaration covers it.
 */
export const discoverDeclaredResources = Effect.fnUntraced(function* (
  source: SourceRegistration,
  declaration: SourceDeclaration,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates: Array<ResourceCandidate> = [];
  const quarantined: Array<CatalogQuarantine> = [];
  const records: Array<DeclarationRecord> = [];
  const report = reporterFor(source, quarantined);

  const usable = yield* acceptDeclarations(source.canonicalPath, declaration, report, records);

  const observe = Effect.fnUntraced(function* (
    record: DeclarationRecord,
    target: string,
    boundary: string,
    kind: ResourceKind,
    address?: CatalogQuarantine["address"],
  ) {
    return yield* Effect.gen(function* () {
      const canonical = yield* fs.realPath(target);
      if (isInside(boundary, canonical) === false) {
        report(
          record,
          target,
          "resource-boundary-violation",
          "The path resolves outside its declared folder.",
          kind,
          address,
        );
        return undefined;
      }
      return { canonical, info: yield* fs.stat(canonical) };
    }).pipe(
      Effect.catch((error) => {
        report(record, target, "resource-unreadable", error.message, kind, address);
        return Effect.succeed(undefined);
      }),
    );
  });

  /** Walks one declared folder, or the content of one skill, within the declared path. */
  const walk = (declared: FolderDeclared, insideDeclaredSkill: boolean) => {
    const { kind, record, resolved: boundary } = declared;
    const rules = folderKinds[kind];
    const { excludes, prunes, selected } = patternSelector(
      declared.entry.include,
      declared.entry.exclude,
    );
    const visited = new Set<string>();

    const visitEntry = (
      directory: string,
      relativeDirectory: string,
      name: string,
      insideSkill: boolean,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const target = path.join(directory, name);
        const relative = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
        if (excludes.length > 0) {
          const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (info?.type === "Directory" && prunes(relative) === true) return;
        }
        const observed = yield* observe(record, target, boundary, kind);
        if (observed === undefined) return;
        if (observed.info.type === "Directory") {
          yield* visitDirectory(observed.canonical, relative, insideSkill);
          return;
        }
        if (
          insideSkill === true ||
          observed.info.type !== "File" ||
          visited.has(observed.canonical) === true
        )
          return;
        visited.add(observed.canonical);
        if (selected(relative) === false) return;
        addFile(discovery, kind, { declared, boundary, filePath: observed.canonical });
      });

    const visitDirectory = (
      directory: string,
      relativeDirectory: string,
      insideSkill: boolean,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (visited.has(directory) === true) return;
        visited.add(directory);
        const entries = yield* fs.readDirectory(directory).pipe(
          Effect.catch((error) => {
            report(record, directory, rules.unreadableFolder, error.message, kind);
            return Effect.succeed([] as ReadonlyArray<string>);
          }),
        );
        const names = [...entries].sort(compareCodeUnits);
        const holdsSkill =
          rules.skillFolders === true &&
          insideSkill === false &&
          names.includes("SKILL.md") === true;
        const skillFile = holdsSkill
          ? yield* observe(
              record,
              path.join(directory, "SKILL.md"),
              boundary,
              kind,
              portableAddress("skill", source, path.basename(directory)),
            )
          : undefined;
        if (skillFile !== undefined && skillFile.info.type === "File") {
          // A skill folder is a leaf: Tack looks inside only for paths that leave the folder.
          if (selected(relativeDirectory) === true) {
            addSkill(discovery, declared, directory, skillFile);
            for (const name of names)
              if (name !== "SKILL.md") yield* visitEntry(directory, relativeDirectory, name, true);
          }
          return;
        }
        if (insideSkill === false && directory !== boundary && marksSourceEdge(names) === true) {
          const nested = path.relative(source.canonicalPath, directory);
          report(
            record,
            directory,
            "declaration-reaches-source",
            `The ${declared.label} reaches ${nested}, which holds its own tack.yaml and is another source, so Tack skipped it. Add exclude: ["${relativeDirectory}/**"] to the entry, or delete ${nested}/tack.yaml to keep what it holds in this source.`,
            kind,
          );
          return;
        }
        for (const name of names)
          // The skill file was already observed and reported above.
          if (holdsSkill === false || name !== "SKILL.md")
            yield* visitEntry(directory, relativeDirectory, name, insideSkill);
      });

    return visitDirectory(boundary, "", insideDeclaredSkill);
  };

  const discovery: Discovery = { source, path, candidates, observe, walk };

  if (isCollection(declaration) && declaration.kind !== "docs") {
    const kind = declaration.kind === "skills" ? "skill" : "command";
    const record = declarationRecord(kind, { collection: true });
    records.push(record);
    yield* scanCollection(discovery, kind, record, report);
  }

  for (const declared of usable) {
    if (declared.kind === "script") {
      candidates.push({
        source,
        kind: "script",
        address: {
          kind: "script",
          sourceRegistrationId: source.id,
          name: declared.entry.name,
        },
        filePath: declared.resolved,
        declaredPath: declared.declaredPath,
        record: declared.record,
        description: declared.entry.description,
      });
      continue;
    }
    yield* declared.single === true
      ? folderKinds[declared.kind].discoverOne(declared, discovery)
      : walk(declared, false);
  }
  return { candidates, quarantined, records };
});

/**
 * A declared skills folder that catalog discovery reads: a folder entry that passed every rule, or
 * the source folder of a skills collection.
 */
export type DeclaredSkillsFolder = {
  /** The path as the declaration spells it, relative to the source root; empty for a collection. */
  readonly declaredPath: string;
  /** The canonical absolute path of the folder. */
  readonly resolved: string;
  readonly include: ReadonlyArray<string> | undefined;
  readonly exclude: ReadonlyArray<string> | undefined;
};

/**
 * The declared skills folders of a validated source. A `skills` entry that names one skill is not
 * a folder, and an entry that fails the declaration rules is not declared. A skills collection
 * holds skills at its top, so its one folder is the source, with the empty declared path; other
 * collections declare none. Nothing is reported.
 */
export const declaredSkillsFolders = Effect.fnUntraced(function* (
  source: SourceRegistration,
  declaration: SourceDeclaration,
) {
  if (isCollection(declaration))
    return declaration.kind === "skills"
      ? [
          {
            declaredPath: "",
            resolved: source.canonicalPath,
            include: undefined,
            exclude: undefined,
          } satisfies DeclaredSkillsFolder,
        ]
      : [];
  const usable = yield* acceptDeclarations(source.canonicalPath, declaration, ignoreIssues, []);
  return usable.flatMap((declared): ReadonlyArray<DeclaredSkillsFolder> =>
    declared.kind === "skill" && declared.single === false
      ? [
          {
            declaredPath: declared.declaredPath,
            resolved: declared.resolved,
            include: declared.entry.include,
            exclude: declared.entry.exclude,
          },
        ]
      : [],
  );
});

/**
 * How a validated source's declarations would reach a `tack.yaml` written at `folder`, or
 * undefined when none would. `holds` names an entry whose declared path is or lies inside
 * `folder`; `walks` names a skills, commands or context folder whose walk would enter `folder`,
 * with the path relative to that folder that an exclude must name. A docs folder reaches nothing:
 * its walk passes over another source without a finding.
 */
export const declarationReaching = Effect.fnUntraced(function* (
  source: SourceRegistration,
  declaration: SourceDeclaration,
  folder: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A collection reads only its top, and a folder there without SKILL.md is never read.
  if (isCollection(declaration)) return undefined;
  const usable = yield* acceptDeclarations(source.canonicalPath, declaration, ignoreIssues, []);
  const docs = (yield* discoverDocs(source, declaration)).entries.map((entry) => ({
    label: `docs entry "${entry.declaredPath}"`,
    resolved: entry.directoryPath,
  }));
  const held = [...usable, ...docs].find((declared) => isInside(folder, declared.resolved));
  if (held !== undefined) return { holds: held.label };
  for (const declared of usable) {
    if (declared.kind === "script" || declared.single === true) continue;
    if (isStrictlyInside(declared.resolved, folder) === false) continue;
    const parts = path.relative(declared.resolved, folder).split(path.sep);
    const { prunes } = patternSelector(declared.entry.include, declared.entry.exclude);
    let reached = true;
    for (const [index] of parts.entries()) {
      const excluded = prunes(parts.slice(0, index + 1).join("/"));
      const listed = yield* fs
        .readDirectory(path.join(declared.resolved, ...parts.slice(0, index + 1)))
        .pipe(Effect.option);
      // The walk never enters an excluded folder, one it cannot list, a skill folder's content
      // or another source's folder.
      reached =
        excluded === false &&
        Option.isSome(listed) &&
        listed.value.includes("SKILL.md") === false &&
        marksSourceEdge(listed.value) === false;
      if (reached === false) break;
    }
    if (reached === true) return { walks: declared.label, exclude: parts.join("/") };
  }
  return undefined;
});
