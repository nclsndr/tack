/**
 * What a plan-and-apply command returns: its plan and, after an explicit `--apply`, the outcome
 * produced from that same plan.
 */
export type PreviewOrApplied<Plan, Applied> = {
  readonly applied?: Applied;
  readonly plan: Plan;
};
