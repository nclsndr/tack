import { Effect, Path } from "effect";
import { resourceKinds } from "../../domain/resources/kinds.ts";
import type { SourceCheckReport, SourceFinding } from "../../domain/sources/source-check.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { resolveCatalogFromInspections } from "./catalog.ts";
import { isCollection, type SourceDeclaration } from "../../domain/sources/source-schema.ts";
import { Source } from "./source.ts";
import { checkProfilePublications } from "./profile-files.ts";
import { declarationFileName } from "./declaration-file.ts";
import { nonSkillCollectionFolders, nonSkillFolderMessage } from "./collection-folders.ts";

/** Inspects a directory through catalog discovery without registration, state or network. */
export const checkSource = Effect.fn("sources.checkSource")(function* (sourcePath: string) {
  const sourceService = yield* Source;
  const path = yield* Path.Path;
  const source = yield* sourceService.validate(sourcePath).pipe(
    Effect.map((value) => ({ value })),
    Effect.catch((error) => Effect.succeed({ error })),
  );
  const counts = { skill: 0, command: 0, context: 0, script: 0, docs: 0 };
  if ("error" in source) {
    const error = source.error;
    const root = "sourcePath" in error ? error.sourcePath : path.resolve(sourcePath);
    const file = "path" in error ? error.path : path.join(root, declarationFileName);
    return {
      kind: "source-check",
      sourcePath: path.resolve(sourcePath),
      counts,
      findings: [{ message: error.message, code: error.code, severity: "error", file }],
    } satisfies SourceCheckReport;
  }
  const value = source.value;
  const entries = yield* inspectDeclaration(value.canonicalPath, value.declaration);
  return {
    kind: "source-check",
    sourcePath: value.canonicalPath,
    counts: entries.reduce(
      (total, entry) => ({ ...total, [entry.kind]: total[entry.kind] + entry.resources.length }),
      counts,
    ),
    findings: [
      ...(yield* checkProfilePublications(value.canonicalPath, value.declaration)),
      ...(("warnings" in value ? value.warnings : undefined) ?? []).map(
        (warning): SourceFinding => ({
          ...warning,
          severity: "warning",
          file: path.join(value.canonicalPath, declarationFileName),
        }),
      ),
      ...entries.flatMap((entry) => entry.findings),
    ],
  } satisfies SourceCheckReport;
});

/**
 * What each entry of a declaration finds through catalog discovery, in file order: the names of
 * the resources it puts in the catalog, and its problems as findings that name the entry's field.
 * A check and a declaration that `source add` proposes report entries the same way through it.
 */
export const inspectDeclaration = Effect.fnUntraced(function* (
  canonicalPath: string,
  declaration: SourceDeclaration,
) {
  const path = yield* Path.Path;
  const registration = { id: "00000000-0000-4000-8000-000000000000", canonicalPath };
  const catalog = yield* resolveCatalogFromInspections([
    { status: "healthy", registration, declaration },
  ]);
  const declarationFile = path.join(canonicalPath, declarationFileName);
  const rows = catalog.declarations?.[registration.id] ?? [];
  const nonSkills =
    isCollection(declaration) && declaration.kind === "skills"
      ? yield* nonSkillCollectionFolders(canonicalPath)
      : [];
  // Each folder of a skills collection that is not a skill warns on its one entry; none fails it.
  const nonSkillWarnings = nonSkills.map((folder): SourceFinding => ({
    code: "collection-folder-not-skill",
    message: nonSkillFolderMessage(folder),
    severity: "warning",
    field: "kind",
    file: declarationFile,
    candidatePath: path.join(canonicalPath, folder),
  }));
  return rows.map((row, position) => {
    const key = resourceKinds[row.kind].declarationKey;
    const index = rows.slice(0, position).filter(({ kind }) => kind === row.kind).length;
    // A collection's one declaration is its kind; the list form names each entry of a key.
    const field = isCollection(declaration)
      ? "kind"
      : Array.isArray(declaration[key])
        ? `${key}[${index}]`
        : key;
    return {
      kind: row.kind,
      ...(row.path === undefined ? {} : { path: row.path }),
      ...(row.collection === true ? { collection: true as const } : {}),
      ...(row.name === undefined ? {} : { name: row.name }),
      resources: catalog.entries
        .filter(
          (entry) =>
            entry.address.kind === row.kind &&
            entry.declaredPath === row.path &&
            (row.name === undefined || entry.address.name === row.name),
        )
        .map((entry) => entry.address.name)
        .sort(compareCodeUnits),
      findings: [
        ...row.problems.map((problem): SourceFinding => ({
          code: problem.code,
          message: problem.message,
          severity: "error",
          field,
          file:
            problem.code.startsWith("declaration-") || row.kind === "docs"
              ? declarationFile
              : (problem.candidatePath ?? declarationFile),
          ...(problem.candidatePath === undefined ? {} : { candidatePath: problem.candidatePath }),
        })),
        ...(row.collection === true ? nonSkillWarnings : []),
      ],
    };
  });
});
