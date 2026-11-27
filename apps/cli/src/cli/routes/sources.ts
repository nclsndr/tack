import { Effect } from "effect";
import { listSources, resolveCatalogWithImports } from "../../features/imports/import-display.ts";
import { catalogReport } from "../../domain/sources/catalog-report.ts";
import { relocateSource } from "../../features/sources/source.ts";
import { removeSource } from "../../features/removal/source-removal.ts";
import { sourceAddOutcome } from "./source-add.ts";
import { appliedAs, catalogOutcome, removalOutcome, sourcesOutcome } from "../envelope/outcomes.ts";
import type { RoutesFor } from "./route.ts";

/** Source registration and the resolved catalog. */
export const sourceRoutes: RoutesFor<
  "catalog" | "source-add" | "source-list" | "source-relocate" | "source-remove"
> = {
  "source-add": {
    needsHome: false,
    run: (invocation, stateOptions) => sourceAddOutcome(stateOptions, invocation),
  },
  "source-relocate": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      relocateSource(stateOptions, invocation).pipe(Effect.map(appliedAs("source-relocate"))),
  },
  "source-remove": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      removeSource(stateOptions, invocation.source, { apply: invocation.apply }).pipe(
        Effect.map((execution) =>
          removalOutcome(execution, {
            planned: [execution.plan.removal],
            applied: execution.applied === undefined ? undefined : [execution.applied.removal],
          }),
        ),
      ),
  },
  "source-list": {
    needsHome: false,
    run: (_, stateOptions) => listSources(stateOptions).pipe(Effect.map(sourcesOutcome)),
  },
  catalog: {
    needsHome: false,
    run: (invocation, stateOptions) =>
      resolveCatalogWithImports(stateOptions).pipe(
        Effect.map(({ catalog, display }) =>
          catalogOutcome(
            catalogReport(catalog, {
              details: invocation.details,
              imported: display.byDirectory,
              ...(invocation.kind === undefined ? {} : { scope: invocation.kind }),
            }),
          ),
        ),
      ),
  },
};
