import { Effect, FileSystem, Path } from "effect";
import { BundleScanner } from "../../services/bundle-scanner.ts";
import { BundleError } from "../../domain/bundles/bundle-error.ts";
import { bundleSourceLabel } from "../../domain/bundles/bundle-registration.ts";
import type { BundleManifest } from "../../domain/bundles/bundle-schema.ts";
import type { ArchiveEntry } from "../../domain/bundles/tar.ts";
import type { SourceRegistration } from "../../domain/sources/source-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";
import { entryRootPath, type Catalog } from "../../domain/sources/catalog-schema.ts";
import { makeCommandSnapshot, type CommandSnapshot } from "../snapshot/command-snapshot.ts";
import { readRegisteredProfile } from "./profile-reference.ts";
import { writeBundlePayload } from "./bundle-retention.ts";

/** Adds only validated artifact projections, preserving every unrelated source registration. */
export const withBundleSources = (
  state: State,
  registrations: ReadonlyArray<SourceRegistration>,
): State => ({
  ...state,
  data: {
    ...state.data,
    sources: [
      ...state.data.sources.filter((source) =>
        registrations.every((incoming) => incoming.id !== source.id),
      ),
      ...registrations,
    ],
  },
});

/** Checks projection semantics in private scratch space, then plans links against retained paths. */
export const inspectBundleProjection = Effect.fnUntraced(function* (
  state: State,
  registrations: ReadonlyArray<SourceRegistration>,
  manifest: BundleManifest,
  entries: ReadonlyArray<ArchiveEntry>,
) {
  const { inspectBundleSupport } = yield* Effect.promise(() => import("./bundle-support.ts"));
  const scanner = yield* BundleScanner;
  for (const source of manifest.sources) {
    const findings = inspectBundleSupport(
      scanner,
      entries.filter((entry) => entry.path.startsWith(`sources/${source.key}/`) === true),
      source.prerequisites,
    );
    const first = findings[0];
    if (first !== undefined)
      return yield* new BundleError({ code: "profile-bundle-incomplete", message: first.message });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "tack-bundle-check-" }),
  );
  const directory = path.join(scratch, "payload");
  yield* writeBundlePayload(directory, entries, manifest);
  const temporary = registrations.map((source) => ({
    ...source,
    canonicalPath: path.join(directory, "sources", source.bundle?.sourceKey ?? ""),
  }));
  const snapshot = yield* makeCommandSnapshot(withBundleSources(state, temporary));
  const owner = registrations.find(
    (source) => source.bundle?.sourceKey === manifest.profile.sourceKey,
  );
  if (owner?.bundle === undefined)
    return yield* new BundleError({
      code: "profile-bundle-invalid",
      message: "Missing defining source mapping.",
    });
  const reference = `${bundleSourceLabel(owner.bundle)}:${manifest.profile.name}`;
  const loaded = yield* readRegisteredProfile(snapshot, reference);
  if (loaded.resolved === undefined || loaded.findings.length > 0)
    return yield* new BundleError({
      code: "profile-bundle-incomplete",
      message: `Projected profile is incomplete: ${loaded.findings.map((finding) => finding.message).join(" ")}`,
    });
  const observed = loaded.resolved;
  const catalog = yield* snapshot.catalog;
  const incomingIds = new Set(registrations.map((source) => source.id));
  if (catalog.quarantined.some((entry) => incomingIds.has(entry.sourceRegistrationId)))
    return yield* new BundleError({
      code: "profile-bundle-incomplete",
      message:
        "A projected source resource is quarantined. Repair its declaration/content before export.",
    });
  const published = new Set(
    manifest.sources.flatMap((source) =>
      source.resources.map((resource) => `${source.key}:${resource.kind}:${resource.name}`),
    ),
  );
  if (
    catalog.entries.some((entry) => {
      if (incomingIds.has(entry.sourceRegistrationId) === false) return false;
      const source = registrations.find(
        (registration) => registration.id === entry.sourceRegistrationId,
      );
      return (
        published.has(
          `${source?.bundle?.sourceKey}:${entry.address.kind}:${entry.address.name}`,
        ) === false
      );
    })
  )
    return yield* new BundleError({
      code: "profile-bundle-invalid",
      message:
        "A projection declares resources outside its exact inventory. Keep support files as support, with explicit declaration include patterns.",
    });
  const actual = [...observed.inventory.direct, ...observed.inventory.required];
  const expected = manifest.sources.flatMap((source) =>
    source.resources.map((resource) => ({ sourceKey: source.key, ...resource })),
  );
  if (
    actual.length !== expected.length ||
    expected.some((resource) => {
      const id = registrations.find(
        (source) => source.bundle?.sourceKey === resource.sourceKey,
      )?.id;
      const list = resource.direct ? observed.inventory.direct : observed.inventory.required;
      const entry = catalog.entries.find(
        (candidate) =>
          candidate.address.kind === resource.kind &&
          candidate.address.name === resource.name &&
          candidate.sourceRegistrationId === id,
      );
      const location =
        entry === undefined
          ? undefined
          : path.relative(entry.sourcePath, entryRootPath(entry)).split(path.sep).join("/");
      return (
        location !== resource.path ||
        list.every(
          (address) =>
            address.kind !== resource.kind ||
            address.name !== resource.name ||
            address.sourceRegistrationId !== id,
        )
      );
    })
  )
    return yield* new BundleError({
      code: "profile-bundle-invalid",
      message:
        "Readable direct/dependency inventory does not agree with the projected profile and resource bytes.",
    });
  const moved = (value: string) => {
    for (const temporarySource of temporary) {
      const destination = registrations.find(
        (source) => source.id === temporarySource.id,
      )?.canonicalPath;
      if (
        destination !== undefined &&
        (value === temporarySource.canonicalPath ||
          value.startsWith(temporarySource.canonicalPath + path.sep))
      )
        return destination + value.slice(temporarySource.canonicalPath.length);
    }
    return value;
  };
  const inspections = (yield* snapshot.sourceInspections).map((source) => ({
    ...source,
    registration:
      registrations.find((candidate) => candidate.id === source.registration.id) ??
      source.registration,
  }));
  const finalCatalog: Catalog = {
    ...catalog,
    sources: (catalog.sources ?? []).map((source) => ({
      ...source,
      registration:
        registrations.find((candidate) => candidate.id === source.registration.id) ??
        source.registration,
    })),
    entries: catalog.entries.map((entry) => ({
      ...entry,
      sourcePath: moved(entry.sourcePath),
      directoryPath: moved(entry.directoryPath),
      ...("filePath" in entry ? { filePath: moved(entry.filePath) } : {}),
      ...("skillFilePath" in entry ? { skillFilePath: moved(entry.skillFilePath) } : {}),
      ...("readerConfig" in entry
        ? { readerConfig: { ...entry.readerConfig, path: moved(entry.readerConfig.path) } }
        : {}),
    })),
  };
  const finalState = withBundleSources(state, registrations);
  const base = yield* makeCommandSnapshot(finalState);
  const finalSnapshot: CommandSnapshot = {
    ...base,
    sourceInspections: Effect.succeed(inspections),
    catalog: Effect.succeed(finalCatalog),
  };
  return {
    snapshot: finalSnapshot,
    verifiedProfile: {
      ...observed,
      owner: { ...observed.owner, registration: owner },
      file: moved(observed.file),
      catalog: finalCatalog,
    },
    reference,
  };
});
