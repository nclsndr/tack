import { Option, Schema } from "effect";
import { CheckReportSchema } from "../../../domain/check/check-schema.ts";
import { headerLines, hintLines, sections } from "./view.ts";
import type { HumanView } from "./render.ts";

/** Shows one combined file:line authoring report, using the same findings that determine exit status. */
export const renderCheck: HumanView = (envelope, style) => {
  const decoded = Schema.decodeUnknownOption(CheckReportSchema)(envelope.result);
  if (Option.isNone(decoded) === true) return undefined;
  const report = decoded.value;
  return sections(
    headerLines(envelope, undefined, style),
    [
      `Checks ${report.summary.checked} · errors ${report.summary.errors} · warnings ${report.summary.warnings}`,
    ],
    report.checks.flatMap((check) => [
      `${check.kind} ${style.path(check.path)}`,
      ...check.details.map((detail) => `  ${detail}`),
      "",
    ]),
    report.findings.flatMap((finding) => [
      `${style.path(finding.file)}:${finding.line}: ${finding.severity} ${finding.code}: ${finding.message}`,
      ...(finding.remedy === undefined ? [] : [`  Fix: ${finding.remedy}`]),
    ]),
    // A clean report has nothing left to repeat for.
    report.findings.length === 0
      ? []
      : ["Write files, run tack check with the relevant paths, and repeat until clean."],
    hintLines(envelope.next, style),
  );
};
