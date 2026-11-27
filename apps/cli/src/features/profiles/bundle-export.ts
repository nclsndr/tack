import { checkBundleProjection } from "./bundle-check.ts";
import { Compression } from "../../services/compression.ts";
export { inspectBundle } from "./bundle-check.ts";
import { Effect, FileSystem, Path, Schema } from "effect";
import {
  bundleDigest,
  encodeBundle,
  makeBundleManifest,
} from "../../domain/bundles/bundle-codec.ts";
import { BundleError } from "../../domain/bundles/bundle-error.ts";
import { type ArchiveEntry } from "../../domain/bundles/tar.ts";
import {
  BundleFileSchema,
  BundleManifestSchema,
  type BundleContent,
  type BundleManifest,
} from "../../domain/bundles/bundle-schema.ts";
import { resourceAddressIdentity } from "../../domain/sources/catalog-schema.ts";
import { readRegisteredProfile } from "./profile-reference.ts";
import { readInvocationSnapshot } from "../snapshot/command-snapshot.ts";
import { Result } from "effect";
import {
  ProfilePlanFindingSchema,
  type ProfilePlanFinding,
} from "../../domain/profiles/profile-schema.ts";
import { collectBundleSource } from "./bundle-source.ts";
import { bundleFileFailure } from "./bundle-file-failure.ts";
import type { StateOptions } from "../../services/state-store.ts";

const planExport = Effect.fnUntraced(function* (options: StateOptions, reference: string) {
  const path = yield* Path.Path;
  const snapshot = yield* readInvocationSnapshot(options);
  const loaded = yield* readRegisteredProfile(snapshot, reference);
  const findings: ProfilePlanFinding[] = [...loaded.findings];
  const empty = {
    manifest: undefined as BundleManifest | undefined,
    entries: [] as ReadonlyArray<ArchiveEntry>,
    findings,
  };
  if (loaded.resolved === undefined || findings.length > 0) return empty;
  const { owner, profile, inventory, catalog } = loaded.resolved;
  const addresses = [
    ...new Map(
      [...inventory.direct, ...inventory.required].map((address) => [
        resourceAddressIdentity(address),
        address,
      ]),
    ).values(),
  ];
  const sourceIds = new Set([
    owner.registration.id,
    ...addresses.map((address) => address.sourceRegistrationId),
  ]);
  for (const name of profile["depends-on"] ?? []) {
    const id =
      owner.registration.bundle?.bindings[name] ??
      catalog.sources?.find((source) => source.label === name)?.registration.id;
    if (id !== undefined) sourceIds.add(id);
  }
  const inspected = yield* snapshot.sourceInspections;
  const sources = inspected.filter(
    (source) =>
      source.status === "healthy" &&
      source.origin !== "builtin" &&
      sourceIds.has(source.registration.id),
  );
  const sourceKeys = new Map(
    [...sources]
      .sort((left, right) =>
        (left.label ?? "") < (right.label ?? "")
          ? -1
          : (left.label ?? "") > (right.label ?? "")
            ? 1
            : 0,
      )
      .map((source, index) => [source.registration.id, `source-${index}`]),
  );
  const entries = new Map<string, ArchiveEntry>();
  const projected: BundleContent["sources"][number][] = [];
  const budget = { bytes: 1024, entries: 0, exhausted: false };
  const direct = new Set(inventory.direct.map(resourceAddressIdentity));
  for (const source of sources) {
    if (source.status !== "healthy") continue;
    const key = sourceKeys.get(source.registration.id);
    if (key === undefined) continue;
    const selected = addresses.flatMap((address) =>
      address.sourceRegistrationId === source.registration.id
        ? catalog.entries.filter(
            (entry) => resourceAddressIdentity(entry.address) === resourceAddressIdentity(address),
          )
        : [],
    );
    const originalBindings =
      source.registration.bundle?.bindings ??
      Object.fromEntries(
        (catalog.sources ?? []).flatMap((candidate) =>
          candidate.label === undefined ? [] : [[candidate.label, candidate.registration.id]],
        ),
      );
    const bindings = Object.fromEntries(
      Object.entries(originalBindings).flatMap(([name, id]) => {
        const mapped = sourceKeys.get(id);
        return mapped === undefined ? [] : [[name, mapped]];
      }),
    );
    const content = yield* collectBundleSource({
      source,
      key,
      selected,
      direct,
      bindings,
      budget,
      ambientSources: new Set(
        (catalog.sources ?? [])
          .filter((candidate) => candidate.status === "healthy" && candidate.origin === "builtin")
          .flatMap((candidate) => (candidate.label === undefined ? [] : [candidate.label])),
      ),
      ...(source.registration.id === owner.registration.id
        ? { defining: { profile, file: loaded.resolved.file } }
        : {}),
    });
    projected.push(content.projection);
    findings.push(...content.findings);
    for (const entry of content.entries) entries.set(entry.path, entry);
  }

  const files = [...entries.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const ownerKey = sourceKeys.get(owner.registration.id);
  if (ownerKey === undefined) return empty;
  const content: BundleContent = {
    version: 1,
    profile: {
      sourceKey: ownerKey,
      name: profile.name,
      path: path
        .relative(owner.registration.canonicalPath, loaded.resolved.file)
        .split(path.sep)
        .join("/"),
    },
    sources: projected,
    files: files.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      size: entry.bytes.length,
      sha256: bundleDigest(entry.bytes),
    })),
  };
  return { manifest: makeBundleManifest(content), entries: files, findings };
});

