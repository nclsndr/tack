import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeImportRecord,
  filesDigest,
  sha256Hex,
  type ImportRecord,
  type ImportRecordFile,
} from "../../domain/imports/import-record.ts";

const hex = (character: string, length = 64) => character.repeat(length);
const file = (path: string, executable = false): ImportRecordFile => ({
  path,
  sha256: hex("a"),
  executable,
});
const record = (overrides: Partial<ImportRecord> = {}): ImportRecord => {
  const files = [file("SKILL.md"), file("scripts/fill.py", true)];
  return {
    path: "skills/pdf",
    location: "github:anthropics/skills",
    transport: "https",
    "ref-kind": "default",
    revision: hex("1", 40),
    "upstream-path": "skills/pdf",
    "upstream-tree": hex("2", 40),
    "imported-at": "2026-11-11T12:40:00Z",
    digest: filesDigest(files),
    files,
    ...overrides,
  };
};

describe("sha256Hex", () => {
  it("hashes bytes", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("filesDigest", () => {
  it("is prefixed, stable and independent of input order", () => {
    const a = file("a.md");
    const b = file("b.md", true);
    expect(filesDigest([a, b])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(filesDigest([b, a])).toBe(filesDigest([a, b]));
  });

  it("changes with a path, a hash or an executable bit", () => {
    const base = filesDigest([file("a.md")]);
    expect(filesDigest([file("b.md")])).not.toBe(base);
    expect(filesDigest([file("a.md", true)])).not.toBe(base);
    expect(filesDigest([{ ...file("a.md"), sha256: hex("b") }])).not.toBe(base);
  });

  it("frames entries so layouts cannot collide", () => {
    expect(filesDigest([file("a"), file("b")])).not.toBe(filesDigest([file("a\nb")]));
  });
});

describe("decodeImportRecord", () => {
  it("accepts a complete record, with and without a ref", () => {
    expect(Result.isSuccess(decodeImportRecord(record()))).toBe(true);
    expect(Result.isSuccess(decodeImportRecord(record({ "ref-kind": "tag", ref: "v1.2.3" })))).toBe(
      true,
    );
  });

  it("decodes a record by shape, so a provider or transport from a newer release still decodes", () => {
    for (const changes of [
      { location: "forge:acme/repo" },
      { location: "my-forge:group/sub/repo", transport: "tarball" },
      { location: "github:Acme/Skills", transport: "ssh" },
    ])
      expect(
        Result.isSuccess(decodeImportRecord({ ...record(), ...changes })),
        JSON.stringify(changes),
      ).toBe(true);
  });

  it("accepts an empty upstream path for a repository-root skill", () => {
    expect(Result.isSuccess(decodeImportRecord(record({ "upstream-path": "" })))).toBe(true);
  });

  it.each([
    ["an unknown key", { ...record(), extra: true }],
    ["a missing key", (({ revision: _revision, ...rest }) => rest)(record())],
    ["a short revision", record({ revision: hex("1", 12) })],
    ["an uppercase revision", record({ revision: hex("A", 40) })],
    ["a malformed transport", { ...record(), transport: "Git" }],
    ["an empty transport", { ...record(), transport: "" }],
    ["a location without a provider", record({ location: "anthropics/skills" })],
    ["a location with no text after the provider", record({ location: "github:" })],
    ["a location whose provider is a URL scheme", record({ location: "https:anthropics/skills" })],
    ["a location whose provider is a single letter", record({ location: "c:anthropics/skills" })],
    [
      "a location whose provider is not lowercase",
      record({ location: "GitHub:anthropics/skills" }),
    ],
    ["an unknown ref kind", { ...record(), "ref-kind": "head" }],
    ["a digest without its prefix", record({ digest: hex("a") })],
    ["a malformed time", record({ "imported-at": "yesterday" })],
    ["an empty path", record({ path: "" })],
    ["a file hash of the wrong length", record({ files: [{ ...file("a"), sha256: "abc" }] })],
    ["unsorted files", record({ files: [file("b"), file("a")] })],
    ["duplicate files", record({ files: [file("a"), file("a")] })],
    ["a non-boolean executable bit", { ...record(), files: [{ ...file("a"), executable: "no" }] }],
  ])("rejects %s", (_label, value) => {
    expect(Result.isFailure(decodeImportRecord(value))).toBe(true);
  });

  it("explains a failure", () => {
    const result = decodeImportRecord({ ...record(), transport: "Git" });
    expect(Result.isFailure(result) && result.failure.length > 0).toBe(true);
  });
});
