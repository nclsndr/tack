import { portableSourceName } from "./portable-source-name.ts";
import { profileControlledAddresses } from "./profile-policy.ts";
import type { Catalog, ResourceAddress } from "../sources/catalog-schema.ts";
import { resourceAddressIdentity } from "../sources/catalog-schema.ts";
import type { Profile, ProfileMember } from "./profile-schema.ts";

/** Converts exact local identities to portable source-qualified members, refusing identity guesses. */
export const portableProfile = (
  name: string,
  ownerId: string,
  addresses: ReadonlyArray<ResourceAddress>,
  catalog: Catalog,
) => {
  const findings: Array<{ readonly code: string; readonly message: string }> = [];
  const members: ProfileMember[] = [];
  const requirements = new Set<string>();
  for (const address of new Map(
    profileControlledAddresses(catalog, addresses).map((value) => [
      resourceAddressIdentity(value),
      value,
    ]),
  ).values()) {
    if (address.sourceRegistrationId === ownerId) {
      members.push({ kind: address.kind, name: address.name });
      continue;
    }
    const label = portableSourceName(catalog, address.sourceRegistrationId);
    if (label === undefined) {
      findings.push({
        code: "profile-copy-source-name",
        message: `${address.kind} ${address.name} needs distinct portable names for its external sources. Set name in tack.yaml and repair duplicate names; UUIDs and directory names are not portable qualifiers.`,
      });
      continue;
    }
    requirements.add(label);
    members.push({ kind: address.kind, name: address.name, source: label });
  }
  const profile: Profile = {
    version: 1,
    name,
    members,
    ...(requirements.size === 0 ? {} : { "depends-on": [...requirements].sort() }),
  };
  return { profile, findings };
};
