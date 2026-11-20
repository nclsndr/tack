import { Option, Schema } from "effect";
import {
  executionLimits,
  type OperatorRunResult,
  type RunFailure,
  RunFailureSchema,
  RunResultSchema,
} from "../../../domain/execution/execution-schema.ts";
import { commandLine } from "../command-line.ts";
import { frameView, isRecord } from "./frame.ts";
import type { HumanView } from "./render.ts";
import {
  formatBytes,
  isRunId,
  oneLine,
  timeOfDay,
  valueLines,
  withoutPayload,
} from "./run-text.ts";
import type { Style } from "./style.ts";
import { cell, paragraph, truncate } from "./text.ts";
import { type FactRow, factRows, plural } from "./view.ts";

const decodeRun = Schema.decodeUnknownOption(RunResultSchema);
const decodeFailure = Schema.decodeUnknownOption(RunFailureSchema);

export const markOf = (classification: RunFailure["classification"]) =>
  classification === "success" ? "✓" : classification === "interruption" ? "!" : "✗";

export const paintOf = (classification: RunFailure["classification"], style: Style) =>
  classification === "success"
    ? style.green
    : classification === "interruption"
      ? style.yellow
      : style.red;

/** `✗ timeout at execution stage (domain)`: the code and stage, never color alone. */
const outcomeText = (outcome: RunFailure) =>
  `${markOf(outcome.classification)} ${outcome.code} at ${outcome.stage} stage${
    outcome.classification === "success" ? "" : ` (${outcome.classification})`
  }`;

export const outcomeFact = (outcome: RunFailure, style: Style): FactRow => [
  "Outcome",
  [cell(outcomeText(outcome), paintOf(outcome.classification, style))],
];

/** Finalization and, when the supervisor ended the run, how it was terminated. */
export const finalizationFacts = (
  result: OperatorRunResult,
  style: Style,
): ReadonlyArray<FactRow> => [
  [
    "Finalization",
    [
      cell(
        result.finalization === "not-started" ? "not started" : result.finalization,
        result.finalization === "incomplete" ? style.yellow : undefined,
      ),
    ],
  ],
  ...(result.termination === undefined
    ? []
    : ([
        [
          "Termination",
          [cell(`${result.termination.reason}${result.termination.forced ? " (forced)" : ""}`)],
        ],
      ] satisfies ReadonlyArray<FactRow>)),
];

const sourceOrder = ["stdout", "stderr", "effect", "shell", "supervisor"] as const;

/** The log display limits: what was kept and observed, whether it was cut, and the limits. */
export const logSummary = (result: OperatorRunResult, style: Style): ReadonlyArray<string> => {
  const { logs, logTruncation } = result;
  const perSource = sourceOrder
    .map((source) => [source, logs.filter((log) => log.source === source).length] as const)
    .filter(([, count]) => count > 0)
    .map(([source, count]) => `${source} ${count}`);
  const limits = `${plural(executionLimits.logEvents, "event")} and ${formatBytes(executionLimits.logBytes)}`;
  const kept = `${logs.length} of ${plural(logTruncation.observedEvents, "event")} kept, ${formatBytes(logTruncation.observedBytes)} observed${
    perSource.length === 0 ? "" : ` (${perSource.join(", ")})`
  }`;
  const status = logTruncation.truncated
    ? `Truncated${logTruncation.reasons.length === 0 ? "" : ` (${logTruncation.reasons.join(", ")})`}; the limits are ${limits}.`
    : `Not truncated; the limits are ${limits}.`;
  return [
    ...paragraph(kept, { width: style.width, indent: 2 }),
    ...paragraph(status, {
      width: style.width,
      indent: 2,
      ...(logTruncation.truncated ? { paint: style.yellow } : {}),
    }),
  ];
};

/** The primary value, compact when it fits and otherwise cut to a few lines. */
export const valueBlock = (
  title: string,
  value: unknown,
  style: Style,
): { readonly lines: ReadonlyArray<string>; readonly truncated: boolean } => {
  const shown = valueLines(value, style, { indent: "  ", maxLines: 12 });
  return { lines: [style.bold(title), ...shown.lines], truncated: shown.truncated };
};

