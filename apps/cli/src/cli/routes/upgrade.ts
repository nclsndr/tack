import { Effect } from "effect";
import { upgradeGuide } from "../../domain/self/upgrade-guide.ts";
import { Installation } from "../../services/installation.ts";
import { currentVersionReport } from "../../version.ts";
import { resultOutcome } from "../envelope/outcomes.ts";
import type { RoutesFor } from "./route.ts";

/** How to upgrade the running Tack. It reads no state and changes nothing. */
const guide = () => {
  const { version, stamp } = currentVersionReport();
  return Installation.use((installation) =>
    Effect.succeed(resultOutcome(upgradeGuide(installation.kind, version, stamp))),
  );
};

/** Tack never upgrades itself; these name the package manager command that does. */
export const upgradeRoutes: RoutesFor<"upgrade" | "upgrade-status"> = {
  upgrade: { needsHome: false, stateless: true, run: guide },
  "upgrade-status": { needsHome: false, stateless: true, run: guide },
};
