import { Option, Schema } from "effect";
import type { SourceCheckReport, SourceFinding } from "../../../domain/sources/source-check.ts";
import { SourceScaffoldPlanSchema } from "../../../features/sources/source-scaffold.ts";
import type { HumanView } from "./render.ts";
import { diagnosticLines, headerLines, hintLines, kindPlurals, sections, plural } from "./view.ts";
import { ResourceKindSchema, resourceKinds } from "../../../domain/resources/kinds.ts";
import type { Style } from "./style.ts";
import { paragraph } from "./text.ts";

/** One finding: its severity, code and message, then the file and field it concerns. */
const findingLines = (finding: SourceFinding, style: Style): ReadonlyArray<string> => [
  `${finding.severity}: ${finding.code}: ${finding.message}`,
  `  ${style.path(finding.file)}${finding.field === undefined ? "" : ` · ${finding.field}`}`,
  ...(finding.candidatePath === undefined || finding.candidatePath === finding.file
    ? []
    : [`  ${style.path(finding.candidatePath)}`]),
];

/** Counts and reported findings shared by check and registration. */
export const sourceCheckLines = (
  report: SourceCheckReport,
  style: Style,
): ReadonlyArray<string> => [
  ResourceKindSchema.literals
    .map((kind) => plural(report.counts[kind], kind, kindPlurals[kind]))
    .join(" · "),
  ...report.findings.flatMap((finding) => findingLines(finding, style)),
];

const decodeScaffold = Schema.decodeUnknownOption(SourceScaffoldPlanSchema);

/**
 * A declaration that kind flags describe is always shown before --apply writes it: the file, then
 * what each entry finds, with the names of its resources and its problems, then why it would not
 * apply when it loads nothing.
 */
export const renderSourceScaffold: HumanView = (envelope, style) => {
  if (envelope.applied !== null) return undefined;
  const decoded = decodeScaffold(envelope.plan);
  if (Option.isNone(decoded)) return undefined;
  const plan = decoded.value;
  /** Wraps one line of prose at `indent`, its continuation two columns further in. */
  const wrap = (line: string, indent = 0) =>
    paragraph(line, { width: style.width, indent, hang: indent + 2 });
  return sections(
    headerLines(envelope, undefined, style),
    [
      `Would create ${style.path(plan.declarationPath)} and register ${plan.name === undefined ? "the source" : `source ${plan.name}`}.`,
      "No files or state changed.",
    ].flatMap((line) => wrap(line)),
    plan.content
      .trimEnd()
      .split("\n")
      .map((line) => `  ${line}`),
    ...plan.entries.map((entry) => [
      ...wrap(
        `${resourceKinds[entry.kind].declarationKey} ${entry.path ?? "collection"} · ${plural(entry.resources.length, entry.kind, kindPlurals[entry.kind])}`,
      ),
      ...(entry.resources.length === 0
        ? []
        : paragraph(entry.resources.join(", "), { width: style.width, indent: 2 })),
      // An error is listed under Problems; a warning stays beside its entry.
      ...entry.findings
        .filter((finding) => finding.severity === "warning")
        .flatMap((finding) =>
          findingLines(finding, style).flatMap((line, index) =>
            index === 0 ? wrap(line, 2) : wrap(line.trimStart(), 4),
          ),
        ),
    ]),
    diagnosticLines(envelope.diagnostics, style),
    hintLines(envelope.next, style),
  );
};
