import type { Catalog } from "../sources/catalog-schema.ts";

/** Ordinary external qualifiers need a unique declared name; directory labels and UUIDs are local. */
export const portableSourceName = (catalog: Catalog, sourceId: string): string | undefined => {
  const owner = catalog.sources?.find((source) => source.registration.id === sourceId);
  if (
    owner?.status !== "healthy" ||
    (owner.labelOrigin !== "declared" && owner.origin !== "builtin")
  )
    return undefined;
  const label = owner.label;
  return label !== undefined &&
    catalog.sources?.filter((source) => source.status === "healthy" && source.label === label)
      .length === 1
    ? label
    : undefined;
};
