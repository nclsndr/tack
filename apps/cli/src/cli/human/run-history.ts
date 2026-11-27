import { Option, Schema } from "effect";
import {
  historyListBounds,
  RunTargetSchema,
  type HistorySummary,
} from "../../domain/execution/execution-schema.ts";
import { commandLine, shellWord } from "../envelope/command-line.ts";
import { frameView } from "./frame.ts";
import type { HumanView } from "./render.ts";
import {
  finalizationFacts,
  logLines,
  logSummary,
  markOf,
  outcomeFact,
  paintOf,
  primaryValueBlock,
  shownLogCount,
  valueBlock,
} from "./run-script.ts";
import { instant, isRunId, period, withoutPayload } from "./run-text.ts";
import type { Style } from "./style.ts";
import { cell, paragraph, table, type Cell } from "./text.ts";
import { addressText, type FactRow, factRows, plural } from "./view.ts";

/** `✗ timeout (domain)`: the mark and the words that name a run's outcome, painted together. */
const outcomeCell = (run: HistorySummary, style: Style): Cell => {
  if (run.outcome === undefined)
    return cell(`… ${run.status === "pending" ? "pending" : "no outcome"}`, style.yellow);
  const { classification, code } = run.outcome;
  return cell(
    `${markOf(classification)} ${classification === "success" ? code : `${code} (${classification})`}`,
    paintOf(classification, style),
  );
};

/** One run per row of a table: the rows stack when the terminal is too narrow for the columns. */
const runLines = (runs: ReadonlyArray<HistorySummary>, style: Style): ReadonlyArray<string> =>
  table(
    runs.map((run) => [
      outcomeCell(run, style),
      cell(run.runId),
      cell(addressText(run.address, style)),
      cell(period(run.startedAt, run.finishedAt)),
    ]),
    { width: style.width },
  );

const pageFlags = (limit: number, offset: number) => [
  ...(limit === historyListBounds.defaultLimit ? [] : ["--limit", String(limit)]),
  ...(offset === 0 ? [] : ["--offset", String(offset)]),
];

/** Retained run summaries newest first, with the paging facts and any skipped record files. */
export const historyListView: HumanView<"script-history-list"> = (envelope, { result }, style) => {
  if (envelope.result === null) return withoutPayload(envelope, style);
  if (Option.isNone(result) === true) return undefined;
  const list = result.value;

  const first = list.runs[0];
  const range =
    first === undefined
      ? list.total === 0
        ? "No retained runs."
        : `No runs at offset ${list.offset}; ${plural(list.total, "run")} retained.`
      : `Runs ${list.offset + 1}-${list.offset + list.runs.length} of ${list.total}, newest first.`;
  const paging = `limit ${list.limit}, offset ${list.offset}${list.truncated ? ", more runs follow" : ""}`;
  const next = list.offset + list.runs.length;
  const previous = Math.max(0, list.offset - list.limit);
  const hints = [
    ...(list.truncated && first !== undefined
      ? [commandLine("script-history-list", ...pageFlags(list.limit, next))]
      : []),
    ...(list.offset > 0
      ? [commandLine("script-history-list", ...pageFlags(list.limit, previous))]
      : []),
    ...(first !== undefined && isRunId(first.runId)
      ? [commandLine("script-history-show", first.runId)]
      : []),
  ];

  return frameView(envelope, style, {
    body: [
      [
        ...paragraph(range, { width: style.width }),
        ...paragraph(`Page: ${paging}.`, { width: style.width, paint: style.dim }),
      ],
      list.runs.length === 0 ? undefined : runLines(list.runs, style),
      list.issues.length === 0
        ? undefined
        : [
            style.bold(`Skipped records (${list.issues.length})`),
            ...list.issues.flatMap((issue) => [
              `  ${style.yellow("!")} ${issue.reason}`,
              ...paragraph(style.path(issue.path), { width: style.width, indent: 4 }),
            ]),
          ],
    ],
    hints,
  });
};

const decodeTarget = Schema.decodeUnknownOption(RunTargetSchema);

/** One retained run in full; large values are cut to the width with a pointer to `--json`. */
export const historyShowView: HumanView<"script-history-show"> = (envelope, payloads, style) => {
  if (envelope.result === null)
    return withoutPayload(
      envelope,
      style,
      envelope.diagnostics.some((diagnostic) => diagnostic.code === "history-not-found")
        ? [commandLine("script-history-list")]
        : [],
    );
  if (Option.isNone(payloads.result) === true) return undefined;
  const record = payloads.result.value;
  const { result } = record;

  const target =
    record.target === undefined ? undefined : Option.getOrUndefined(decodeTarget(record.target));
  const input =
    record.originalWords !== undefined
      ? valueBlock("Arguments", record.originalWords.map(shellWord).join(" "), style)
      : record.originalInput === undefined
        ? undefined
        : valueBlock("Input", record.originalInput, style);
  const targetBlock =
    record.target === undefined || target !== undefined
      ? undefined
      : valueBlock("Target", record.target, style);
  const value = primaryValueBlock(result?.core, style);
  const evidence =
    record.diagnostics === undefined
      ? undefined
      : valueBlock("Run diagnostics", record.diagnostics, style);
  const moreLogs = result === undefined ? 0 : Math.max(0, result.logs.length - shownLogCount);
  const truncated =
    [input, targetBlock, value, evidence].some((block) => block?.truncated === true) ||
    moreLogs > 0;

  const rows: ReadonlyArray<FactRow> = [
    ["Run", [cell(record.runId)]],
    ["Script", [cell(addressText(record.address, style))]],
    [
      "Status",
      [
        record.status === "pending"
          ? cell("pending; no result is recorded yet", style.yellow)
          : cell("complete"),
      ],
    ],
    ["Started", [cell(instant(record.startedAt))]],
    ...(record.finishedAt === undefined
      ? []
      : ([["Finished", [cell(instant(record.finishedAt))]]] satisfies ReadonlyArray<FactRow>)),
    ...(target === undefined
      ? []
      : ([
          [
            "Target",
            [
              cell(
                target._tag === "user"
                  ? `user · ${style.path(target.canonicalPath)}`
                  : `project ${target.projectName} · ${style.path(target.canonicalPath)}`,
              ),
            ],
          ],
        ] satisfies ReadonlyArray<FactRow>)),
    ...(result === undefined
      ? []
      : ([
          outcomeFact(result.outcome, style),
          ["Message", [cell(result.outcome.message)]],
          ...finalizationFacts(result, style),
        ] satisfies ReadonlyArray<FactRow>)),
  ];

  return frameView(envelope, style, {
    body: [
      factRows(rows, style),
      input?.lines,
      targetBlock?.lines,
      value?.lines,
      result === undefined
        ? undefined
        : [
            style.bold("Logs"),
            ...logSummary(result, style),
            ...logLines(result, style),
            ...(moreLogs > 0
              ? [`  ${style.dim(`… ${plural(moreLogs, "more event")} not shown`)}`]
              : []),
          ],
      evidence?.lines,
      truncated
        ? paragraph("Some values are cut to fit; --json prints the full record.", {
            width: style.width,
          })
        : undefined,
    ],
  });
};
