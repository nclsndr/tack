import type { CommandEvidence } from "./contract.ts";
import { record } from "./plan.ts";

/** Decodes retained process observations without accepting incomplete output as proof. */
export function commandEvidence(value: unknown): CommandEvidence {
  const input = record(value);
  if (
    Array.isArray(input["argv"]) === false ||
    input["argv"].some((arg) => typeof arg !== "string") ||
    typeof input["cwd"] !== "string" ||
    typeof input["exitCode"] !== "number" ||
    typeof input["stdout"] !== "string" ||
    typeof input["stderr"] !== "string" ||
    input["truncated"] === true
  )
    throw new Error("Invalid or truncated command evidence");
  const executions = input["executions"];
  if (executions !== undefined && Array.isArray(executions) === false)
    throw new Error("Invalid process observations");
  return {
    argv: input["argv"].filter((arg): arg is string => typeof arg === "string"),
    cwd: input["cwd"],
    exitCode: input["exitCode"],
    stdout: input["stdout"],
    stderr: input["stderr"],
    ...(Array.isArray(executions)
      ? { executions: executions.map((item) => commandEvidence(item)) }
      : {}),
  };
}
