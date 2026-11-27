import { Effect, Path, Runtime, Schema } from "effect";
import type { PlatformError, Stdio } from "effect";
import type { Invocation } from "../commands/index.ts";
import type { StateOptions } from "../../services/state-store.ts";
import type { HostFailure } from "../envelope/errors.ts";
import type { PublicOutcome } from "../envelope/public-outcome.ts";
import type { RouteServices } from "../envelope/route-services.ts";

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
