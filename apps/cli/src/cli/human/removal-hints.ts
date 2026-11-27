import type { RemovalPlan, RemovalResult } from "../../domain/reconciliation/removal-schema.ts";
import type { ManagedLinkTarget } from "../../domain/links/managed-link-schema.ts";
import { commandLine, selectorFlags } from "../envelope/command-line.ts";

/** Hints in first-seen order without repeats. */
export const uniqueHints = (hints: ReadonlyArray<string>) => [...new Set(hints)];

const targetKey = (target: ManagedLinkTarget) =>
  target._tag === "user" ? "user" : `project ${target.projectName}`;

/** Distinct targets in a stable order, so hints do not depend on action order. */
const distinctTargets = (targets: ReadonlyArray<ManagedLinkTarget>) =>
  [...new Map(targets.map((target) => [targetKey(target), target] as const)).entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, target]) => target);

/**
 * `tack state clean --pending` hints for the targets whose cleanup an application left unsettled. A project that
 * the application finished removing cannot be selected any more, so `except` names those.
 */
export const retryHints = (
  results: ReadonlyArray<RemovalResult>,
  except: ReadonlyArray<string> = [],
) =>
  distinctTargets(
    results.flatMap((result) =>
      result.actions.flatMap((outcome) =>
        outcome._tag === "applied" ? [] : [outcome.action.evidence.target],
      ),
    ),
  )
    .filter((target) => target._tag === "user" || !except.includes(target.projectName))
    .map((target) => commandLine("state-clean", "--pending", ...selectorFlags(target)));

/** `tack status` hints for the targets holding blocked actions of previews. */
export const blockedStatusHints = (plans: ReadonlyArray<RemovalPlan>) =>
  distinctTargets(
    plans.flatMap((plan) =>
      plan.actions.flatMap((action) => (action._tag === "blocked" ? [action.evidence.target] : [])),
    ),
  ).map((target) => commandLine("status", ...selectorFlags(target)));
