import { Effect } from "effect";
import { readInvocationSnapshot } from "../../features/snapshot/command-snapshot.ts";
import { registerProject } from "../../features/projects/project.ts";
import { runProjectRefreshCommand } from "../../features/refresh/project-refresh.ts";
import { removeProject } from "../../features/removal/project-removal.ts";
import { appliedAs, projectsOutcome, removalOutcome } from "../envelope/outcomes.ts";
import { cwdOrCurrent, type RoutesFor } from "./route.ts";

/** Project registration, inspection and refresh. */
export const projectRoutes: RoutesFor<
  "project-add" | "project-list" | "project-refresh" | "project-remove"
> = {
  "project-add": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      cwdOrCurrent(invocation.repositoryCwd).pipe(
        Effect.flatMap((repositoryCwd) =>
          registerProject(stateOptions, { name: invocation.name, repositoryCwd }),
        ),
        Effect.map(appliedAs("project-add")),
      ),
  },
  "project-list": {
    needsHome: false,
    run: (_, stateOptions) =>
      readInvocationSnapshot(stateOptions).pipe(
        Effect.flatMap((snapshot) => snapshot.projectInspections),
        Effect.map(projectsOutcome),
      ),
  },
  "project-remove": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      removeProject(stateOptions, invocation.name, { apply: invocation.apply }).pipe(
        Effect.map((execution) =>
          removalOutcome(execution, {
            planned: [execution.plan.removal],
            applied: execution.applied === undefined ? undefined : [execution.applied.removal],
          }),
        ),
      ),
  },
  "project-refresh": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      runProjectRefreshCommand(stateOptions, {
        apply: invocation.apply,
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        selector: invocation.selector,
      }).pipe(
        Effect.map((execution) =>
          removalOutcome(
            execution,
            { planned: execution.plan.removals, applied: execution.applied?.removals },
            (execution.applied ?? execution.plan).docs.complete === false
              ? [
                  {
                    code: "project-refresh-docs-partial",
                    message:
                      "Docs sync retains conflicts or unavailable resources. Run sync --no-adapters to inspect and repair.",
                  },
                ]
              : [],
          ),
        ),
      ),
  },
};
