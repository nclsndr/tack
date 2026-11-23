import { Effect } from "effect";
import type { StateOptions } from "../../src/services/state-store.ts";
import { runManagedRemoval } from "../../src/features/removal/removal.ts";
import type { RemovalRequest } from "../../src/domain/reconciliation/removal-schema.ts";

/** Previews one removal request through the production preview path, without writing state. */
export const planRemovalAt = (stateOptions: StateOptions, request: RemovalRequest) =>
  runManagedRemoval(stateOptions, request, false).pipe(Effect.map((execution) => execution.plan));

/** Removes one project root, retaining it in the removing lifecycle until cleanup settles. */
export const removeProjectRoot = (
  stateOptions: StateOptions,
  options: {
    readonly apply: boolean;
    readonly canonicalRoot: string;
    readonly projectName: string;
  },
) =>
  runManagedRemoval(
    stateOptions,
    {
      cause: "root-removal",
      scope: {
        _tag: "project-root",
        canonicalRoot: options.canonicalRoot,
        projectName: options.projectName,
      },
    },
    options.apply,
  );

/** Removes a whole project namespace only after every recorded destination settles. */
export const removeProject = (
  stateOptions: StateOptions,
  options: { readonly apply: boolean; readonly projectName: string },
) =>
  runManagedRemoval(
    stateOptions,
    { cause: "project-removal", scope: { _tag: "project", projectName: options.projectName } },
    options.apply,
  );

/** Retries all retained pending obligations without widening their recorded ownership. */
export const retryPendingRemovals = (
  stateOptions: StateOptions,
  options: { readonly apply: boolean },
) => runManagedRemoval(stateOptions, { scope: { _tag: "maintenance" } }, options.apply);
