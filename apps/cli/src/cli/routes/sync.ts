import { Effect } from "effect";
import { agentLinkFolders } from "../../domain/agents/agent-layout.ts";
import { readInvocationSnapshot } from "../../features/snapshot/command-snapshot.ts";
import { Installation, type BuiltInsPruneRequest } from "../../services/installation.ts";
import type { SyncOptions } from "../../domain/reconciliation/sync-schema.ts";
import type { ReconcilePlanningRequest } from "../commands/model.ts";
import { runSyncCommand } from "../../features/reconciliation/sync-command.ts";
import type { StateOptions } from "../../services/state-store.ts";
import { syncOutcome } from "../envelope/outcomes.ts";
import { cwdOrCurrent, type RoutesFor, onlyUserOrAllSelector } from "./route.ts";

/** The narrowing flags a sync request carries, or none when it gave no such flag. */
const syncOptionsOf = (request: ReconcilePlanningRequest) => {
  const adapters = request.adapterOverride ?? [];
  const options = {
    ...(adapters.length === 0 ? {} : { adapters }),
    ...(request.includeOptional ? { includeOptional: true as const } : {}),
    ...(request.noDocs ? { noDocs: true as const } : {}),
    ...(request.requiredCapability === undefined
      ? {}
      : { requiredCapability: request.requiredCapability }),
  } satisfies SyncOptions;
  return Object.keys(options).length === 0 ? undefined : options;
};

// Coverage skip: only the packaged bundle, which the package gate runs, keeps built-ins copies.
/* v8 ignore start -- @preserve */
/**
 * After a package run applies a sync, removes the built-ins copies that neither this version nor a
 * link of this state needs. It is best effort and never changes the sync's outcome.
 */
const pruneUnlinkedBuiltIns = (
  stateOptions: StateOptions,
  prune: (request: BuiltInsPruneRequest) => Effect.Effect<void>,
) =>
  readInvocationSnapshot(stateOptions).pipe(
    Effect.flatMap(({ state }) => {
      const home = stateOptions.homeDirectory;
      if (home === undefined) return Effect.void;
      const folders = agentLinkFolders([
        { _tag: "user", canonicalPath: home },
        ...state.data.projects.flatMap((project) =>
          project.roots.map((path) => ({ _tag: "project-root" as const, canonicalPath: path })),
        ),
      ]);
      return prune({ home, folders });
    }),
    Effect.ignore,
  );
/** After an applied sync in a package run, prunes the built-ins copies nothing needs. */
export const afterSync = (stateOptions: StateOptions, applied: boolean) =>
  Installation.use((installation) =>
    applied === true && installation.pruneBuiltIns !== undefined
      ? pruneUnlinkedBuiltIns(stateOptions, installation.pruneBuiltIns)
      : Effect.void,
  );
/* v8 ignore stop -- @preserve */

const sync = (stateOptions: StateOptions, request: ReconcilePlanningRequest, apply: boolean) =>
  cwdOrCurrent(request.cwd).pipe(
    Effect.flatMap((cwd) =>
      runSyncCommand(stateOptions, {
        ...(request.adapterOverride === undefined
          ? {}
          : { adapterOverride: request.adapterOverride }),
        apply,
        cwd,
        includeOptional: request.includeOptional,
        noDocs: request.noDocs,
        ...(request.requiredCapability === undefined
          ? {}
          : { requiredCapability: request.requiredCapability }),
        selector: request.selector,
      }),
    ),
    Effect.tap((execution) => afterSync(stateOptions, execution.applied !== undefined)),
    Effect.map((execution) => syncOutcome(execution, syncOptionsOf(request))),
  );

/** Preview, then apply, the selected links and docs mounts. */
export const syncRoutes: RoutesFor<"sync"> = {
  sync: {
    needsHome: onlyUserOrAllSelector,
    run: (invocation, stateOptions) => sync(stateOptions, invocation, invocation.apply),
  },
};
