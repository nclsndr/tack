import { Context, Effect } from "effect";
import type { DestinationObservation } from "../domain/reconciliation/destination-observation-schema.ts";

/** Read-only access to managed-link destinations, resolved the way the host OS resolves links. */
export class Destination extends Context.Service<
  Destination,
  {
    /**
     * Returns the real directory against which the OS resolves relative link text written in
     * `directoryPath`. A directory that does not exist yet resolves below its nearest existing
     * ancestor, which is where creating it would place it.
     */
    readonly linkDirectory: (directoryPath: string) => Effect.Effect<string>;
    readonly observe: (destinationPath: string) => Effect.Effect<DestinationObservation>;
  }
>()("tack/cli/services/destination/Destination") {}

/** Observes one prospective managed destination through the configured adapter. */
export const observeDestination = Effect.fnUntraced(function* (destinationPath: string) {
  const destination = yield* Destination;
  return yield* destination.observe(destinationPath);
});

/** Resolves the real directory in which links created inside `directoryPath` are interpreted. */
export const resolveLinkDirectory = Effect.fnUntraced(function* (directoryPath: string) {
  const destination = yield* Destination;
  return yield* destination.linkDirectory(directoryPath);
});
