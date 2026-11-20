import { concatBytes } from "../identity/portable.ts";
import { BundleError } from "./bundle-error.ts";
import { validateBundlePath } from "./bundle-path.ts";

export type ArchiveEntry = {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly bytes: Uint8Array;
};
/** Bounds apply before extraction; archives cannot supply their own limits. */
export const bundleLimits = {
  compressedBytes: 8 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  entries: 5000,
} as const;
const block = 512;
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
function invalid(message: string): never {
  throw new BundleError({ code: "profile-bundle-invalid", message });
}
const limit = (message: string): never => {
  throw new BundleError({ code: "profile-bundle-limit", message });
};
const padded = (size: number) => Math.ceil(size / block) * block;
const text = (bytes: Uint8Array, start: number, size: number) => {
  const field = bytes.subarray(start, start + size);
  const end = field.indexOf(0);
  if (end >= 0 && field.subarray(end).some((byte) => byte !== 0))
    invalid("Nonzero bytes after a header field terminator.");
  try {
    return decoder.decode(end < 0 ? field : field.subarray(0, end));
  } catch {
    return invalid("Archive names must use valid UTF-8.");
  }
};
const octal = (bytes: Uint8Array, start: number, size: number) => {
  const value = decoder
    .decode(bytes.subarray(start, start + size))
    .replace(/[\0 ]+$/g, "")
    .trimStart();
  if (/^[0-7]+$/.test(value) === false)
    return invalid("Only unsigned octal ustar numbers are supported.");
  const number = Number.parseInt(value, 8);
  return Number.isSafeInteger(number) ? number : invalid("Archive number is too large.");
};
const checksumOf = (header: Uint8Array) =>
  header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);

const validateEntries = (
  entries: ReadonlyArray<ArchiveEntry>,
  limits:
    | typeof bundleLimits
    | {
        readonly compressedBytes: number;
        readonly expandedBytes: number;
        readonly fileBytes: number;
        readonly entries: number;
      },
) => {
  if (entries.length > limits.entries) limit("Too many archive entries.");
  const actual = new Set<string>();
  const prefixes = new Map<string, string>();
  const kinds = new Map(entries.map((entry) => [entry.path, entry.kind]));
  let total = 1024;
  for (const entry of entries) {
    validateBundlePath(entry.path);
    if (entry.mode < 0 || entry.mode > 0o777 || Number.isInteger(entry.mode) === false)
      invalid(`Unsafe mode for ${entry.path}.`);
    if (entry.bytes.length > limits.fileBytes)
      limit(`File exceeds the bundle limit: ${entry.path}`);
    if (entry.kind === "directory" && entry.bytes.length !== 0)
      invalid(`Directory carries data: ${entry.path}`);
    if (actual.has(entry.path)) invalid(`Duplicate archive path: ${entry.path}`);
    actual.add(entry.path);
    const parts = entry.path.split("/");
    for (let count = 1; count <= parts.length; count += 1) {
      const prefix = parts.slice(0, count).join("/");
      const folded = prefix.normalize("NFC").toLowerCase();
      const prior = prefixes.get(folded);
      if (prior !== undefined && prior !== prefix)
        invalid(`Case/Unicode-conflicting archive paths: ${prior}, ${prefix}`);
      prefixes.set(folded, prefix);
      if (count < parts.length && kinds.get(prefix) === "file")
        invalid(`File used as an archive parent: ${prefix}`);
    }
    total += block + padded(entry.bytes.length);
    if (total > limits.expandedBytes) limit("Expanded archive exceeds the bundle limit.");
  }
};
const put = (header: Uint8Array, start: number, width: number, value: string) => {
  const bytes = utf8.encode(value);
  // Coverage skip: encodeTar splits paths and sizes numbers to fit every field before writing it.
  /* v8 ignore next -- @preserve */
  if (bytes.length > width)
    invalid("Path does not fit bounded ustar fields; shorten or materialize its layout.");
  header.set(bytes, start);
};
const putOctal = (header: Uint8Array, start: number, width: number, value: number) =>
  put(header, start, width, `${value.toString(8).padStart(width - 1, "0")}\0`);

