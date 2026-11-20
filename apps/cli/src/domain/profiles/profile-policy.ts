import { isBuiltinSkill } from "../choices/builtin.ts";
import type { Catalog, ResourceAddress } from "../sources/catalog-schema.ts";

/** Warnings describe omissions without blocking an otherwise valid profile operation. */
export const profileHasErrors = (
  findings: ReadonlyArray<{ readonly code: string; readonly severity?: string }>,
): boolean => findings.some((finding) => finding.severity !== "warning");

/** Release provenance identifies ambient sources, independently of resource names. */
export const builtinProfileSourceIds = (catalog: Catalog): ReadonlySet<string> =>
  new Set([
    ...catalog.entries.filter(isBuiltinSkill).map((entry) => entry.sourceRegistrationId),
    ...(catalog.sources ?? [])
      .filter((source) => source.status === "healthy" && source.origin === "builtin")
      .map((source) => source.registration.id),
  ]);

/** Keeps only membership controlled by profiles; release-owned skills have separate delivery. */
export const profileControlledAddresses = <A extends ResourceAddress>(
  catalog: Catalog,
  addresses: ReadonlyArray<A>,
): ReadonlyArray<A> => {
  const builtinSources = builtinProfileSourceIds(catalog);
  return addresses.filter(
    (address) =>
      address.kind !== "skill" || builtinSources.has(address.sourceRegistrationId) === false,
  );
};

/** Shared explanation for file-only selection copies, including browse review. */
export const builtinProfileOmissionNote =
  "Built-in skills omitted. Release-owned skills are always delivered and locked; profiles do not control them.";
