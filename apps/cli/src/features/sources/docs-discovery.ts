import { Effect, FileSystem, Path, Schema } from "effect";
import {
  DocsAddressSchema,
  type DocsCatalogEntry,
  type CatalogQuarantine,
} from "../../domain/sources/catalog-schema.ts";
import {
  declarationRecord,
  type DeclarationRecord,
} from "../../domain/sources/declaration-facts.ts";
import { catalogQuarantine } from "./discovery-support.ts";
import { declaredPathSyntaxIssue, resolveDeclaredPath } from "./declared-path.ts";
import {
  type SourceDeclaration,
  type SourceRegistration,
} from "../../domain/sources/source-schema.ts";
import { declarationFileName } from "./declaration-file.ts";

/** One docs entry of a declaration: a name, a source-relative folder and optional reader settings. */
export const docsEntrySchema = Schema.Struct({
  name: DocsAddressSchema.fields.name,
  path: Schema.String,
  reader: Schema.optionalKey(Schema.Unknown),
});

/** Why one docs entry is refused: by its own rules, or because it overlaps another entry. */
type DocsEntryProblem = {
  readonly code: CatalogQuarantine["code"];
  readonly message: string;
  /** Where the problem lies: the declared folder, or the source when the entry does not decode. */
  readonly directory: string | undefined;
  /** The entry's name, when it decodes far enough to have one. */
  readonly name: string | undefined;
};

/** A docs entry that passes its own rules: its decoded fields and the folder it resolves to. */
export type DocsFolder = {
  readonly item: typeof docsEntrySchema.Type;
  readonly resolved: string;
};

/** Checks one docs entry against the schema, syntax, location and type rules. */
const checkDocsEntry = Effect.fnUntraced(function* (root: string, candidate: unknown) {
  const path = yield* Path.Path;
  const decoded = yield* Schema.decodeUnknownEffect(docsEntrySchema, {
    onExcessProperty: "error",
  })(candidate).pipe(
    Effect.map((value) => ({ value })),
    Effect.catch((error) => Effect.succeed({ error })),
  );
  if ("error" in decoded) {
    const identity = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        name: DocsAddressSchema.fields.name,
      }),
    )(candidate).pipe(Effect.catch(() => Effect.succeed(undefined)));
    return {
      code: "declaration-invalid",
      message: decoded.error.message,
      directory: undefined,
      name: identity?.name,
    } satisfies DocsEntryProblem;
  }
  const item = decoded.value;
  const directory = path.join(root, item.path);
  const problem = (code: CatalogQuarantine["code"], message: string): DocsEntryProblem => ({
    code,
    message,
    directory,
    name: item.name,
  });
  const syntax = declaredPathSyntaxIssue(item.path);
  if (syntax !== undefined) return problem("declaration-path-invalid", syntax);
  const resolved = yield* resolveDeclaredPath(root, item.path);
  if (resolved.ok === false) return problem(resolved.code, resolved.message);
  if (resolved.type !== "Directory")
    return problem("declaration-path-wrong-type", "The docs target must be a directory.");
  return { item, resolved: resolved.resolved } satisfies DocsFolder;
});

/** The docs entries of a declaration as a list, or undefined when `docs` is not one. */
const docsCandidates = (declaration: SourceDeclaration) =>
  Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown))(declaration.docs).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );

/** One docs entry as the declaration writes it, with the outcome of its own rules. */
type DocsCheck = {
  readonly candidate: unknown;
  readonly checked: DocsFolder | DocsEntryProblem;
};

/**
 * The docs entries of a declaration, each checked against its own rules: undefined when the
 * declaration has no `docs` key, and `not-a-list` when its value is not a list.
 */
export type DocsChecks = ReadonlyArray<DocsCheck> | "not-a-list" | undefined;

/**
 * Checks each docs entry of a declaration against its own rules, so one read of a source resolves
 * each docs folder once, for both the overlap rule and docs discovery.
 */
