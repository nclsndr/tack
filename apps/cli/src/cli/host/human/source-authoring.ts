import type { SourceCheckReport, SourceFinding } from "../../../domain/sources/source-check.ts";
import type { SourceScaffoldPlanSchema } from "../../../features/sources/source-scaffold.ts";
import type { SourceRegistrationPlanSchema } from "../../../features/sources/source.ts";
import type { PublicEnvelope } from "../public-outcome.ts";
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

/**
 * The preview of registering a source that has its tack.yaml: what would be registered, or that it
 * is registered already, then its counts and warnings. Errors are listed under Problems.
 */
export const renderSourceRegistrationPlan = (
  envelope: PublicEnvelope,
  plan: typeof SourceRegistrationPlanSchema.Type,
  style: Style,
): string => {
  const folder = style.path(plan.sourcePath);
  const source = plan.name === undefined ? folder : `${plan.name} (${folder})`;
  return sections(
    headerLines(envelope, undefined, style),
    (plan.alreadyRegistered
      ? [`Source ${source} is already registered.`]
      : [`Would register source ${source}.`, "No files or state changed."]
    ).flatMap((line) => paragraph(line, { width: style.width, hang: 2 })),
    sourceCheckLines(
      {
        ...plan.inspection,
        findings: plan.inspection.findings.filter((finding) => finding.severity === "warning"),
      },
      style,
    ),
    diagnosticLines(envelope.diagnostics, style),
    hintLines(envelope.next, style),
  );
};

/**
 * A declaration that `--config` describes is always shown before --apply writes it: the file, then
 * what each entry finds, with the names of its resources and its problems, then why it would not
 * apply when it loads nothing, or else how to apply it.
 */
export const renderSourceScaffold = (
  envelope: PublicEnvelope,
  plan: typeof SourceScaffoldPlanSchema.Type,
  style: Style,
): string => {
  /** Wraps one line of prose at `indent`, its continuation two columns further in. */
  const wrap = (line: string, indent = 0) =>
    paragraph(line, { width: style.width, indent, hang: indent + 2 });
  /** A warning, beside what it concerns; an error is listed under Problems. */
  const warningLines = (findings: ReadonlyArray<SourceFinding>, indent: number) =>
    findings
      .filter((finding) => finding.severity === "warning")
      .flatMap((finding) =>
        findingLines(finding, style).flatMap((line, index) =>
          index === 0 ? wrap(line, indent) : wrap(line.trimStart(), indent + 2),
        ),
      );
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
        `${resourceKinds[entry.kind].declarationKey} ${entry.path ?? "(no path)"} · ${plural(entry.resources.length, entry.kind, kindPlurals[entry.kind])}`,
      ),
      ...(entry.resources.length === 0
        ? []
        : paragraph(entry.resources.join(", "), { width: style.width, indent: 2 })),
      ...warningLines(entry.findings, 2),
    ]),
    warningLines(plan.findings, 0),
    diagnosticLines(envelope.diagnostics, style),
    // The JSON is never echoed back as a command: a preview that can apply says how to apply it.
    envelope.diagnostics.some((diagnostic) => diagnostic.code === "declaration-loads-nothing")
      ? undefined
      : paragraph(
          plan.config === "standard-input"
            ? "Run the same command again with --apply, piping the same JSON, to write tack.yaml and register the source."
            : "Run the same command again with --apply to write tack.yaml and register the source.",
          { width: style.width, hang: 2 },
        ),
  );
};
