import { expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  bundleDigest,
  bundleFactsDigest,
  decodeBundle,
  encodeBundle,
  makeBundleManifest,
} from "./bundle-codec.ts";
import type { BundleContent, BundleManifest } from "./bundle-schema.ts";
import { encodeTar, type ArchiveEntry } from "./tar.ts";
import { nodeGzip } from "../../platform/compression/compression.ts";
const text = new TextEncoder();
const entries: ArchiveEntry[] = [
  {
    path: "sources/source-0/tack.yaml",
    kind: "file",
    mode: 0o644,
    bytes: text.encode("version: 1\nprofiles: [{name: ci, path: ci.yaml}]\n"),
  },
  {
    path: "sources/source-0/ci.yaml",
    kind: "file",
    mode: 0o644,
    bytes: text.encode("version: 1\nname: ci\nmembers: []\n"),
  },
];
const content: BundleContent = {
  version: 1,
  profile: { sourceKey: "source-0", name: "ci", path: "ci.yaml" },
  sources: [{ key: "source-0", bindings: {}, resources: [], prerequisites: [] }],
  files: entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    mode: entry.mode,
    size: entry.bytes.length,
    sha256: bundleDigest(entry.bytes),
  })),
};
const raw = (manifest: unknown, files = entries) =>
  gzipSync(
    encodeTar([
      {
        path: "manifest.json",
        kind: "file",
        mode: 0o644,
        bytes: text.encode(JSON.stringify(manifest)),
      },
      ...files,
    ]),
  );
it("validates a readable independently versioned manifest and deterministic byte inventory", () => {
  const manifest = makeBundleManifest(content);
  expect(decodeBundle(nodeGzip, encodeBundle(nodeGzip, manifest, entries)).manifest).toEqual(
    manifest,
  );
  expect(
    makeBundleManifest({
      ...content,
      profile: { path: "ci.yaml", name: "ci", sourceKey: "source-0" },
    }).identity,
  ).toBe(manifest.identity);
});
it("rejects unsupported versions, unknown authority, altered identity and mismatched digests", () => {
  const manifest = makeBundleManifest(content);
  for (const bad of [
    { ...manifest, version: 99 },
    { ...manifest, senderOwnership: [] },
    { ...manifest, identity: "0".repeat(64) },
    makeBundleManifest({
      ...content,
      files: content.files.map((file) => ({ ...file, sha256: "0".repeat(64) })),
    }),
  ])
    expect(() => decodeBundle(nodeGzip, raw(bad))).toThrow();
});
it("rejects conflicting keys, missing sources/files and unlisted payloads", () => {
  const manifest = makeBundleManifest(content);
  expect(() =>
    decodeBundle(
      nodeGzip,
      raw(makeBundleManifest({ ...content, sources: [...content.sources, ...content.sources] })),
    ),
  ).toThrow();
  expect(() =>
    decodeBundle(nodeGzip, raw(makeBundleManifest({ ...content, sources: [] }))),
  ).toThrow();
  expect(() => decodeBundle(nodeGzip, raw(manifest, entries.slice(1)))).toThrow();
  expect(() =>
    decodeBundle(
      nodeGzip,
      raw(manifest, [
        ...entries,
        { path: "sources/source-0/extra", kind: "file", mode: 0o644, bytes: text.encode("extra") },
      ]),
    ),
  ).toThrow();
  expect(() =>
    decodeBundle(
      nodeGzip,
      raw(
        makeBundleManifest({
          ...content,
          sources: [
            { key: "source-0", bindings: { team: "absent" }, resources: [], prerequisites: [] },
          ],
        }),
      ),
    ),
  ).toThrow();
});
it("requires explicit facts for projection parent directories", () => {
  const nested = [
    ...entries,
    {
      path: "sources/source-0/folder/file",
      kind: "file" as const,
      mode: 0o644,
      bytes: text.encode("content"),
    },
  ];
  const manifest: BundleManifest = makeBundleManifest({
    ...content,
    files: nested.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      size: entry.bytes.length,
      sha256: bundleDigest(entry.bytes),
    })),
  });
  expect(() => decodeBundle(nodeGzip, raw(manifest, nested))).toThrow();
});

