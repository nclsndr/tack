import { Effect, Path, Schema } from "effect";
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
  isCollection,
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

/**
 * Resolves each docs folder that a healthy source declares, independently from other resources.
 *
 * @param declaration - The declaration the source was validated with, so `tack.yaml` is parsed
 *   once per catalog build.
 */
export const discoverDocs = Effect.fnUntraced(function* (
  source: SourceRegistration,
  declaration: SourceDeclaration,
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
  if (isCollection(declaration)) {
    if (declaration.kind !== "docs") return { entries, quarantined, records, owners };
    // A docs collection is its whole folder, named by the declaration's required name.
    const record = declarationRecord("docs", { name: declaration.name, collection: true });
    records.push(record);
    owners.push(record);
    entries.push({
      address: { kind: "docs", sourceRegistrationId: source.id, name: declaration.name },
      collection: true,
      directoryPath: source.canonicalPath,
      sourcePath: source.canonicalPath,
      sourceRegistrationId: source.id,
      readerConfig: { kind: "source", path: declarationPath },
    });
    return { entries, quarantined, records, owners };
  }
  if (declaration.docs === undefined) return { entries, quarantined, records, owners };
  const candidates = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown))(
    declaration.docs,
  ).pipe(
    Effect.catch(() => {
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
      return Effect.succeed([]);
    }),
  );
  for (const candidate of candidates) {
    const raw = (key: string): unknown =>
      typeof candidate === "object" && candidate !== null ? Reflect.get(candidate, key) : undefined;
    const rawPath = raw("path");
    const rawName = raw("name");
    const record = declarationRecord("docs", {
      ...(typeof rawPath === "string" ? { path: rawPath } : {}),
      ...(typeof rawName === "string" ? { name: rawName } : {}),
    });
    records.push(record);
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
      quarantine(
        record,
        catalogQuarantine(
          source,
          source.canonicalPath,
          "declaration-invalid",
          decoded.error.message,
          identity === undefined
            ? undefined
            : { kind: "docs", name: identity.name, sourceRegistrationId: source.id },
          undefined,
          "docs",
        ),
      );
      continue;
    }
    const item = decoded.value;
    const address = { kind: "docs" as const, sourceRegistrationId: source.id, name: item.name };
    const directory = path.join(source.canonicalPath, item.path);
    const syntax = declaredPathSyntaxIssue(item.path);
    if (syntax !== undefined) {
      quarantine(
        record,
        catalogQuarantine(source, directory, "declaration-path-invalid", syntax, address),
      );
      continue;
    }
    const resolved = yield* resolveDeclaredPath(source.canonicalPath, item.path);
    if (resolved.ok === false) {
      quarantine(
        record,
        catalogQuarantine(source, directory, resolved.code, resolved.message, address),
      );
      continue;
    }
    if (resolved.type !== "Directory") {
      quarantine(
        record,
        catalogQuarantine(
          source,
          directory,
          "declaration-path-wrong-type",
          "The docs target must be a directory.",
          address,
        ),
      );
      continue;
    }
    // Reader settings are re-read and checked by the loader to isolate errors and reload edits.
    entries.push({
      address,
      declaredPath: item.path,
      directoryPath: resolved.resolved,
      sourcePath: source.canonicalPath,
      sourceRegistrationId: source.id,
      readerConfig: { kind: "source", path: declarationPath },
    });
    owners.push(record);
  }
  return { entries, quarantined, records, owners };
});
