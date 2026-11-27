import { adapterRoutes } from "./adapter.ts";
import { checkRoutes } from "./check.ts";
import type { Invocation } from "../../commands/index.ts";
import { discoveryRoutes } from "./discovery.ts";
import { docsRoutes } from "./docs.ts";
import { docsReaderRoutes } from "./docs-reader.ts";
import { doctorRoutes } from "./doctor.ts";
import { exploreRoutes } from "./explore.ts";
import { guideRoutes } from "./guide.ts";
import { importRoutes } from "./imports.ts";
import { initRoutes } from "./init.ts";
import { pickRoutes } from "./pick.ts";
import { profileRoutes } from "./profiles.ts";
import { projectRoutes } from "./projects.ts";
import type { RoutesFor } from "./route.ts";
import { scriptRoutes } from "./script.ts";
import { sourceRoutes } from "./sources.ts";
import { stateRoutes } from "./state.ts";
import { statusRoutes } from "./status.ts";
import { syncRoutes } from "./sync.ts";
import { typesRoutes } from "./types.ts";
import { upgradeRoutes } from "./upgrade.ts";

export { PublicExit, type Route } from "./route.ts";

/**
 * Exactly one route per invocation kind. Envelope command names come from the command
 * declarations in `cli/commands/declarations.ts`, not from routes.
 */
export const routes: RoutesFor<Invocation["_tag"]> = {
  ...adapterRoutes,
  ...checkRoutes,
  ...discoveryRoutes,
  ...docsRoutes,
  ...docsReaderRoutes,
  ...doctorRoutes,
  ...exploreRoutes,
  ...guideRoutes,
  ...importRoutes,
  ...initRoutes,
  ...pickRoutes,
  ...profileRoutes,
  ...projectRoutes,
  ...scriptRoutes,
  ...sourceRoutes,
  ...stateRoutes,
  ...statusRoutes,
  ...syncRoutes,
  ...typesRoutes,
  ...upgradeRoutes,
};
