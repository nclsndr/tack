import { bundleFactsDigest } from "../../domain/bundles/bundle-codec.ts";
import { Crypto, Effect, FileSystem, Path } from "effect";
import type { BundleManifest } from "../../domain/bundles/bundle-schema.ts";
import type { ArchiveEntry } from "../../domain/bundles/tar.ts";
import {
  bundleSourceLabel,
  bundleRegistrationsFor,
} from "../../domain/bundles/bundle-registration.ts";
import { BundleError } from "../../domain/bundles/bundle-error.ts";
import type { State } from "../../domain/state/state-schema.ts";
import { bundleIntegrityIssue } from "../sources/bundle-integrity.ts";
import { resolveStateDirectory, type StateOptions } from "../../services/state-store.ts";

/** Validates recipient identity and path occupancy without retaining or registering incoming bytes. */
export const planBundleRetention = Effect.fnUntraced(function* (
  state: State,
  options: StateOptions,
  manifest: BundleManifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const stateRoot = yield* fs.realPath(yield* resolveStateDirectory(options));
  const directory = path.join(stateRoot, "bundles", manifest.identity);
  const prior = state.data.sources.filter(
    (source) => source.bundle?.identity === manifest.identity,
  );
  const occupied = yield* fs.exists(directory);
  const fail = (message: string) =>
    Effect.fail(new BundleError({ code: "profile-bundle-identity", message }));
  let ancestor = directory;
  while ((yield* fs.exists(ancestor)) === false) ancestor = path.dirname(ancestor);
  if ((yield* fs.realPath(ancestor)) !== ancestor)
    return yield* fail(
      `Unsafe retained payload parent ${ancestor}. Repair it or choose a different dedicated context; force cannot bypass identity checks.`,
    );
  if (occupied === true && prior.length === 0)
    return yield* fail(
      `Foreign occupied payload destination ${directory}. Repair it or use a different dedicated context; matching bytes do not authorize takeover.`,
    );
  if (
    prior.length > 0 &&
    (prior.length !== manifest.sources.length ||
      new Set(prior.map((source) => source.bundle?.sourceKey)).size !== prior.length)
  )
    return yield* fail(
      `Bundle ${manifest.identity} has duplicate/missing source mappings. Repair its retained registrations.`,
    );
  if (prior.length > 0) {
    const rootEntries = (yield* fs.readDirectory(directory)).sort();
    const keys = (yield* fs.readDirectory(path.join(directory, "sources"))).sort();
    if (
      JSON.stringify(rootEntries) !== JSON.stringify(["manifest.json", "sources"]) ||
      JSON.stringify(keys) !== JSON.stringify(manifest.sources.map((source) => source.key).sort())
    )
      return yield* fail(
        `Foreign/changed retained payload inventory at ${directory}. Repair it before reuse.`,
      );
  }
  const ids = new Map<string, string>();
  for (const source of manifest.sources) {
    const existing = prior.find((candidate) => candidate.bundle?.sourceKey === source.key);
    ids.set(source.key, existing?.id ?? (yield* crypto.randomUUIDv4));
  }
  const registrations = bundleRegistrationsFor(manifest, ids, (key) =>
    path.join(directory, "sources", key),
  );
  for (const registration of registrations) {
    const previous = prior.find((candidate) => candidate.id === registration.id);
    if (previous !== undefined && bundleFactsDigest(previous) !== bundleFactsDigest(registration))
      return yield* fail(
        `Changed retained mapping for ${registration.bundle?.sourceKey} at ${previous.canonicalPath}; force cannot rebind it.`,
      );
    const conflicting = state.data.sources.find(
      (candidate) =>
        candidate.id !== registration.id && candidate.canonicalPath === registration.canonicalPath,
    );
    if (conflicting !== undefined)
      return yield* fail(
        `Payload source ${registration.bundle?.sourceKey} is occupied by unrelated registration ${conflicting.id}.`,
      );
  }
  for (const registration of prior) {
    const issue = yield* bundleIntegrityIssue(registration, state.data.sources);
    if (issue !== undefined) return yield* fail(issue);
  }
  const owner = registrations.find(
    (source) => source.bundle?.sourceKey === manifest.profile.sourceKey,
  );
  if (owner?.bundle === undefined)
    return yield* fail("The defining source projection has no local mapping.");
  return {
    directory,
    registrations,
    reuse: prior.length > 0,
    reference: `${bundleSourceLabel(owner.bundle)}:${manifest.profile.name}`,
  };
});

/** Writes validated regular payloads into a fresh directory; never runs an archive-supplied helper. */
export const writeBundlePayload = Effect.fnUntraced(function* (
  directory: string,
  entries: ReadonlyArray<ArchiveEntry>,
  manifest?: BundleManifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(directory);
  for (const entry of entries) {
    const absolute = path.join(directory, entry.path);
    yield* fs.makeDirectory(path.dirname(absolute), { recursive: true });
    if (entry.kind === "directory") yield* fs.makeDirectory(absolute, { recursive: true });
    else {
      yield* fs.writeFile(absolute, entry.bytes, { flag: "wx", mode: entry.mode });
      yield* fs.chmod(absolute, entry.mode);
    }
  }
  if (manifest !== undefined)
    yield* fs.writeFileString(
      path.join(directory, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o644 },
    );
  for (const entry of [...entries].reverse())
    if (entry.kind === "directory") yield* fs.chmod(path.join(directory, entry.path), entry.mode);
});
