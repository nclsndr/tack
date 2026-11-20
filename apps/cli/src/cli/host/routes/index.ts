import { checkRoutes } from "./check.ts";
import type { Invocation } from "../../commands/index.ts";
import { choiceRoutes } from "./choices.ts";
import { discoveryRoutes } from "./discovery.ts";
import { docsRoutes } from "./docs.ts";
import { executionRoutes } from "./execution.ts";
import { exploreRoutes } from "./explore.ts";
import { guideRoutes } from "./guides.ts";
import { typesRoutes } from "./types.ts";
import { importRoutes } from "./imports.ts";
import { maintenanceRoutes } from "./maintenance.ts";
import { projectRoutes } from "./projects.ts";
import { doctorRoutes } from "./doctor.ts";
import { docsReaderRoutes } from "./docs-reader.ts";
import { reconciliationRoutes } from "./reconciliation.ts";
import type { RoutesFor } from "./route.ts";
import { selfRoutes } from "./self.ts";
import { setupRoutes } from "./setup.ts";
import { sourceRoutes } from "./sources.ts";
import { profileRoutes } from "./profiles.ts";

export { PublicExit, type Route } from "./route.ts";

/**
 * Exactly one route per invocation kind. Envelope command names come from the command-path table
 * in `cli/commands/model.ts`, not from routes.
 */
export const routes: RoutesFor<Invocation["_tag"]> = {
  ...checkRoutes,
  ...choiceRoutes,
  ...discoveryRoutes,
  ...docsRoutes,
  ...executionRoutes,
  ...exploreRoutes,
  ...guideRoutes,
  ...typesRoutes,
  ...importRoutes,
  ...maintenanceRoutes,
  ...projectRoutes,
  ...docsReaderRoutes,
  ...doctorRoutes,
  ...reconciliationRoutes,
  ...selfRoutes,
  ...setupRoutes,
  ...sourceRoutes,
  ...profileRoutes,
};
