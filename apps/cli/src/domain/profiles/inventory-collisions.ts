import type { ResourceAddress } from "../sources/catalog-schema.ts";

/** Names skill/command deliveries claimed by several exact source identities. */
export const profileDeliveryCollisions = (
  addresses: ReadonlyArray<ResourceAddress>,
): ReadonlyArray<string> => {
  const names = new Map<string, Set<string>>();
  for (const address of addresses) {
    if (address.kind !== "skill" && address.kind !== "command") continue;
    const name = `${address.kind}:${address.name}`;
    const sources = names.get(name) ?? new Set<string>();
    sources.add(address.sourceRegistrationId);
    names.set(name, sources);
  }
  return [...names].flatMap(([name, sources]) => (sources.size > 1 ? [name] : []));
};
