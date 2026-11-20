import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The manifests that carry the one repository version, the root first. */
export const manifestPaths = [
  "package.json",
  "apps/cli/package.json",
  "packages/core/package.json",
  "packages/reader/package.json",
] as const;

/** The lockfile that repeats each workspace's version. */
export const lockPath = "bun.lock";

/** A plain SemVer `0.y.z` version: no pre-release tag and no build metadata. */
const plainVersion = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export const isPlainVersion = (value: string): boolean => plainVersion.test(value);

/** First minor release that may write each state format. A format needs a new minor number. */
export const stateFormatMilestones = [{ format: 1, minor: 1 }] as const;

/** Refuses a format change without a new minor release, including a reused format number. */
export const stateFormatVersionProblems = (format: number, version: string): string[] => {
  const milestones = stateFormatMilestones;
  const problems: string[] = [];
  for (let index = 1; index < milestones.length; index++) {
    const previous = milestones[index - 1];
    const current = milestones[index];
    if (previous !== undefined && current !== undefined && current.minor <= previous.minor) {
      problems.push(
        `State format ${current.format} needs a newer minor version than format ${previous.format}.`,
      );
    }
    if (previous !== undefined && current !== undefined && current.format <= previous.format) {
      problems.push(
        `State format ${current.format} must be greater than format ${previous.format}.`,
      );
    }
  }
  const milestone = milestones.find((item) => item.format === format);
  if (milestone === undefined)
    problems.push(`State format ${format} has no minor-version milestone.`);
  if (!isPlainVersion(version)) return [...problems, `Version ${version} is not plain 0.y.z.`];
  const minor = Number(version.split(".")[1]);
  if (milestone !== undefined && minor < milestone.minor) {
    problems.push(`State format ${format} requires minor version ${milestone.minor} or later.`);
  }
  return problems;
};

type Manifest = { readonly name?: string; readonly version?: string };

const readManifest = (root: string, path: string): Manifest =>
  JSON.parse(readFileSync(join(root, path), "utf8"));

const nameOf = (manifest: Manifest, path: string) => manifest.name ?? path;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

/** The version `bun.lock` records for a workspace, the root being `""`. */
const lockedVersion = (lock: unknown, workspace: string): string | undefined => {
  const version = field(field(field(lock, "workspaces"), workspace), "version");
  return typeof version === "string" ? version : undefined;
};

/**
 * Describes every way the four manifests and `bun.lock` disagree about the repository version, or
 * hold a version that is not plain `0.y.z`. The root manifest is the source; an empty result means
 * the repository is in lockstep. A frozen install accepts a bumped manifest next to a stale lock,
 * so the lock is read here.
 */
export const lockstepProblems = (root: string): ReadonlyArray<string> => {
  const manifests = manifestPaths.map((path) => ({ path, manifest: readManifest(root, path) }));
  const source = manifests[0]?.manifest.version;
  const problems: Array<string> = [];
  for (const { path, manifest } of manifests) {
    if (manifest.version === undefined) {
      problems.push(`${path} (${nameOf(manifest, path)}) has no version.`);
    } else if (!isPlainVersion(manifest.version)) {
      problems.push(
        `${path} (${nameOf(manifest, path)}) has version ${manifest.version}, which is not a plain 0.y.z version.`,
      );
    } else if (source !== undefined && manifest.version !== source) {
      problems.push(
        `${path} (${nameOf(manifest, path)}) has version ${manifest.version}; the root package.json has ${source}.`,
      );
    }
  }
  if (source === undefined) return problems;

  const lock = Bun.JSONC.parse(readFileSync(join(root, lockPath), "utf8"));
  for (const { path, manifest } of manifests.slice(1)) {
    const workspace = dirname(path);
    const recorded = lockedVersion(lock, workspace);
    if (recorded === undefined) {
      problems.push(
        `${lockPath} records no version for workspace ${workspace} (${nameOf(manifest, path)}); expected ${source}.`,
      );
    } else if (recorded !== source) {
      problems.push(
        `${lockPath} records version ${recorded} for workspace ${workspace} (${nameOf(manifest, path)}); expected ${source}.`,
      );
    }
  }
  const recordedRoot = lockedVersion(lock, "");
  if (recordedRoot !== undefined && recordedRoot !== source)
    problems.push(`${lockPath} records version ${recordedRoot} for the root; expected ${source}.`);
  return problems;
};

/**
 * Resolves a bump request: `patch` raises `z`, `minor` raises `y` and resets `z`, and an explicit
 * plain `0.y.z` value is used as given. Anything else is refused.
 */
export const nextVersion = (current: string, request: string): string => {
  if (request === "patch" || request === "minor") {
    const [, minor = "0", patch = "0"] = current.split(".");
    return request === "patch" ? `0.${minor}.${Number(patch) + 1}` : `0.${Number(minor) + 1}.0`;
  }
  if (!isPlainVersion(request))
    throw new Error(`"${request}" is not a plain 0.y.z version, "patch" or "minor".`);
  return request;
};

const versionLine = /^(\s*)"version":\s*"[^"]*"(,?)$/m;
const nameLine = /^(\s*)"name":\s*"[^"]*",$/m;

/** Writes `version` into all four manifests, changing only the version line. */
export const setManifestVersions = (root: string, version: string): void => {
  if (!isPlainVersion(version)) throw new Error(`"${version}" is not a plain 0.y.z version.`);
  for (const path of manifestPaths) {
    const file = join(root, path);
    const text = readFileSync(file, "utf8");
    const updated = versionLine.test(text)
      ? text.replace(versionLine, `$1"version": "${version}"$2`)
      : text.replace(
          nameLine,
          (name, indent: string) => `${name}\n${indent}"version": "${version}",`,
        );
    if (updated === text && !versionLine.test(text))
      throw new Error(`${path} has no name line to place the version after.`);
    if (updated !== text) writeFileSync(file, updated);
  }
};
