import { readBoundedBundleFile } from "./bundle-file-read.ts";
import { Effect, FileSystem, Path, Option, Schema } from "effect";
import { BundleManifestSchema } from "../../domain/bundles/bundle-schema.ts";
import { bundleLimits } from "../../domain/bundles/tar.ts";
import { BundleError } from "../../domain/bundles/bundle-error.ts";
import {
  bundleDigest,
  bundleFactsDigest,
  makeBundleManifest,
} from "../../domain/bundles/bundle-codec.ts";
import { validateBundlePath } from "../../domain/bundles/bundle-path.ts";
import type { SourceRegistration } from "../../domain/sources/source-schema.ts";

/** Observes retained projection bytes/modes and binding identities before cataloging them. */
export const bundleIntegrityIssue = Effect.fnUntraced(function* (
  registration: SourceRegistration,
  registrations: ReadonlyArray<SourceRegistration>,
) {
  const bundle = registration.bundle;
  if (bundle === undefined) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.gen(function* () {
    if (
      Object.entries(bundle.sourceKeys).some(([name, key]) => {
        const target = registrations.find((candidate) => candidate.id === bundle.bindings[name]);
        return target?.bundle?.identity !== bundle.identity || target.bundle.sourceKey !== key;
      }) ||
      Object.keys(bundle.bindings).length !== Object.keys(bundle.sourceKeys).length
    )
      return `Bundle ${bundle.identity}/${bundle.sourceKey} has a changed source binding; repair its retained mapping before retry.`;
    if (Option.isSome(yield* fs.readLink(registration.canonicalPath).pipe(Effect.option)))
      return "Retained bundle root became a link.";
    if (
      (yield* fs.stat(registration.canonicalPath)).type !== "Directory" ||
      (yield* fs.realPath(registration.canonicalPath)) !== registration.canonicalPath
    )
      return "Retained bundle root changed or became a link.";
    const manifestPath = path.join(
      path.dirname(path.dirname(registration.canonicalPath)),
      "manifest.json",
    );
    if (Option.isSome(yield* fs.readLink(manifestPath).pipe(Effect.option)))
      return "Retained bundle manifest became a link.";
    const manifestInfo = yield* fs.stat(manifestPath);
    if (
      Number(manifestInfo.size) > bundleLimits.fileBytes ||
      manifestInfo.type !== "File" ||
      (manifestInfo.mode & 0o777) !== 0o644
    )
      return "Retained bundle manifest changed its bounded regular-file facts.";
    const encoded = new TextDecoder().decode(yield* readBoundedBundleFile(manifestPath));
    const manifest = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(BundleManifestSchema, { onExcessProperty: "error" })(
          JSON.parse(encoded),
        ),
      catch: () =>
        new BundleError({
          code: "profile-bundle-identity",
          message: "Retained bundle manifest is invalid.",
        }),
    });
    const { identity, ...content } = manifest;
    const declared = manifest.sources.find((source) => source.key === bundle.sourceKey);
    const prefix = `sources/${bundle.sourceKey}/`;
    const files = manifest.files
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
    if (
      identity !== bundle.identity ||
      makeBundleManifest(content).identity !== identity ||
      declared === undefined ||
      bundleFactsDigest(declared.bindings) !== bundleFactsDigest(bundle.sourceKeys) ||
      bundleFactsDigest(files) !== bundleFactsDigest(bundle.files)
    )
      return `Retained manifest/mapping identity changed for ${bundle.sourceKey}.`;
    const expected = new Map(bundle.files.map((file) => [file.path.normalize("NFC"), file]));
    const visit = Effect.fnUntraced(function* (
      relative: string,
    ): Effect.fn.Return<
      string | undefined,
      import("effect").PlatformError.PlatformError | BundleError,
      FileSystem.FileSystem
    > {
      const absolute = path.join(registration.canonicalPath, relative);
      if (relative.length > 0) {
        try {
          validateBundlePath(relative);
        } catch {
          return `Unsafe retained bundle path: ${relative}`;
        }
        const fact = expected.get(relative.normalize("NFC"));
        if (Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option)))
          return `Retained bundle path became a link: ${absolute}`;
        const info = yield* fs.stat(absolute);
        if (
          fact === undefined ||
          info.type !== (fact.kind === "file" ? "File" : "Directory") ||
          (info.mode & 0o777) !== fact.mode
        )
          return `Retained bundle content/mode changed: ${absolute}`;
        if (fact.kind === "file") {
          const bytes = yield* readBoundedBundleFile(absolute);
          return bytes.length !== fact.size || bundleDigest(bytes) !== fact.sha256
            ? `Retained bundle digest changed: ${absolute}`
            : undefined;
        }
      }
      for (const name of yield* fs.readDirectory(absolute)) {
        const issue = yield* visit(relative.length === 0 ? name : `${relative}/${name}`);
        if (issue !== undefined) return issue;
      }
      return undefined;
    });
    const issue = yield* visit("");
    if (issue !== undefined) return issue;
    for (const file of bundle.files)
      if ((yield* fs.exists(path.join(registration.canonicalPath, file.path))) === false)
        return `Retained bundle member missing: ${file.path}`;
    return undefined;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(`Retained bundle source is unavailable: ${error.message}`),
    ),
  );
});
