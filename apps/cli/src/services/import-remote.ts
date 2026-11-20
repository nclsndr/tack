import type { RemoteTarget } from "../domain/imports/remote-target.ts";
import { Context, Effect, Schema, type Scope } from "effect";

/** Safety limits of one fetch. Tests pass smaller values; the product uses the defaults. */
export type ImportLimits = {
  readonly maxFileBytes: number;
  readonly maxFilesPerSkill: number;
  readonly maxBytesPerSkill: number;
  readonly maxBytesPerImport: number;
  readonly maxScratchBytes: number;
  readonly maxTreeEntries: number;
  readonly idleTimeoutMillis: number;
  readonly commandTimeoutMillis: number;
};

export const mebibyte = 1024 * 1024;

/** The defaults: 2,000 files and 50 MiB per skill, 5 MiB per file, 100 MiB per import. */
export const defaultImportLimits: ImportLimits = {
  maxFileBytes: 5 * mebibyte,
  maxFilesPerSkill: 2000,
  maxBytesPerSkill: 50 * mebibyte,
  maxBytesPerImport: 100 * mebibyte,
  maxScratchBytes: 300 * mebibyte,
  maxTreeEntries: 200_000,
  idleTimeoutMillis: 60_000,
  commandTimeoutMillis: 5 * 60_000,
};

/** The only protocols production git may use, whatever a provider asks for. */
export const productionProtocols: ReadonlyArray<string> = ["https", "ssh"];

/**
 * The value of `GIT_ALLOW_PROTOCOL` for a request: the ceiling's protocols that were requested, in
 * the ceiling's order. A request that leaves nothing allowed gets the whole ceiling, which still
 * never includes a protocol the ceiling does not name.
 */
export const allowedProtocolsFor = (
  requested: ReadonlyArray<string>,
  ceiling: ReadonlyArray<string>,
): string => {
  const allowed = ceiling.filter((protocol) => requested.includes(protocol));
  return (allowed.length === 0 ? ceiling : allowed).join(":");
};

/** Failure classes of fetching from a remote. */
const importFetchErrorCodes = [
  "import-git-unavailable",
  "import-git-too-old",
  "import-auth-failed",
  "import-network-failed",
  "import-ref-not-found",
  "import-revision-unavailable",
  "import-limit-exceeded",
  "import-timeout",
  "import-fetch-failed",
] as const;

/** Reports a failed fetch. The message never carries credentials. */
export class ImportFetchError extends Schema.TaggedError<ImportFetchError>()("ImportFetchError", {
  code: Schema.Literals(importFetchErrorCodes),
  message: Schema.String,
}) {}

export type RefListing = {
  readonly headBranch?: string;
  readonly headCommit?: string;
  readonly branches: ReadonlyMap<string, string>;
  /** Tag name to the commit the tag finally points at. */
  readonly tags: ReadonlyMap<string, string>;
};

export type TreeEntry = {
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly oid: string;
  readonly path: string;
};

/** One fetched revision: reads of its tree and blobs, backed by a scratch area. */
export type FetchSession = {
  readonly revision: string;
  /** Lists the tree under the pathspecs, recursively with directories, or everything for none. */
  readonly list: (
    pathspecs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<TreeEntry>, ImportFetchError>;
  /** Fetches the contents of whole directories in one batch. */
  readonly prefetch: (directories: ReadonlyArray<string>) => Effect.Effect<void, ImportFetchError>;
  /** Object sizes, for blobs that are present locally. */
  readonly sizes: (
    oids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, number>, ImportFetchError>;
  /** Exact blob bytes, never converted by attributes or filters. */
  readonly read: (
    oids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, Uint8Array>, ImportFetchError>;
  /** The tree IDs of folders at the revision, absent when a folder does not exist. */
  readonly treeIds: (
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, string>, ImportFetchError>;
};

export type ImportRemoteService = {
  readonly limits: ImportLimits;
  /** Reports the installed git version, or why git cannot be used. */
  readonly probe: Effect.Effect<{ readonly version: string }, ImportFetchError>;
  readonly listRefs: (target: RemoteTarget) => Effect.Effect<RefListing, ImportFetchError>;
  /** Fetches one commit into a scratch area that is removed when the scope closes. */
  readonly open: (
    target: RemoteTarget,
    revision: string,
  ) => Effect.Effect<FetchSession, ImportFetchError, Scope.Scope>;
};

/** The fetch boundary: the only place Tack talks to a remote. */
export class ImportRemote extends Context.Service<ImportRemote, ImportRemoteService>()(
  "tack/cli/platform/ImportRemote",
) {}