it("refuses incomplete or contradictory readable inventories before any projection can be used", () => {
  const manifest = makeBundleManifest(content);
  expect(() => decodeBundle(nodeGzip, gzipSync(encodeTar(entries)))).toThrow();
  expect(() =>
    decodeBundle(
      nodeGzip,
      gzipSync(
        encodeTar([
          { path: "manifest.json", kind: "file", mode: 0o644, bytes: text.encode("{") },
          ...entries,
        ]),
      ),
    ),
  ).toThrow();
  const variants: BundleContent[] = [
    { ...content, files: [...content.files, ...content.files.slice(0, 1)] },
    {
      ...content,
      files: content.files.filter((file) => file.path.endsWith("tack.yaml") === false),
    },
    { ...content, profile: { ...content.profile, path: "missing.yaml" } },
    {
      ...content,
      sources: [
        {
          key: "source-0",
          bindings: {},
          prerequisites: [],
          resources: [{ kind: "command", name: "ghost", path: "ghost.md", direct: true }],
        },
      ],
    },
    {
      ...content,
      sources: [
        {
          key: "source-0",
          bindings: {},
          prerequisites: [],
          resources: [
            { kind: "command", name: "same", path: "ci.yaml", direct: true },
            { kind: "command", name: "same", path: "ci.yaml", direct: true },
          ],
        },
      ],
    },
  ];
  for (const bad of variants) {
    const listed = new Set(bad.files.map((file) => file.path));
    expect(() =>
      decodeBundle(
        nodeGzip,
        raw(
          makeBundleManifest(bad),
          entries.filter((entry) => listed.has(entry.path)),
        ),
      ),
    ).toThrow();
  }
  const extra = {
    path: "elsewhere",
    kind: "file" as const,
    mode: 0o644,
    bytes: text.encode("not a projection"),
  };
  const foreign = makeBundleManifest({
    ...content,
    files: [
      ...content.files,
      {
        path: extra.path,
        kind: extra.kind,
        mode: extra.mode,
        size: extra.bytes.length,
        sha256: bundleDigest(extra.bytes),
      },
    ],
  });
  expect(() => decodeBundle(nodeGzip, raw(foreign, [...entries, extra]))).toThrow();
  expect(manifest.version).toBe(1);
});

it("rejects a received Git credential store even when its manifest identity and digests match", () => {
  const sensitive: ArchiveEntry = {
    path: "sources/source-0/.git-credentials",
    kind: "file",
    mode: 0o600,
    bytes: text.encode("https://fixture-user:fixture-secret@example.invalid"),
  };
  const files = [...entries, sensitive];
  const manifest = makeBundleManifest({
    ...content,
    files: files.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      size: entry.bytes.length,
      sha256: bundleDigest(entry.bytes),
    })),
  });
  expect(() => decodeBundle(nodeGzip, raw(manifest, files))).toThrow(
    "Refused sensitive operator/configuration path",
  );
});

it("digests bundle facts independently of property order", () => {
  expect(bundleFactsDigest({ b: [{ y: 1, x: 2 }], a: "first" })).toBe(
    bundleFactsDigest({ a: "first", b: [{ x: 2, y: 1 }] }),
  );
  expect(bundleFactsDigest({ a: 1 })).not.toBe(bundleFactsDigest({ a: 2 }));
});

it("refuses to export content whose compressed archive exceeds the bundle limit", () => {
  const blobs = [1, 2].map((index): ArchiveEntry => ({
    path: `sources/source-0/blob-${index}.bin`,
    kind: "file",
    mode: 0o644,
    bytes: new Uint8Array(randomBytes(4_500_000)),
  }));
  const all = [...entries, ...blobs];
  const manifest = makeBundleManifest({
    ...content,
    files: all.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      size: entry.bytes.length,
      sha256: bundleDigest(entry.bytes),
    })),
  });

  expect(() => encodeBundle(nodeGzip, manifest, all)).toThrow(
    "Compressed artifact exceeds the bundle limit. Narrow content before export.",
  );
});
