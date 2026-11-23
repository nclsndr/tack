import { Effect, type FileSystem, Path, Runtime, Schema } from "effect";
import type { PlatformError, Scope, Stdio } from "effect";
import type { Command } from "effect/cli";
import type { SecureRandom } from "effect/crypto";
import type { Invocation } from "../../commands/index.ts";
import type { BundleScanner } from "../../../services/bundle-scanner.ts";
import type { Compression } from "../../../services/compression.ts";
import type { Destination } from "../../../services/destination.ts";
import type { Source } from "../../../features/sources/source.ts";
import type { ExecutionWorker, RunHistory } from "../../../services/execution-platform.ts";
import type { Git } from "../../../services/git.ts";
import type { ImportRemote } from "../../../services/import-remote.ts";
import type { Installation } from "../../../services/installation.ts";
import type { Reader } from "../../../services/reader.ts";
import type { ReaderCorpus } from "../../../services/reader-corpus.ts";
import type { StateOptions, StateStore } from "../../../services/state-store.ts";
import type { HostFailure } from "../errors.ts";
import type { PublicOutcome } from "../public-outcome.ts";

/** Ends a fully rendered command with the stable process status chosen by its public envelope. */
export class PublicExit extends Schema.TaggedError<PublicExit>()("PublicExit", {
  exitCode: Schema.Literals([1, 2, 3, 130]),
}) {
  override readonly [Runtime.errorExitCode] = this.exitCode;
  override readonly [Runtime.errorReported] = true;
}

/**
 * A long-running operation, such as the reader: its outcome is rendered first, then `serve` runs
 * in the route's scope until the session ends and itself ends the process.
 */
export type ForegroundSession = {
  readonly outcome: PublicOutcome;
  readonly serve: Effect.Effect<never, PlatformError.PlatformError | PublicExit, Stdio.Stdio>;
};

/** The services a route may use; the composition root provides them all. */
export type RouteServices =
  | BundleScanner
  | Command.Environment
  | Compression
  | Destination
  | ExecutionWorker
  | FileSystem.FileSystem
  | Git
  | ImportRemote
  | Installation
  | Path.Path
  | Reader
  | ReaderCorpus
  | RunHistory
  | SecureRandom.SecureRandom
  | Scope.Scope
  | Source
  | StateStore;

/** How the host runs one invocation kind. */
export type Route<I extends Invocation> = {
  /**
   * Whether the operator home is needed beyond locating default state, because the user target
   * may be selected. The host reads HOME when this holds or when no state directory is configured.
   */
  readonly needsHome: boolean | ((invocation: I) => boolean);
  /** Set when the operation never reads Tack state, so the host resolves no state location. */
  readonly stateless?: true;
  /** Set when the operation owns interruption until its own terminal output settles. */
  readonly ownsInterruption?: true;
  readonly run: (
    invocation: I,
    stateOptions: StateOptions,
  ) => Effect.Effect<PublicOutcome | ForegroundSession, HostFailure, RouteServices>;
};

/** The routes for a set of invocation tags, one per tag. */
export type RoutesFor<Tag extends Invocation["_tag"]> = {
  readonly [K in Tag]: Route<Extract<Invocation, { readonly _tag: K }>>;
};

/** Only user and all selectors need the operator home to address the user target. */
export const onlyUserOrAllSelector = (invocation: {
  readonly selector: { readonly _tag: string };
}) => invocation.selector["_tag"] === "user" || invocation.selector["_tag"] === "all";

/** Resolves an omitted `--cwd` to the process working directory. */
export const cwdOrCurrent = Effect.fnUntraced(function* (cwd: string | undefined) {
  return cwd ?? (yield* Path.Path).resolve(".");
});
