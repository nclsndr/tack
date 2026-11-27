import { Option } from "effect";
import type { DoctorCheck, DoctorReport } from "../../domain/doctor/doctor-schema.ts";
import { argvLine } from "../../domain/hints/next-commands.ts";
import { frameView } from "./frame.ts";
import { indented } from "./inspection-support.ts";
import type { HumanView } from "./render.ts";
import type { Style } from "./style.ts";
import { cell, flow } from "./text.ts";
import { headingLines, plural } from "./view.ts";

const markOf = (check: DoctorCheck, style: Style) =>
  check.outcome === "failed"
    ? cell("✗", style.red)
    : check.outcome === "warning"
      ? cell("!", style.yellow)
      : check.outcome === "ok"
        ? cell("✓", style.green)
        : cell("–", style.dim);

const commandOf = (check: DoctorCheck) =>
  check.next === undefined ? undefined : argvLine(check.next);

/** One check: its mark and ID, its message under it, then the exact command that addresses it. */
const checkLines = (check: DoctorCheck, style: Style): ReadonlyArray<string> => [
  ...flow([markOf(check, style), cell(check.id)], { width: style.width, indent: 2, hang: 4 }),
  ...indented(check.message, 4, style),
  ...(commandOf(check) === undefined ? [] : [`    ${style.cyan(commandOf(check) ?? "")}`]),
];

const countsText = (report: DoctorReport) =>
  [
    report.release.stamp,
    ...(report.summary.failed === 0 ? [] : [`${report.summary.failed} failed`]),
    ...(report.summary.warning === 0 ? [] : [plural(report.summary.warning, "warning")]),
    `${report.summary.ok} ok`,
    ...(report.summary.skipped === 0 ? [] : [`${report.summary.skipped} skipped`]),
  ].join(" · ");

/**
 * Renders `doctor`: the release stamp and counts first, then the problems with the command that
 * addresses each, then what was fine or not observed. Failed checks are shown once, as checks.
 */
export const renderDoctor: HumanView<"doctor"> = (envelope, { result }, style) => {
  if (Option.isNone(result) === true) return undefined;
  const report = result.value;
  const problems = report.checks.filter(
    ({ outcome }) => outcome === "failed" || outcome === "warning",
  );
  const quiet = report.checks.filter(({ outcome }) => outcome === "ok" || outcome === "skipped");
  const commands = [
    ...new Set(
      problems.flatMap((check) => (commandOf(check) === undefined ? [] : [commandOf(check) ?? ""])),
    ),
  ];
  return frameView(
    {
      ...envelope,
      diagnostics: envelope.diagnostics.filter(({ code }) => code !== "doctor-check-failed"),
    },
    style,
    {
      scope: countsText(report),
      body: [
        problems.length === 0
          ? [style.green("No problems found.")]
          : [
              ...headingLines("Problems", plural(problems.length, "check"), style),
              ...problems.flatMap((check) => checkLines(check, style)),
            ],
        quiet.length === 0
          ? undefined
          : [style.bold("Checked"), ...quiet.flatMap((check) => checkLines(check, style))],
      ],
      hints: commands,
    },
  );
};
