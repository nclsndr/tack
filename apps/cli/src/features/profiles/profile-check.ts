import type { Catalog } from "../../domain/sources/catalog-schema.ts";
import type { SourceDeclaration } from "../../domain/sources/source-schema.ts";
import type { DeclaredSourceInspection } from "../../domain/sources/source-inspection.ts";
import { makeCommandSnapshot, readInvocationSnapshot } from "../snapshot/command-snapshot.ts";
import { Effect, Path } from "effect";
import type { ProfileCheckReport, ProfileFinding } from "../../domain/profiles/profile-schema.ts";
import { resolveProfile } from "../../domain/profiles/profile-resolution.ts";
import { emptyState } from "../../domain/state/state-schema.ts";
import { type StateOptions } from "../../services/state-store.ts";
import { resolveSourceLabels, Source } from "../sources/source.ts";
import { resolveCatalog } from "../sources/catalog.ts";
import { readProfileFile } from "../sources/profile-files.ts";
import { profilePublications, profileStructureFinding } from "../sources/profile-publications.ts";

/** Reads recipient registrations, adding the authored source without registering it. */
export const profileContext = Effect.fnUntraced(function* (
  options: StateOptions,
  sourcePath: string,
) {
  const path = yield* Path.Path;
  const source = yield* (yield* Source).validate(sourcePath);
  const snapshot = yield* readInvocationSnapshot(options).pipe(
    Effect.catchTag("StateNotInitializedError", () => makeCommandSnapshot(emptyState())),
  );
  const registered = yield* snapshot.sourceInspections;
  const owner = registered.find(
    (entry) => entry.registration.canonicalPath === source.canonicalPath,
  );
  const registration = owner?.registration ?? {
    canonicalPath: source.canonicalPath,
    id: "00000000-0000-4000-8000-000000000000",
  };
  const inspections = resolveSourceLabels(
    [
      ...registered.filter((entry) => entry.registration.id !== registration.id),
      registration.bundle !== undefined && owner !== undefined
        ? owner
        : { status: "healthy", registration, declaration: source.declaration },
    ],
    (root) => path.basename(root),
  );
  return {
    source,
    registration,
    inspections,
    catalog: yield* resolveCatalog(inspections),
  };
});

/** Checks one publication against an already observed catalog, without reading operator state. */
export const checkProfileInContext = Effect.fnUntraced(function* (
  context: {
    readonly source: { readonly canonicalPath: string; readonly declaration: SourceDeclaration };
    readonly registration: { readonly id: string };
    readonly catalog: Catalog;
  },
  profileName: string,
): Effect.fn.Return<
  ProfileCheckReport,
  Effect.Error<ReturnType<typeof readProfileFile>>,
  Effect.Services<ReturnType<typeof readProfileFile>>
> {
  const sourcePath = context.source.canonicalPath;
  const published = profilePublications(sourcePath, context.source.declaration);
  const publication = published.publications.find((entry) => entry.name === profileName);
  const findings: ReadonlyArray<ProfileFinding> =
    publication === undefined
      ? [
          ...published.findings,
          profileStructureFinding(
            `${sourcePath}/tack.yaml`,
            "profile-unpublished",
            `Profile ${profileName} is not published by this source.`,
            "Use source version 2 and publish its name and file in profiles.",
            "profiles",
          ),
        ]
      : published.findings;
  const base = {
    kind: "profile-check" as const,
    sourcePath,
    profileName: profileName,
    direct: [],
    required: [],
  };
  if (publication === undefined)
    return { ...base, structural: "invalid", linkage: "unchecked", findings };
  const loaded = yield* readProfileFile(sourcePath, context.source.declaration, publication);
  if (loaded.profile === undefined || findings.length > 0)
    return {
      ...base,
      structural: "invalid",
      linkage: "unchecked",
      findings: [...findings, ...loaded.findings],
    };
  return {
    ...base,
    structural: "valid",
    ...resolveProfile(loaded.profile, context.registration.id, context.catalog, loaded.file),
  };
});

/** Observes all published definitions, including profiles that have never been applied. */
export const profileDefinitionFindings = Effect.fnUntraced(function* (
  sources: ReadonlyArray<DeclaredSourceInspection>,
  catalog: Catalog,
) {
  const reports = yield* Effect.forEach(sources, (source) =>
    Effect.gen(function* () {
      if (source.status !== "healthy" || source.origin === "builtin") return [];
      const published = profilePublications(source.registration.canonicalPath, source.declaration);
      const checked = yield* Effect.forEach(published.publications, (publication) =>
        checkProfileInContext(
          {
            source: {
              canonicalPath: source.registration.canonicalPath,
              declaration: source.declaration,
            },
            registration: source.registration,
            catalog,
          },
          publication.name,
        ),
      );
      return [...published.findings, ...checked.flatMap((report) => report.findings)];
    }),
  );
  return reports.flat();
});
