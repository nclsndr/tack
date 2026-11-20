import { commandEvidence } from "./command-evidence.ts";
import type { TrialResult } from "./campaign.ts";
import { executionOutcomes } from "./contract.ts";
import { plannedTrial, record } from "./plan.ts";

const cell = (value: unknown): string => {
  const text =
    value === null || value === undefined
      ? "unknown"
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
};
/** Render all cells with direct evidence links and explicit telemetry gaps. */
export function renderReport(results: readonly TrialResult[]): string {
  const rows = results.map((result) => {
    const metadata = result.execution?.metadata ?? {};
    const denials =
      metadata["budgetDenials"] === undefined ? undefined : record(metadata["budgetDenials"]);
    const usage = metadata["usage"] === undefined ? {} : record(metadata["usage"]);
    const image = metadata["image"] === undefined ? {} : record(metadata["image"]);
    const versions = image["agentVersions"] === undefined ? {} : record(image["agentVersions"]);
    const tokens = [
      usage["input"],
      usage["cachedInput"],
      usage["cacheWriteInput"],
      usage["output"],
      usage["reasoningOutput"],
    ]
      .map((value) => cell(value))
      .join(" / ");
    return `| ${[
      result.stage,
      result.taskId,
      `${result.profile.driver} (${cell(versions[result.profile.driver])})`,
      result.profile.model,
      metadata["observedModel"],
      result.profile.effort,
      result.arm,
      result.seed,
      result.outcome,
      result.pass === true ? "pass" : result.excluded === true ? "excluded" : "fail",
      result.score?.toFixed(2) ?? "unknown",
      metadata["wallMs"],
      `${cell(metadata["userTurns"])} / ${1 + result.followUps}`,
      metadata["nativeTurns"],
      `${cell(metadata["tackCommandCount"])} / ${cell(metadata["failedTackCommands"])}`,
      result.execution?.commands.length,
      denials === undefined
        ? undefined
        : [denials["toolCalls"], denials["outputBytes"], denials["busy"]]
            .map((value) => cell(value))
            .join(" / "),
      metadata["nativeOutputLimit"],
      tokens,
      usage["complete"] ?? false,
      result.execution?.costUsd,
    ]
      .map((value) => cell(value))
      .join(" | ")} | [evidence](${encodeURIComponent(result.id)}.json) |`;
  });
  const launched = results.filter((result) => result.execution !== null);
  const reported = launched.flatMap((result) =>
    result.execution?.costUsd === null || result.execution?.costUsd === undefined
      ? []
      : [result.execution.costUsd],
  );
  return [
    "# Tack agent evaluation",
    "",
    `${results.filter((result) => result.excluded === false).length} fresh scored trials. ${results.filter((result) => result.excluded === true).length} infrastructure exclusions or unstarted cells. No automatic retries.`,
    "",
    `Reported API-equivalent spend: $${reported.reduce((sum, cost) => sum + cost, 0).toFixed(2)} over ${reported.length} of ${launched.length} launched trials.`,
    "",
    "| Stage | Task | Agent | Requested model | Observed model | Effort | Arm | Seed | Execution | Correctness | Score | Wall ms | User turns (answered / sent) | Native turns | Tack commands (all / failed) | Tool calls | Budget denials (tool / output / busy) | Native output limit | Input / cache read / cache write / output / reasoning | Usage complete | API-equivalent USD | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "Cached input is part of total input. API-equivalent cost, when reported by the CLI, is not subscription allowance depletion. Unknown means unreported. Provider turn counts are not comparable. One pair is a smoke result, not evidence of a general treatment effect.",
    "",
  ].join("\n");
}
/** Validate saved result envelopes before reporting or selecting fixtures for regrading. */
export function savedResults(value: unknown): TrialResult[] {
  if (Array.isArray(value) === false) throw new Error("Expected saved result array");
  return value.map((item) => {
    const input = record(item);
    const outcome = executionOutcomes.find((candidate) => candidate === input["outcome"]);
    if (
      outcome === undefined ||
      typeof input["pass"] !== "boolean" ||
      typeof input["excluded"] !== "boolean" ||
      (input["score"] !== null && typeof input["score"] !== "number")
    )
      throw new Error("Invalid saved result");
    const execution = input["execution"] === null ? null : record(input["execution"]);
    const commands = execution?.["commands"];
    const costUsd = execution?.["costUsd"];
    if (
      execution !== null &&
      (Array.isArray(commands) === false ||
        typeof execution["finalAnswer"] !== "string" ||
        (costUsd !== null && typeof costUsd !== "number"))
    )
      throw new Error("Invalid saved execution");
    return {
      ...plannedTrial(input),
      outcome,
      score: input["score"],
      pass: input["pass"],
      excluded: input["excluded"],
      error: typeof input["error"] === "string" ? input["error"] : null,
      grade: null,
      execution:
        execution === null
          ? null
          : {
              outcome,
              finalAnswer: String(execution["finalAnswer"]),
              commands: Array.isArray(commands)
                ? commands.map((command) => commandEvidence(command))
                : [],
              costUsd: typeof costUsd === "number" ? costUsd : null,
              metadata: record(execution["metadata"]),
            },
    };
  });
}