export const checkDocs = Effect.fnUntraced(function* (
  root: string,
  declaration: SourceDeclaration,
): Effect.fn.Return<DocsChecks, never, FileSystem.FileSystem | Path.Path> {
  if (declaration.docs === undefined) return undefined;
  const candidates = yield* docsCandidates(declaration);
  if (candidates === undefined) return "not-a-list";
  return yield* Effect.forEach(candidates, (candidate) =>
    checkDocsEntry(root, candidate).pipe(Effect.map((checked) => ({ candidate, checked }))),
  );
});

/** The docs folders that pass their own rules, in declaration order. */
export const docsFolders = (checks: DocsChecks): ReadonlyArray<DocsFolder> =>
  checks === undefined || checks === "not-a-list"
    ? []
    : checks.flatMap(({ checked }) => ("resolved" in checked ? [checked] : []));

/**
 * Turns the checked docs entries of a healthy source into catalog entries and quarantines. A
 * folder that passes its own rules is still refused with the reason `overlap` gives, when it
 * shares files with another entry.
 *
 * @param checks - The docs entries as `checkDocs` checked them, so `tack.yaml` is parsed and each
 *   folder resolved once per catalog build.
 * @param overlap - Why a docs folder overlaps another entry, or undefined when it overlaps none.
 */
export const discoverDocs = Effect.fnUntraced(function* (
  source: SourceRegistration,
  checks: DocsChecks,
  overlap: (folder: DocsFolder) => string | undefined,
) {
  const path = yield* Path.Path;
  const declarationPath = path.join(source.canonicalPath, declarationFileName);
  const entries: DocsCatalogEntry[] = [];
  const quarantined: CatalogQuarantine[] = [];
  const records: DeclarationRecord[] = [];
  /** The declaration behind each entry, in the order of `entries`. */
  const owners: DeclarationRecord[] = [];
  /** Quarantines one problem and records it under the docs entry it concerns. */
  const quarantine = (record: DeclarationRecord, problem: CatalogQuarantine) => {
    quarantined.push(problem);
    record.problems.push({
      code: problem.code,
      message: problem.message,
      candidatePath: problem.directoryPath,
    });
  };
  /** Quarantines a docs entry that is refused, under its name when it has one. */
  const refuse = (record: DeclarationRecord, problem: DocsEntryProblem) =>
    quarantine(
      record,
      catalogQuarantine(
        source,
        problem.directory ?? source.canonicalPath,
        problem.code,
        problem.message,
        problem.name === undefined
          ? undefined
          : { kind: "docs", name: problem.name, sourceRegistrationId: source.id },
        undefined,
        "docs",
      ),
    );
  if (checks === undefined) return { entries, quarantined, records, owners };
  if (checks === "not-a-list") {
    const record = declarationRecord("docs", {});
    records.push(record);
    quarantine(
      record,
      catalogQuarantine(
        source,
        source.canonicalPath,
        "declaration-invalid",
        "docs must be a list of named folder declarations.",
        undefined,
        undefined,
        "docs",
      ),
    );
    return { entries, quarantined, records, owners };
  }
  for (const { candidate, checked } of checks) {
    const raw = (key: string): unknown =>
      typeof candidate === "object" && candidate !== null ? Reflect.get(candidate, key) : undefined;
    const rawPath = raw("path");
    const rawName = raw("name");
    const record = declarationRecord("docs", {
      ...(typeof rawPath === "string" ? { path: rawPath } : {}),
      ...(typeof rawName === "string" ? { name: rawName } : {}),
    });
    records.push(record);
    if ("resolved" in checked === false) {
      refuse(record, checked);
      continue;
    }
    const overlapping = overlap(checked);
    if (overlapping !== undefined) {
      refuse(record, {
        code: "declaration-path-overlap",
        message: overlapping,
        directory: path.join(source.canonicalPath, checked.item.path),
        name: checked.item.name,
      });
      continue;
    }
    // Reader settings are re-read and checked by the loader to isolate errors and reload edits.
    entries.push({
      address: { kind: "docs", sourceRegistrationId: source.id, name: checked.item.name },
      declaredPath: checked.item.path,
      directoryPath: checked.resolved,
      sourcePath: source.canonicalPath,
      sourceRegistrationId: source.id,
      readerConfig: { kind: "source", path: declarationPath },
    });
    owners.push(record);
  }
  return { entries, quarantined, records, owners };
});
