import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  lockPath,
  lockstepProblems,
  manifestPaths,
  nextVersion,
  setManifestVersions,
  stateFormatVersionProblems,
} from "../../../scripts/version-lockstep.ts";
import { publishedPackageName } from "../src/domain/execution/published-name.ts";
import { stateFormat } from "../src/domain/state/state-format.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const roots: Array<string> = [];
const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({ version: Schema.String, private: Schema.Boolean }),
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const names: Readonly<Record<string, string>> = {
  "package.json": "tack",
  "apps/cli/package.json": "@tackup/cli",
  "packages/core/package.json": "@tackup/core",
  "packages/reader/package.json": "@tackup/reader",
};

type Versions = Readonly<Record<string, string | undefined>>;

/** Writes a repository fixture whose manifests and lock carry the given versions. */
const fixture = (manifests: Versions, lock: Versions = manifests) => {
  const root = mkdtempSync(join(tmpdir(), "tack-lockstep-test-"));
  roots.push(root);
  for (const path of manifestPaths) {
    const version = manifests[path];
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(
      join(root, path),
      `${JSON.stringify(
        { name: names[path], ...(version === undefined ? {} : { version }), private: true },
        null,
        2,
      )}\n`,
    );
  }
  const entry = (path: string, version: string | undefined) =>
    `    ${JSON.stringify(dirname(path) === "." ? "" : dirname(path))}: {\n      "name": ${JSON.stringify(names[path])},\n${
      path === "package.json" || version === undefined
        ? ""
        : `      "version": ${JSON.stringify(version)},\n`
    }    },\n`;
  writeFileSync(
    join(root, lockPath),
    `{\n  "lockfileVersion": 1,\n  "workspaces": {\n${manifestPaths
      .map((path) => entry(path, lock[path]))
      .join("")}  },\n}\n`,
  );
  return root;
};

const uniform = (version: string): Versions =>
  Object.fromEntries(manifestPaths.map((path) => [path, version]));

describe("repository versions", () => {
  it("keeps the four manifests and bun.lock on one plain 0.y.z version", () => {
    expect(lockstepProblems(repositoryRoot)).toEqual([]);
  });

  it("requires a new minor release when the state format changes", () => {
    const version = decodeManifest(
      JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")),
    ).version;
    expect(stateFormatVersionProblems(stateFormat, version)).toEqual([]);
    expect(stateFormatVersionProblems(3, "0.1.99")).not.toEqual([]);
    expect(stateFormatVersionProblems(5, version)).not.toEqual([]);
  });

  it("names the CLI workspace after the package Tack is published as", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(repositoryRoot, "apps/cli/package.json"), "utf8"),
    );
    expect(Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(manifest).name).toBe(
      publishedPackageName,
    );
  });

  it("gives every package a plain 0.y.z version and keeps it private", () => {
    for (const path of manifestPaths) {
      const manifest = decodeManifest(JSON.parse(readFileSync(join(repositoryRoot, path), "utf8")));
      expect(manifest.version, path).toMatch(/^0\.\d+\.\d+$/);
      expect(manifest.private, path).toBe(true);
    }
  });
});

describe("version lockstep check", () => {
  it("accepts agreeing manifests and lock", () => {
    expect(lockstepProblems(fixture(uniform("0.3.7")))).toEqual([]);
  });

  it("fails and names the package whose manifest differs", () => {
    const problems = lockstepProblems(
      fixture({ ...uniform("0.2.0"), "packages/core/package.json": "0.2.1" }),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("packages/core/package.json");
    expect(problems[0]).toContain("@tackup/core");
    expect(problems[0]).toContain("0.2.1");
    expect(problems[0]).toContain("0.2.0");
  });

  it("fails when a manifest has no version, including the root", () => {
    const problems = lockstepProblems(
      fixture({ ...uniform("0.2.0"), "package.json": undefined }, uniform("0.2.0")),
    );
    expect(problems.join("\n")).toContain("package.json");
    expect(problems.join("\n")).toContain("no version");
  });

  it("fails on a stale workspace version in bun.lock, which a frozen install accepts", () => {
    const problems = lockstepProblems(
      fixture(uniform("0.2.0"), { ...uniform("0.2.0"), "apps/cli/package.json": "0.1.0" }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(lockPath);
    expect(problems[0]).toContain("apps/cli");
    expect(problems[0]).toContain("@tackup/cli");
    expect(problems[0]).toContain("0.1.0");
    expect(problems[0]).toContain("0.2.0");
  });

  it("fails when bun.lock lacks a workspace's version", () => {
    const problems = lockstepProblems(
      fixture(uniform("0.2.0"), { ...uniform("0.2.0"), "packages/reader/package.json": undefined }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("packages/reader");
  });

  it("fails on anything that is not a plain 0.y.z version", () => {
    for (const version of ["1.0.0", "0.1", "0.1.0-alpha.1", "0.1.0+gfec4c8e", "v0.1.0", "0.01.0"]) {
      const problems = lockstepProblems(fixture(uniform(version)));
      expect(problems.length, version).toBeGreaterThan(0);
      expect(problems[0], version).toContain("0.y.z");
    }
  });
});

describe("version bump tooling", () => {
  it("computes the next plain 0.y.z version", () => {
    expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(nextVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.4", "0.3.0")).toBe("0.3.0");
  });

  it("refuses values that are not plain 0.y.z", () => {
    for (const value of ["1.0.0", "0.1", "0.2.0-alpha.1", "major", "", "0.2.0+dev"])
      expect(() => nextVersion("0.1.0", value), value).toThrow(/0\.y\.z/);
  });

  it("writes one version into all four manifests, adds a missing root version, and changes nothing else", () => {
    const root = fixture({ ...uniform("0.1.0"), "package.json": undefined }, uniform("0.1.0"));
    const read = (path: string): { version?: string } & Record<string, unknown> =>
      JSON.parse(readFileSync(join(root, path), "utf8"));
    const before = Object.fromEntries(manifestPaths.map((path) => [path, read(path)]));
    setManifestVersions(root, "0.2.0");
    for (const path of manifestPaths) {
      const { version, ...rest } = read(path);
      const { version: _previous, ...restBefore } = before[path] ?? {};
      expect(version, path).toBe("0.2.0");
      expect(rest, path).toEqual(restBefore);
    }
  });

  it("is idempotent and keeps a real manifest byte-identical when the version is unchanged", () => {
    const root = fixture(uniform("0.1.0"));
    const once = readFileSync(join(root, "apps/cli/package.json"), "utf8");
    setManifestVersions(root, "0.1.0");
    expect(readFileSync(join(root, "apps/cli/package.json"), "utf8")).toBe(once);
  });
});

describe("parser version", () => {
  const sourceFiles = (directory: string): ReadonlyArray<string> =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
    });

  it("no longer hard codes 0.0.0 anywhere in the CLI sources", () => {
    const offenders = sourceFiles(join(repositoryRoot, "apps/cli/src")).filter((path) =>
      /version:\s*"0\.0\.0"/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
