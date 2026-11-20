import type { SyncOptions, SyncPlanSchema } from "../../../domain/reconciliation/sync-schema.ts";

/**
 * The words that repeat a sync preview's narrowing flags on its next command, in the order the
 * command lists them. `--no-adapters` is not in the options: a preview without resources has it.
 */
export const syncFlagWords = (
  plan: Pick<typeof SyncPlanSchema.Type, "resources"> & { readonly options?: SyncOptions },
): ReadonlyArray<string> => {
  const { adapters = [], includeOptional, noDocs, requiredCapability } = plan.options ?? {};
  return [
    ...adapters.flatMap((adapter) => ["--adapter", adapter]),
    ...(requiredCapability === undefined ? [] : ["--require-capability", requiredCapability]),
    ...(includeOptional === true ? ["--include-optional"] : []),
    ...(plan.resources === null ? ["--no-adapters"] : []),
    ...(noDocs === true ? ["--no-docs"] : []),
  ];
};