/** Writes only bounded POSIX ustar regular files/directories; no helper or resource code runs. */
export const encodeTar = (entries: ReadonlyArray<ArchiveEntry>): Uint8Array => {
  validateEntries(entries, bundleLimits);
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(block);
    let name = entry.path;
    if (utf8.encode(name).length > 100) {
      const split = Array.from({ length: name.length }, (_, index) => index)
        .filter((index) => name[index] === "/")
        .find(
          (index) =>
            utf8.encode(name.slice(0, index)).length <= 155 &&
            utf8.encode(name.slice(index + 1)).length <= 100,
        );
      if (split === undefined) invalid(`Path is too long for ustar: ${entry.path}`);
      put(header, 345, 155, name.slice(0, split));
      name = name.slice(split + 1);
    }
    put(header, 0, 100, name);
    putOctal(header, 100, 8, entry.mode);
    putOctal(header, 108, 8, 0);
    putOctal(header, 116, 8, 0);
    putOctal(header, 124, 12, entry.bytes.length);
    putOctal(header, 136, 12, 0);
    header[156] = (entry.kind === "file" ? "0" : "5").charCodeAt(0);
    put(header, 257, 6, "ustar\0");
    put(header, 263, 2, "00");
    put(header, 148, 8, `${checksumOf(header).toString(8).padStart(6, "0")}\0 `);
    chunks.push(
      header,
      entry.bytes,
      new Uint8Array(padded(entry.bytes.length) - entry.bytes.length),
    );
  }
  chunks.push(new Uint8Array(1024));
  return concatBytes(chunks);
};

/**
 * The gzip codec bundles use, injected so the archive rules stay pure: `gunzip` throws on invalid
 * input or when the expanded bytes would exceed `maxOutputLength`.
 */
export type GzipCodec = {
  readonly gzip: (bytes: Uint8Array) => Uint8Array;
  readonly gunzip: (bytes: Uint8Array, maxOutputLength: number) => Uint8Array;
};

/** Validates an entire compressed archive in memory before callers can write a single payload. */
export const decodeTarGzip = (
  codec: GzipCodec,
  compressed: Uint8Array,
  overrides: Partial<{ readonly [K in keyof typeof bundleLimits]: number }> = {},
): ReadonlyArray<ArchiveEntry> => {
  const limits = { ...bundleLimits, ...overrides };
  if (compressed.length > limits.compressedBytes)
    limit("Compressed bundle exceeds the input limit.");
  let bytes: Uint8Array;
  try {
    bytes = codec.gunzip(compressed, limits.expandedBytes);
  } catch {
    return limit("Invalid gzip input or expanded bundle exceeds the limit.");
  }
  if (bytes.length % block !== 0) invalid("Truncated archive block.");
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let ended = false;
  while (offset + block <= bytes.length) {
    const header = bytes.subarray(offset, offset + block);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > bytes.length || bytes.subarray(offset).some((byte) => byte !== 0))
        invalid("Invalid end-of-archive blocks.");
      ended = true;
      break;
    }
    if (text(header, 257, 6) !== "ustar" || text(header, 263, 2) !== "00")
      invalid("Only POSIX ustar bundle headers are supported.");
    if (octal(header, 148, 8) !== checksumOf(header)) invalid("Archive header checksum mismatch.");
    const type = header[156];
    if (type !== 0 && type !== 48 && type !== 53)
      invalid(
        "Links, special files and extended archive headers are not supported; materialize regular content first.",
      );
    if (text(header, 157, 100).length > 0) invalid("Archive link targets are forbidden.");
    const size = octal(header, 124, 12);
    if (size > limits.fileBytes) limit("Archive member exceeds the file limit.");
    if (offset + block + padded(size) > bytes.length) invalid("Truncated archive member.");
    const prefix = text(header, 345, 155);
    const name = text(header, 0, 100);
    const path = `${prefix.length === 0 ? "" : prefix + "/"}${name}`.replace(
      type === 53 ? /\/$/ : /$^/,
      "",
    );
    entries.push({
      path,
      kind: type === 53 ? "directory" : "file",
      mode: octal(header, 100, 8),
      bytes: new Uint8Array(bytes.subarray(offset + block, offset + block + size)),
    });
    if (entries.length > limits.entries) limit("Too many archive entries.");
    offset += block + padded(size);
  }
  if (ended === false) invalid("Missing end-of-archive blocks.");
  validateEntries(entries, limits);
  return entries;
};
