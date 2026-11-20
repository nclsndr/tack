import { Schema } from "effect";
import rootPackage from "../../../package.json" with { type: "json" };
import { stateFormat } from "./domain/state/state-format.ts";

/** The repository's one `0.y.z` version, read from the root `package.json`. */
export const tackVersion: string = rootPackage.version;

/**
 * What a release build knows about its commit: the abbreviated or full hexadecimal object name, and
 * how many commits it was ahead of `origin/main` when built (0 when it was on `origin/main`).
 */
export type BuildInfo = {
  readonly commit: string;
  readonly ahead: number;
};

/**
 * A release build injects one {@link BuildInfo} through the bundler's `--define` option, as
 * `--define '__TACK_BUILD_INFO__={"commit":"fec4c8e","ahead":0}'`. A source run has none.
 */
// oxlint-disable-next-line eslint/no-underscore-dangle -- The release build injects this constant by its reserved name.
declare const __TACK_BUILD_INFO__: BuildInfo | undefined;

const buildInfo = (): BuildInfo | undefined =>
  typeof __TACK_BUILD_INFO__ === "undefined" ? undefined : __TACK_BUILD_INFO__;

const commitPattern = /^[0-9a-f]{7,40}$/;

/**
 * Formats the release stamp: `0.y.z+dev` for a source run, `0.y.z+g<commit>` for a release, and
 * `0.y.z+g<commit>.ahead.<n>` when the release was `n` commits ahead of `origin/main`. Build
 * metadata does not affect SemVer order, so every stamp compares equal to its plain version.
 */
export const releaseStamp = (version: string, build?: BuildInfo): string => {
  if (build === undefined) return `${version}+dev`;
  if (!commitPattern.test(build.commit))
    throw new Error(`Build commit "${build.commit}" is not a lowercase hexadecimal commit name.`);
  if (!Number.isInteger(build.ahead) || build.ahead < 0)
    throw new Error(`Build ahead count "${String(build.ahead)}" is not a non-negative integer.`);
  return `${version}+g${build.commit}${build.ahead > 0 ? `.ahead.${build.ahead}` : ""}`;
};

/** The `version` result: what is running, and whether it is a source run or a release. */
export const VersionReportSchema = Schema.Struct({
  kind: Schema.Literal("version"),
  /** The plain `0.y.z` version shared by every package. */
  version: Schema.String,
  /** The commit a release was built from; `null` for a source run. */
  commit: Schema.NullOr(Schema.String),
  /** The release stamp: the version plus build metadata. */
  stamp: Schema.String,
  /** Whether Tack runs from a checkout through Bun rather than as a built release. */
  sourceRun: Schema.Boolean,
  /** The one state document format this release reads and writes. */
  stateFormat: Schema.Number,
});

/** A version result. */
export type VersionReport = typeof VersionReportSchema.Type;

/** Describes the running Tack. It reads no state and touches no file. */
export const currentVersionReport = (): VersionReport => {
  const build = buildInfo();
  return {
    kind: "version",
    version: tackVersion,
    commit: build?.commit ?? null,
    stamp: releaseStamp(tackVersion, build),
    sourceRun: build === undefined,
    stateFormat,
  };
};
