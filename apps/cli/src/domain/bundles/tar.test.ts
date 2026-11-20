import { expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeTarGzip, encodeTar, type ArchiveEntry } from "./tar.ts";
import { nodeGzip } from "../../platform/compression/compression.ts";

const entry = (path: string, kind: "file" | "directory" = "file"): ArchiveEntry => ({
  path,
  kind,
  mode: kind === "file" ? 0o644 : 0o755,
  bytes: new TextEncoder().encode(kind === "file" ? "hello" : ""),
});
const checksum = (header: Uint8Array) => {
  header.fill(32, 148, 156);
  const value = [...header]
    .reduce((sum, byte) => sum + byte, 0)
    .toString(8)
    .padStart(6, "0");
  header.set(new TextEncoder().encode(value + "\0 "), 148);
};
const mutate = (field: (header: Uint8Array) => void) => {
  const tar = encodeTar([entry("safe")]);
  field(tar.subarray(0, 512));
  checksum(tar.subarray(0, 512));
  return gzipSync(tar);
};
it("round trips bounded ustar files, directories, executable modes and prefix paths", () => {
  const entries = [
    entry("sources", "directory"),
    { ...entry("sources/tool.sh"), mode: 0o755 },
    entry("a/".repeat(60) + "file.txt"),
  ];
  expect(decodeTarGzip(nodeGzip, gzipSync(encodeTar(entries)))).toEqual(entries);
});
it.each([
  "../escape",
  "/absolute",
  "C:/windows",
  "a/../b",
  "a//b",
  "a\\b",
  ".env",
  "a/.git/config",
  "a/.local/state",
  "a/credentials.json",
])("refuses unsafe or sensitive path %s", (path) => {
  expect(() => encodeTar([entry(path)])).toThrow();
});
it("rejects case/Unicode conflicts, duplicate entries and files used as parents", () => {
  for (const names of [
    ["A/x", "a/y"],
    ["é", "é"],
    ["same", "same"],
    ["a", "a/b"],
  ])
    expect(() => encodeTar(names.map((name) => entry(name)))).toThrow();
});
it("rejects malicious headers, checksums, links, special files, unsafe names and truncation before extraction", () => {
  for (const type of ["1", "2", "3", "4", "6", "x", "g", "L"])
    expect(() =>
      decodeTarGzip(
        nodeGzip,
        mutate((header) => (header[156] = type.charCodeAt(0))),
      ),
    ).toThrow();
  expect(() =>
    decodeTarGzip(
      nodeGzip,
      mutate((header) => {
        header.fill(0, 0, 100);
        header.set(new TextEncoder().encode("../escape"), 0);
      }),
    ),
  ).toThrow();
  expect(() =>
    decodeTarGzip(
      nodeGzip,
      mutate((header) => (header[257] = 0)),
    ),
  ).toThrow();
  expect(() =>
    decodeTarGzip(
      nodeGzip,
      mutate((header) => (header[124] = 128)),
    ),
  ).toThrow();
  const broken = encodeTar([entry("safe")]);
  broken[0] = 1;
  expect(() => decodeTarGzip(nodeGzip, gzipSync(broken))).toThrow();
  expect(() =>
    decodeTarGzip(nodeGzip, gzipSync(encodeTar([entry("safe")]).subarray(0, 700))),
  ).toThrow();
});
it("bounds compressed input, expansion, files and entry counts", () => {
  const compressed = gzipSync(encodeTar([entry("safe")]));
  expect(() => decodeTarGzip(nodeGzip, compressed, { compressedBytes: 1 })).toThrow();
  expect(() => decodeTarGzip(nodeGzip, compressed, { expandedBytes: 512 })).toThrow();
  expect(() => decodeTarGzip(nodeGzip, compressed, { fileBytes: 1 })).toThrow();
  expect(() => decodeTarGzip(nodeGzip, compressed, { entries: 0 })).toThrow();
});

it("rejects malformed field terminators, invalid UTF-8, link targets and damaged end records", () => {
  expect(() =>
    decodeTarGzip(
      nodeGzip,
      mutate((header) => (header[50] = 1)),
    ),
  ).toThrow();
  expect(() =>
    decodeTarGzip(
      nodeGzip,
      mutate((header) => (header[0] = 255)),
    ),
  ).toThrow();
  expect(() =>
    decodeTarGzip(
      nodeGzip,
      mutate((header) => (header[157] = 65)),
    ),
  ).toThrow();
  expect(() =>
    decodeTarGzip(
      nodeGzip,
      mutate((header) => (header[156] = 53)),
    ),
  ).toThrow();
  expect(() =>
    decodeTarGzip(
      nodeGzip,
      mutate((header) => {
        header.fill(0, 124, 136);
        header.set(new TextEncoder().encode("00000004000"), 124);
      }),
    ),
  ).toThrow();
  const archive = encodeTar([entry("safe")]);
  expect(() =>
    decodeTarGzip(nodeGzip, gzipSync(archive.subarray(0, archive.length - 1024))),
  ).toThrow();
  const end = archive.slice();
  end[end.length - 1] = 1;
  expect(() => decodeTarGzip(nodeGzip, gzipSync(end))).toThrow();
  expect(() => decodeTarGzip(nodeGzip, gzipSync(new Uint8Array(512)))).toThrow();
  expect(() => encodeTar([{ ...entry("safe"), mode: 0o4755 }])).toThrow();
  expect(() => encodeTar([entry("a".repeat(256))])).toThrow();
  expect(
    decodeTarGzip(
      nodeGzip,
      mutate((header) => (header[156] = 0)),
    )[0]?.kind,
  ).toBe("file");
});

it("refuses headers that are not POSIX ustar version 00", () => {
  const ascii = new TextEncoder();
  expect(() =>
    decodeTarGzip(
      nodeGzip,
      mutate((header) => header.set(ascii.encode("ustaX\0"), 257)),
    ),
  ).toThrow("Only POSIX ustar bundle headers are supported.");
  expect(() =>
    decodeTarGzip(
      nodeGzip,
      mutate((header) => header.set(ascii.encode("01"), 263)),
    ),
  ).toThrow("Only POSIX ustar bundle headers are supported.");
});

it("refuses header numbers that are not unsigned octal", () => {
  expect(() =>
    decodeTarGzip(
      nodeGzip,
      mutate((header) => header.set(new TextEncoder().encode("0000698\0"), 100)),
    ),
  ).toThrow("Only unsigned octal ustar numbers are supported.");
});

it("refuses to write more entries than a bundle may hold", () => {
  const entries = Array.from({ length: 5001 }, (_, index) => entry(`file-${index}`));

  expect(() => encodeTar(entries)).toThrow("Too many archive entries.");
});

it("refuses to write a file larger than a bundle member may be", () => {
  const large = { ...entry("large"), bytes: new Uint8Array(8 * 1024 * 1024 + 1) };

  expect(() => encodeTar([large])).toThrow("File exceeds the bundle limit: large");
});

it("refuses to write files whose total expands past the bundle limit", () => {
  const files = Array.from({ length: 5 }, (_, index) => ({
    ...entry(`part-${index}`),
    bytes: new Uint8Array(7 * 1024 * 1024),
  }));

  expect(() => encodeTar(files)).toThrow("Expanded archive exceeds the bundle limit.");
});
