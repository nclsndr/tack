import { Context, Effect, Schema } from "effect";
import type { ReaderProjectInput } from "@tackup/reader/search-core";

/** One resolved worktree reader startup request. */
export type ReaderOptions = {
  readonly input: ReaderProjectInput;
  /** The project's reader cache, which this session holds; without it the reader builds cold. */
  readonly cacheDirectory?: string;
  readonly port?: number;
  readonly open: boolean;
};

/** A live reader resource released when its foreground command stops. */
type ReaderSession = {
  readonly url: string;
  readonly close: Effect.Effect<void>;
  readonly closed?: Effect.Effect<void, ReaderStartupError>;
};

/** An actionable startup error safe for the CLI's public diagnostics. */
export class ReaderStartupError extends Schema.TaggedError<ReaderStartupError>()(
  "ReaderStartupError",
  {
    kind: Schema.Literals(["configuration", "port-in-use", "engine"]),
    message: Schema.String,
  },
) {}

/** Replaces the reader server lifecycle in host tests. */
export type ReaderService = {
  readonly start: (options: ReaderOptions) => Effect.Effect<ReaderSession, ReaderStartupError>;
};

/** Local document reader capability. */
export class Reader extends Context.Service<Reader, ReaderService>()(
  "tack/cli/services/reader/Reader",
) {}
