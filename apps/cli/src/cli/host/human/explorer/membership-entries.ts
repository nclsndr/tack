import { builtinProfileSourceIds } from "../../../../domain/profiles/profile-policy.ts";
import {
  resourceAddressIdentity,
  type Catalog,
  type ResourceAddress,
} from "../../../../domain/sources/catalog-schema.ts";
import type { ExplorerEntry } from "./model.ts";

type TaggedMember = { readonly address: ResourceAddress; readonly tags: ReadonlyArray<string> };

/** Projects positive inventory edits while preserving release-owned locks in every authoring mode. */
export const membershipEntries = (
  entries: ReadonlyArray<ExplorerEntry>,
  catalog: Catalog,
  direct: ReadonlyArray<TaggedMember>,
): ReadonlyArray<ExplorerEntry> => {
  const builtinSources = builtinProfileSourceIds(catalog);
  const directTags = new Map(
    direct.map((member) => [resourceAddressIdentity(member.address), member.tags]),
  );
  return entries.map((entry) => {
    if (entry.address === undefined) return entry;
    if (builtinSources.has(entry.address.sourceRegistrationId) === true)
      return { ...entry, editable: { kind: "builtin" as const } };
    const key = resourceAddressIdentity(entry.address);
    return {
      ...entry,
      tags: [...entry.tags, ...(directTags.get(key) ?? [])],
      editable: { kind: "member" as const, address: entry.address, included: directTags.has(key) },
    };
  });
};