const decodePrimary = Schema.decodeUnknownOption(
  Schema.Struct({
    primary: Schema.Struct({
      status: Schema.Literals(["success", "failure"]),
      encoded: Schema.optionalKey(Schema.Json),
    }),
  }),
);

/**
 * The script's own result inside the worker's core outcome: the value it returned, or the encoded
 * failure it raised. The status, stage and code around it are already the Outcome row.
 */
export const primaryValueBlock = (core: unknown, style: Style) => {
  const primary = Option.getOrUndefined(decodePrimary(core))?.primary;
  if (primary === undefined || Object.hasOwn(primary, "encoded") === false) return undefined;
  return valueBlock(
    primary.status === "success" ? "Value" : "Failure value",
    primary.encoded,
    style,
  );
};

/** What the envelope says about the run's retained record. */
const historyStatus = (result: OperatorRunResult, style: Style): FactRow => {
  const { outcome } = result;
  if (outcome.stage === "history")
    return ["History", [cell("not saved; the history write failed", style.red)]];
  if (outcome.code === "state_not_initialized")
    return ["History", [cell("no record; Tack state is not initialized")]];
  return ["History", [cell("full record saved")]];
};

/** The outcome of a run whose history write failed is nested under the history failure. */
const runOutcomeBeforeHistory = (result: OperatorRunResult): RunFailure | undefined => {
  if (result.outcome.stage !== "history") return undefined;
  const nested = result.outcome.details;
  return isRecord(nested) ? Option.getOrUndefined(decodeFailure(nested["runOutcome"])) : undefined;
};

/** One script run: outcome and stage, finalization, history status, value and log limits. */
export const scriptRunView: HumanView = (envelope, style) => {
  if (envelope.result === null) return withoutPayload(envelope, style);
  const result = Option.getOrUndefined(decodeRun(envelope.result));
  if (result === undefined) return undefined;

  const { outcome } = result;
  const reported = envelope.diagnostics.some(
    (diagnostic) => diagnostic.code === outcome.code && diagnostic.message === outcome.message,
  );
  const before = runOutcomeBeforeHistory(result);
  const saved = outcome.stage !== "history" && outcome.code !== "state_not_initialized";
  const value = primaryValueBlock(result.core, style);

  return frameView(envelope, style, {
    body: [
      factRows(
        [
          ["Run", [cell(result.runId)]],
          outcomeFact(outcome, style),
          ...(reported
            ? []
            : ([["Message", [cell(outcome.message)]]] satisfies ReadonlyArray<FactRow>)),
          ...(before === undefined
            ? []
            : ([
                [
                  "Run outcome",
                  [
                    cell(
                      `${outcomeText(before)}: ${before.message}`,
                      paintOf(before.classification, style),
                    ),
                  ],
                ],
              ] satisfies ReadonlyArray<FactRow>)),
          ...finalizationFacts(result, style),
          historyStatus(result, style),
        ],
        style,
      ),
      value === undefined
        ? undefined
        : [
            ...value.lines,
            ...(value.truncated
              ? paragraph("Value cut to fit; --json prints the whole report.", {
                  width: style.width,
                  indent: 2,
                  paint: style.dim,
                })
              : []),
          ],
      [style.bold("Logs"), ...logSummary(result, style)],
    ],
    hints: saved && isRunId(result.runId) ? [commandLine("history-show", result.runId)] : [],
  });
};

/** How many log events one history record view lists before pointing at `--json`. */
export const shownLogCount = 20;

/** The log events kept in a record, one truncated line each. */
export const logLines = (result: OperatorRunResult, style: Style): ReadonlyArray<string> =>
  result.logs.slice(0, shownLogCount).map((log) => {
    const prefix = `  #${log.sequence} ${log.source} ${timeOfDay(log.timestamp)}  `;
    return `${prefix}${truncate(oneLine(log.content), Math.max(10, style.width - prefix.length))}`;
  });
