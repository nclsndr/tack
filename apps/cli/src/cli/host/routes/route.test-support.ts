import { Effect } from "effect";
import { Git } from "../../../services/git.ts";
import type { PublicOutcome } from "../public-outcome.ts";
import type { ForegroundSession } from "./route.ts";

/** The public outcome of one route run; a foreground session fails the test instead. */
export const outcomeOf = <E, R>(effect: Effect.Effect<PublicOutcome | ForegroundSession, E, R>) =>
  Effect.flatMap(effect, (value) =>
    "serve" in value
      ? Effect.die(new Error("The route started a foreground session."))
      : Effect.succeed(value),
  );

const unusedGit = Git.of({
  listWorktrees: () => Effect.die(new Error("This route test reads no repository.")),
  resolveCommonDirectory: () => Effect.die(new Error("This route test reads no repository.")),
});

/** Provides a Git that fails the test if a route reaches for a repository. */
const withoutGit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Git, unusedGit);

/** The public outcome of one route run that never reads a repository. */
export const routeOutcome = <E, R>(
  effect: Effect.Effect<PublicOutcome | ForegroundSession, E, R>,
) => withoutGit(outcomeOf(effect));
