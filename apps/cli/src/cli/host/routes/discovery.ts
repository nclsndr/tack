import { Effect } from "effect";
import { describeHelp } from "../../commands/index.ts";
import { resultOutcome } from "../outcomes.ts";
import { currentVersionReport } from "../../../version.ts";
import type { RoutesFor } from "./route.ts";

/** Help and version discovery, which describe the installed Tack without reading state. */
export const discoveryRoutes: RoutesFor<"help" | "version"> = {
  help: {
    needsHome: false,
    stateless: true,
    run: (invocation) => describeHelp(invocation.commandPath).pipe(Effect.map(resultOutcome)),
  },
  version: {
    needsHome: false,
    stateless: true,
    run: () => Effect.sync(() => resultOutcome(currentVersionReport())),
  },
};
