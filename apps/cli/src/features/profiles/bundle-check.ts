import { Crypto, Effect } from "effect";
import { emptyState } from "../../domain/state/state-schema.ts";
import { bundleRegistrationsFor } from "../../domain/bundles/bundle-registration.ts";
import { inspectBundleProjection } from "./bundle-snapshot.ts";
import type { BundleManifest } from "../../domain/bundles/bundle-schema.ts";
import type { ArchiveEntry } from "../../domain/bundles/tar.ts";
import { readBundleArchive } from "./bundle-read.ts";

/** Verifies the projected manifest's actual meaning in scratch space, with no recipient authority. */
export const checkBundleProjection = Effect.fnUntraced(function* (archive: {
  readonly manifest: BundleManifest;
  readonly entries: ReadonlyArray<ArchiveEntry>;
}) {
  const crypto = yield* Crypto.Crypto;
  const ids = new Map<string, string>();
  for (const source of archive.manifest.sources) ids.set(source.key, yield* crypto.randomUUIDv4);
  const registrations = bundleRegistrationsFor(
    archive.manifest,
    ids,
    (key) => `/bundle-inspection/${key}`,
  );
  yield* inspectBundleProjection(emptyState(), registrations, archive.manifest, archive.entries);
});

/** Checks bytes and complete resource/profile linkage offline without original sources or state. */
export const inspectBundle = (file: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const archive = yield* readBundleArchive(file);
      yield* checkBundleProjection(archive);
      return archive;
    }),
  );
