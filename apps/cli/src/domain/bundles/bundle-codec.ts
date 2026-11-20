import { Schema } from "effect";
import { sha256 } from "../identity/portable.ts";
import {
  BundleContentSchema,
  BundleManifestSchema,
  type BundleContent,
  type BundleManifest,
} from "./bundle-schema.ts";
import { BundleError } from "./bundle-error.ts";
import { validateBundlePath } from "./bundle-path.ts";
import {
  bundleLimits,
  decodeTarGzip,
  encodeTar,
  type ArchiveEntry,
  type GzipCodec,
} from "./tar.ts";

/** SHA-256 describes current bytes, without authenticating a publisher. */
export const bundleDigest = (bytes: Uint8Array | string): string => sha256(bytes);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
/** Stable digest for JSON-shaped bundle facts, independent of property ordering. */
export const bundleFactsDigest = (value: unknown): string => bundleDigest(canonical(value));
function invalid(message: string): never {
  throw new BundleError({ code: "profile-bundle-invalid", message });
}

/** Builds a deterministic identity over the readable manifest and all recorded payload facts. */
export const makeBundleManifest = (content: BundleContent): BundleManifest => {
  const decoded = Schema.decodeUnknownSync(BundleContentSchema, { onExcessProperty: "error" })(
    content,
  );
  return { ...decoded, identity: bundleFactsDigest(decoded) };
};

/** Validates manifest authority, complete file inventory and every digest before extraction. */
const validateBundleEntries = (entries: ReadonlyArray<ArchiveEntry>) => {
  const manifestEntry = entries.find((entry) => entry.path === "manifest.json");
  if (manifestEntry === undefined || manifestEntry.kind !== "file")
    invalid("Missing regular manifest.json.");
  let manifest: BundleManifest;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestEntry.bytes),
    );
    if (typeof parsed !== "object" || parsed === null || Reflect.get(parsed, "version") !== 1)
      throw new BundleError({
        code: "profile-bundle-version",
        message:
          "Unsupported bundle version. Use a release that supports this bundle or export bundle version 1.",
      });
    manifest = Schema.decodeUnknownSync(BundleManifestSchema, { onExcessProperty: "error" })(
      parsed,
    );
  } catch (error) {
    if (error instanceof BundleError) throw error;
    return invalid(`Invalid bundle manifest: ${String(error)}`);
  }
  const { identity, ...content } = manifest;
  if (makeBundleManifest(content).identity !== identity)
    invalid("Bundle identity does not match its manifest facts.");
  const keys = new Set(manifest.sources.map((source) => source.key));
  if (keys.size !== manifest.sources.length || keys.has(manifest.profile.sourceKey) === false)
    invalid("Duplicate/conflicting source keys or missing defining source.");
  const paths = new Set<string>();
  for (const fact of manifest.files) {
    validateBundlePath(fact.path);
    if (paths.has(fact.path)) invalid(`Duplicate manifest file: ${fact.path}`);
    paths.add(fact.path);
    const parts = fact.path.split("/");
    if (parts[0] !== "sources" || keys.has(parts[1] ?? "") === false || parts.length < 3)
      invalid(`Payload is outside a declared source projection: ${fact.path}`);
    const entry = entries.find((candidate) => candidate.path === fact.path);
    if (
      entry === undefined ||
      entry.kind !== fact.kind ||
      entry.mode !== fact.mode ||
      entry.bytes.length !== fact.size ||
      bundleDigest(entry.bytes) !== fact.sha256
    )
      invalid(`Payload facts/digest mismatch: ${fact.path}`);
  }
  const facts = new Map(manifest.files.map((file) => [file.path, file]));
  for (const file of manifest.files) {
    const parts = file.path.split("/");
    for (let count = 3; count < parts.length; count += 1)
      if (facts.get(parts.slice(0, count).join("/"))?.kind !== "directory")
        invalid(`Missing explicit directory facts for ${file.path}.`);
  }
  if (entries.some((entry) => entry.path !== "manifest.json" && paths.has(entry.path) === false))
    invalid("Archive contains unlisted payload content.");
  for (const source of manifest.sources) {
    if (Object.values(source.bindings).some((key) => keys.has(key) === false))
      invalid(`Unknown source key in bindings for ${source.key}.`);
    if (paths.has(`sources/${source.key}/tack.yaml`) === false)
      invalid(`Missing projected declaration for ${source.key}.`);
    const resources = new Set<string>();
    for (const resource of source.resources) {
      // A docs collection is its source's whole folder, written as the empty path.
      const wholeSource = resource.kind === "docs" && resource.path === "";
      if (wholeSource === false) validateBundlePath(resource.path);
      const key = `${resource.kind}:${resource.name}`;
      if (resources.has(key))
        invalid(`Duplicate resource identity in source ${source.key}: ${key}`);
      resources.add(key);
      if (wholeSource === false && paths.has(`sources/${source.key}/${resource.path}`) === false)
        invalid(`Missing ${key} content in source ${source.key}.`);
    }
  }
  validateBundlePath(manifest.profile.path);
  if (paths.has(`sources/${manifest.profile.sourceKey}/${manifest.profile.path}`) === false)
    invalid("The defining profile file is missing.");
  return { manifest, entries: entries.filter((entry) => entry.path !== "manifest.json") };
};

/** Encodes the versioned manifest and validated content as a content-only tar.gz. */
export const encodeBundle = (
  codec: GzipCodec,
  manifest: BundleManifest,
  entries: ReadonlyArray<ArchiveEntry>,
): Uint8Array => {
  const all = [
    {
      path: "manifest.json",
      kind: "file" as const,
      mode: 0o644,
      bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"),
    },
    ...entries,
  ];
  validateBundleEntries(all);
  const compressed = codec.gzip(encodeTar(all));
  if (compressed.length > bundleLimits.compressedBytes)
    throw new BundleError({
      code: "profile-bundle-limit",
      message: "Compressed artifact exceeds the bundle limit. Narrow content before export.",
    });
  return compressed;
};

/** Performs offline, in-memory archive and manifest validation; supplied code never runs. */
export const decodeBundle = (codec: GzipCodec, bytes: Uint8Array) =>
  validateBundleEntries(decodeTarGzip(codec, bytes));
