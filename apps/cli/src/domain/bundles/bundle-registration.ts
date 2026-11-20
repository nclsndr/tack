import type { BundleManifest } from "./bundle-schema.ts";
import { BundleError } from "./bundle-error.ts";
import { bundleDigest } from "./bundle-codec.ts";
import type { SourceRegistration } from "../sources/source-schema.ts";

/** A stable, distinct local reference for one verified artifact projection. */
export const bundleSourceLabel = (
  bundle: Pick<NonNullable<SourceRegistration["bundle"]>, "identity" | "sourceKey">,
) => `bundle-${BigInt(`0x${bundleDigest(`${bundle.identity}:${bundle.sourceKey}`)}`).toString(36)}`;

/** Creates recipient-local identities and explicit source bindings; sender state is never consulted. */
export const bundleRegistrationsFor = (
  manifest: BundleManifest,
  ids: ReadonlyMap<string, string>,
  pathForKey: (key: string) => string,
): ReadonlyArray<SourceRegistration> =>
  manifest.sources.map((source) => {
    const id = ids.get(source.key);
    if (id === undefined)
      throw new BundleError({
        code: "profile-bundle-identity",
        message: `Missing recipient identity for ${source.key}.`,
      });
    const prefix = `sources/${source.key}/`;
    const bindings = Object.fromEntries(
      Object.entries(source.bindings).map(([name, key]) => {
        const target = ids.get(key);
        if (target === undefined)
          throw new BundleError({
            code: "profile-bundle-identity",
            message: `Unknown source binding ${name} → ${key}.`,
          });
        return [name, target];
      }),
    );
    return {
      id,
      canonicalPath: pathForKey(source.key),
      bundle: {
        identity: manifest.identity,
        sourceKey: source.key,
        bindings,
        sourceKeys: source.bindings,
        files: manifest.files
          .filter((file) => file.path.startsWith(prefix))
          .map((file) => ({ ...file, path: file.path.slice(prefix.length) })),
      },
    };
  });
