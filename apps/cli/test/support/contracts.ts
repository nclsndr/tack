import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { describeContracts } from "../../src/cli/commands/manifest.test-support.ts";

/**
 * The contracts of every executable command, read from the command tree the parser runs. Guidance
 * and payload checks derive from it because no command prints it.
 */
export const readContracts = () =>
  Effect.runPromise(describeContracts([]).pipe(Effect.provide(BunServices.layer)));
