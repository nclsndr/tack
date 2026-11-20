import { resolveDependencyClosure } from "../choices/dependency-resolution.ts";
import {
  catalogSelectableEntries,
  resourceAddressIdentity,
  type Catalog,
  type ResourceAddress,
} from "../sources/catalog-schema.ts";

/** Computes the required closure of a positive inventory, independently of ordinary choices. */
export const profileDependencyClosure = (
  catalog: Catalog,
  direct: ReadonlyArray<ResourceAddress>,
) => {
  const keys = new Set(direct.map(resourceAddressIdentity));
  const entries = catalogSelectableEntries(catalog);
  return resolveDependencyClosure({
    entries,
    sources: catalog.sources ?? [],
    quarantined: catalog.quarantined,
    includeOptional: false,
    initialSelection: {
      namespace: { _tag: "user" },
      unresolvedChoices: [],
      decisions: entries
        .filter((entry) => keys.has(resourceAddressIdentity(entry.address)))
        .map((entry) => ({
          _tag: "selected",
          address: entry.address,
          reason: "include",
          compatibility: "forced",
        })),
    },
  });
};
