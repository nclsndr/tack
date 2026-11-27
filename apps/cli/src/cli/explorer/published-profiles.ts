import { Effect } from "effect";
import { resolveProfile } from "../../domain/profiles/profile-resolution.ts";
import type { Catalog } from "../../domain/sources/catalog-schema.ts";
import type { CommandSnapshot } from "../../features/snapshot/command-snapshot.ts";
import { readProfileFile } from "../../features/sources/profile-files.ts";
import { profilePublications } from "../../features/sources/profile-publications.ts";
import type { PublishedProfile } from "./activity.ts";

/**
 * Every profile a healthy registered source publishes, resolved against the catalog. The same
 * sources offer their profiles in the destination chooser. A file that does not read as a profile
 * is left out: `tack check` reports it.
 */
export const publishedProfiles = Effect.fnUntraced(function* (
  snapshot: Pick<CommandSnapshot, "sourceInspections">,
  catalog: Catalog,
) {
  const sources = (yield* snapshot.sourceInspections).flatMap((source) =>
    source.status !== "healthy" ||
    source.origin === "builtin" ||
    source.registration.bundle !== undefined
      ? []
      : [source],
  );
  const profiles = yield* Effect.forEach(sources, (source) =>
    Effect.forEach(
      profilePublications(source.registration.canonicalPath, source.declaration).publications,
      (publication) =>
        readProfileFile(source.registration.canonicalPath, source.declaration, publication).pipe(
          Effect.map((loaded): ReadonlyArray<PublishedProfile> => {
            if (loaded.profile === undefined) return [];
            const inventory = resolveProfile(
              loaded.profile,
              source.registration.id,
              catalog,
              loaded.file,
            );
            return [
              {
                sourcePath: source.registration.canonicalPath,
                sourceRegistrationId: source.registration.id,
                name: publication.name,
                direct: inventory.direct,
                required: inventory.required,
              },
            ];
          }),
        ),
    ),
  );
  return profiles.flat(2);
});