/**
 * The `profile export` plan payload: the artifact path, the manifest once one could be built, its
 * exact files, and why the export refuses.
 */
export const BundleExportPlanSchema = Schema.Struct({
  kind: Schema.Literal("profile-export"),
  reference: Schema.String,
  output: Schema.String,
  manifest: Schema.optionalKey(BundleManifestSchema),
  files: Schema.Array(BundleFileSchema),
  findings: Schema.Array(ProfilePlanFindingSchema),
  refused: Schema.Boolean,
});

/** The `profile export` application payload: the bundle was written to `output`. */
export const BundleExportedSchema = Schema.Struct({
  exported: Schema.Literal(true),
  output: Schema.String,
});

/** Previews exact content and findings, then writes a new artifact only with explicit apply. */
export const runBundleExport = Effect.fn("profiles.runBundleExport")(
  function* (
    options: StateOptions,
    request: { readonly reference: string; readonly output: string; readonly apply: boolean },
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const content = yield* planExport(options, request.reference);
    const findings = [...content.findings];
    const output = path.resolve(request.output);
    if (yield* fs.exists(output))
      findings.push({
        code: "profile-bundle-identity",
        message: `${output} is occupied. Choose a new artifact path; export never overwrites existing content.`,
      });
    let archive: Uint8Array | undefined;
    const manifest = content.manifest;
    if (manifest !== undefined && findings.length === 0) {
      const codec = yield* Compression;
      const encoded = yield* Effect.gen(function* () {
        const bytes = yield* Effect.try({
          try: () => encodeBundle(codec, manifest, content.entries),
          catch: (error) =>
            error instanceof BundleError
              ? error
              : new BundleError({ code: "profile-bundle-invalid", message: String(error) }),
        });
        yield* checkBundleProjection({ manifest, entries: content.entries });
        return bytes;
      }).pipe(
        Effect.mapError((error) =>
          error instanceof BundleError
            ? error
            : new BundleError({ code: "profile-bundle-incomplete", message: error.message }),
        ),
        Effect.result,
      );
      if (Result.isSuccess(encoded)) archive = encoded.success;
      else findings.push({ code: encoded.failure.code, message: encoded.failure.message });
    }
    const plan: typeof BundleExportPlanSchema.Type = {
      kind: BundleExportPlanSchema.fields.kind.literal,
      reference: request.reference,
      output,
      ...(manifest === undefined ? {} : { manifest }),
      files: manifest?.files ?? [],
      findings,
      refused: findings.length > 0,
    };
    if (request.apply === false || archive === undefined || findings.length > 0)
      return { plan, exported: false };
    yield* fs.writeFile(output, archive, { flag: "wx" });
    return { plan, exported: true };
  },
  (effect, _options, request) =>
    effect.pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(bundleFileFailure(request.output)(error)),
      ),
    ),
);
