import { Context, Schema } from "effect";
import { Command } from "effect/cli";
import { booleanFlag } from "./flag-utils.ts";

/** Apply flag shared by mutating command families. */
export const applyFlag = booleanFlag("apply", "Apply the planned changes");

/** Envelope payload slots an operation can fill. */
type ResponseSlot = "applied" | "plan" | "result";

/** Mutation modes published by help and command discovery. */
export const MutationModeSchema = Schema.Literals([
  "read-only",
  "immediate",
  "preview-apply",
  "execute",
  "conditional",
]);

/** How an operation changes state. */
export type MutationMode = typeof MutationModeSchema.Type;

/** How an operation changes state and which envelope slots it can fill. */
export type OperationContract = {
  /** The slots a successful run without --apply may fill. */
  readonly slots: ReadonlyArray<ResponseSlot>;
  /** The slots an --apply run may fill, for preview-apply or conditional operations. */
  readonly applySlots?: ReadonlyArray<ResponseSlot>;
  /** preview-apply changes nothing without --apply; immediate persists at once. */
  readonly mutation: MutationMode;
};

/** Annotates each executable command with its {@link OperationContract} for help and schema. */
export class OperationContractAnnotation extends Context.Service<
  OperationContractAnnotation,
  OperationContract
>()("tack/cli/cli/commands/operation-contract/OperationContract") {}

/** Declares the operation contract of an executable command. */
export const operationContract = (contract: OperationContract) =>
  Command.annotate(OperationContractAnnotation, contract);
/** Marks a command as a read-only observation reported in `result`. */
export const readOnly = operationContract({ mutation: "read-only", slots: ["result"] });
/** Marks a command as an immediately persisted change reported in `applied`. */
export const immediate = operationContract({ mutation: "immediate", slots: ["applied"] });
/** Marks a command as a preview whose `--apply` run reports the plan and its application. */
export const previewApply = operationContract({
  mutation: "preview-apply",
  slots: ["plan"],
  applySlots: ["plan", "applied"],
});
