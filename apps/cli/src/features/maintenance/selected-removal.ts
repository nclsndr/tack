import { Effect, Schema } from "effect";

import {
  managedLinkTargetIdentity,
  type ManagedLinkTarget,
} from "../../domain/links/managed-link-schema.ts";
import { sortAndDedupeBy } from "../../domain/identity/ordering.ts";
import {
  selectionEcho,
  selectTargetsFromState,
  type ManagedTarget,
  type SelectionEcho,
} from "../projects/project.ts";
import { projectLifecycle, type TargetSelector } from "../../domain/projects/project-schema.ts";
import { runManagedRemoval, type RemovalExecution } from "../removal/removal.ts";
import { applyRemovalWithWriter } from "../removal/removal-apply.ts";
import { planRemovalFromState } from "../removal/removal-plan.ts";
import {
  RemovalPlanSchema,
  type RemovalPlan,
  type RemovalRequest,
} from "../../domain/reconciliation/removal-schema.ts";
import { ReconciliationSelectionSchema } from "../../domain/reconciliation/reconciliation-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";
import type { StateOptions } from "../../services/state-store.ts";
import { previewOrApply } from "../writer/recovered-writer.ts";

/** Invocation-scoped inputs for cleaning or retrying managed links on selected targets. */
export type SelectedRemovalOptions = {
  readonly apply?: boolean;
  readonly cwd: string;
  readonly selector: TargetSelector;
};

/** Invocation-scoped inputs for retrying pending cleanup obligations. */
export type RetryPendingRemovalOptions = SelectedRemovalOptions;

/** Invocation-scoped inputs for cleaning managed links from selected targets. */
export type CleanOptions = SelectedRemovalOptions;

/** Invocation-scoped reset inputs. Reset intentionally has no target selector. */
export type ResetOptions = {
  readonly apply?: boolean;
};

const removalTarget = (target: ManagedTarget): ManagedLinkTarget => {
  if (target._tag === "project-root" || target._tag === "user") return target;
  return target.pending._tag === "project"
    ? {
        _tag: "project-root",
        canonicalPath: target.pending.canonicalPath,
        projectName: target.pending.projectName,
      }
    : { _tag: "user", canonicalPath: target.pending.canonicalPath };
};

type SelectedRequest = { readonly request: RemovalRequest; readonly selection: SelectionEcho };

const selectedRequest = Effect.fnUntraced(function* (
  state: State,
  stateOptions: StateOptions,
  mode: "clean" | "retry",
  options: SelectedRemovalOptions,
) {
  const selection = yield* selectTargetsFromState(state, stateOptions, {
    cwd: options.cwd,
    selector: options.selector,
  });
  const echo = selectionEcho(selection);
  const selector =
    options.selector._tag === "bare"
      ? { _tag: "project" as const, projectName: echo.containingRoot!.projectName }
      : options.selector;
  if (mode === "retry" && selector._tag === "all") {
    return {
      request: { scope: { _tag: "maintenance" } },
      selection: echo,
    } satisfies SelectedRequest;
  }
  if (mode === "retry" && selector._tag === "project") {
    const selectedProject = state.data.projects.find(
      (project) => project.name === selector.projectName,
    );
    if (selectedProject !== undefined && projectLifecycle(selectedProject) === "removing") {
      return {
        request: { scope: { _tag: "project", projectName: selector.projectName } },
        selection: echo,
      } satisfies SelectedRequest;
    }
  }
  const targets = sortAndDedupeBy(
    selection.targets.map((target) => removalTarget(target)),
    managedLinkTargetIdentity,
  );
  return {
    request:
      mode === "retry"
        ? { scope: { _tag: "retry-targets", targets } }
        : { cause: "clean", scope: { _tag: "selected-targets", targets } },
    selection: echo,
  } satisfies SelectedRequest;
});

/**
 * The plan payload of `state clean`, with or without `--pending`, and of `state reset`: the removal
 * plan, with the selection echo a clean adds. A reset selects no targets, so it has none.
 */
export const SelectedRemovalPlanSchema = RemovalPlanSchema.mapFields(
  (fields) => ({ ...fields, selection: Schema.optionalKey(ReconciliationSelectionSchema) }),
  // The plan's checks read only the removal fields, which the echo leaves as they are.
  { unsafePreserveChecks: true },
);

/** A selected removal and the plan it produced, with the selection it was built for. */
export type SelectedRemovalExecution = RemovalExecution & {
  readonly plan: RemovalPlan & { readonly selection: SelectionEcho };
  /** The state document the removal was planned from. */
  readonly state: State;
};

const runSelectedRemoval = (
  stateOptions: StateOptions,
  mode: "clean" | "retry",
  options: SelectedRemovalOptions,
) =>
  previewOrApply(stateOptions, {
    apply: options.apply ?? false,
    plan: ({ state }) =>
      selectedRequest(state, stateOptions, mode, options).pipe(
        Effect.flatMap(({ request, selection }) =>
          planRemovalFromState(state, request).pipe(
            Effect.map((plan) => ({ plan, selection, state })),
          ),
        ),
      ),
    applyPlan: (writer, prepared) => applyRemovalWithWriter(writer, prepared.plan),
  }).pipe(
    Effect.map(({ applied, plan }): SelectedRemovalExecution => ({
      ...(applied === undefined ? {} : { applied }),
      plan: { ...plan.plan, selection: plan.selection },
      state: plan.state,
    })),
  );

/** Plans a clean by default, or removes exact verified links when apply is true. */
export const cleanManagedLinks = (stateOptions: StateOptions, options: CleanOptions) =>
  runSelectedRemoval(stateOptions, "clean", options);

/** Plans a scoped retry by default, or applies only retained pending obligations. */
export const retrySelectedPendingRemovals = (
  stateOptions: StateOptions,
  options: RetryPendingRemovalOptions,
) => runSelectedRemoval(stateOptions, "retry", options);

/** Plans a full reset by default, or applies it and deletes state after cleanup settles. */
export const resetTack = (stateOptions: StateOptions, options: ResetOptions = {}) =>
  runManagedRemoval(
    stateOptions,
    { cause: "reset", scope: { _tag: "reset" } },
    options.apply ?? false,
  );
