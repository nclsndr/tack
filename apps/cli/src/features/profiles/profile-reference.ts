import { Effect } from "effect";
import { resolveProfile } from "../../domain/profiles/profile-resolution.ts";
import { readProfileFile } from "../sources/profile-files.ts";
import { profilePublications } from "../sources/profile-publications.ts";
import type { CommandSnapshot } from "../snapshot/command-snapshot.ts";

/** Reads one published profile through registered source identity, without fetching or executing. */
export const readRegisteredProfile = Effect.fnUntraced(function* (
  snapshot: CommandSnapshot,
  reference: string,
) {
  const sources = yield* snapshot.sourceInspections;
  const [sourceName, profileName, extra] = reference.split(":");
  const matches = sources.filter(
    (source) => source.label === sourceName && source.status === "healthy",
  );
  const owner = matches.length === 1 ? matches[0] : undefined;
  if (owner?.status !== "healthy" || profileName === undefined || extra !== undefined)
    return {
      resolved: undefined,
      findings: [
        {
          code: "profile-source-linkage",
          message:
            "Use an unambiguous registered SOURCE:PROFILE. Register missing sources or give clashing sources distinct portable names; this operation never fetches them.",
        },
      ],
    };
  const published = profilePublications(owner.registration.canonicalPath, owner.declaration);
  const publication = published.publications.find((entry) => entry.name === profileName);
  if (publication === undefined)
    return {
      resolved: undefined,
      findings: [
        ...published.findings,
        {
          code: "profile-unpublished",
          message: `${reference} is not published. Repair its version-2 source declaration.`,
        },
      ],
    };
  const loaded = yield* readProfileFile(
    owner.registration.canonicalPath,
    owner.declaration,
    publication,
  );
  if (loaded.profile === undefined || published.findings.length > 0)
    return { resolved: undefined, findings: [...published.findings, ...loaded.findings] };
  const catalog = yield* snapshot.catalog;
  const inventory = resolveProfile(loaded.profile, owner.registration.id, catalog, loaded.file);
  return {
    resolved: { owner, profile: loaded.profile, file: loaded.file, inventory, catalog },
    findings: inventory.findings.filter((finding) => finding.severity === "error"),
  };
});

/** A profile whose publication, source mapping and fixed inventory were observed together. */
export type RegisteredProfile = NonNullable<
  Effect.Success<ReturnType<typeof readRegisteredProfile>>["resolved"]
>;
