import { projectLifecycle } from "../../../domain/projects/project-schema.ts";
import type { DeclarationFacts } from "../../../domain/sources/declaration-facts.ts";
import { resourceKinds } from "../../../domain/resources/kinds.ts";
import {
  SourceListPayloadSchema,
  sourceLoadsNothing,
  type SourceImportFacts,
  type SourceListEntry,
} from "../../../features/imports/import-display.ts";
import {
  ProjectInspectionsPayloadSchema,
  type ProjectInspection,
} from "../../../features/projects/project.ts";
import type { HumanViewRegistry } from "./render.ts";
import type { Style } from "./style.ts";
import { cell, paragraph, tableRows } from "./text.ts";
import { headingLines, needAttention, plural } from "./view.ts";
import {
  decoderFor,
  type Entry,
  entryLines,
  facts,
  indented,
  resultView,
} from "./inspection-support.ts";
import { commandLine } from "../command-line.ts";

const issueLine = (
  issue: { readonly code: string; readonly message: string },
  indent: number,
  style: Style,
) => indented(`${issue.code}: ${issue.message}`, indent, style);

/** `include a, b · exclude c`: the patterns that narrow one declaration. */
const patternText = (declaration: DeclarationFacts) =>
  [
    ...(declaration.include === undefined ? [] : [`include ${declaration.include.join(", ")}`]),
    ...(declaration.exclude === undefined ? [] : [`exclude ${declaration.exclude.join(", ")}`]),
  ].join(" · ");

/** One table row per declaration, in file order within each kind, with its problems under it. */
const declarationLines = (
  declarations: ReadonlyArray<DeclarationFacts>,
  style: Style,
): ReadonlyArray<string> => {
  const rows = tableRows(
    declarations.map((declaration) => [
      cell(resourceKinds[declaration.kind].declarationKey),
      cell(declaration.path ?? "(no path)"),
      cell(plural(declaration.resources, "resource")),
      cell(
        [
          ...(declaration.name === undefined ? [] : [`name ${declaration.name}`]),
          patternText(declaration),
        ]
          .filter((text) => text !== "")
          .join(" · "),
      ),
    ]),
    { width: style.width, indent: 6 },
  );
  return [
    `    ${style.dim("declarations")}`,
    ...declarations.flatMap((declaration, index) => [
      ...(rows[index] ?? []),
      ...declaration.problems.flatMap((problem) =>
        indented(`! ${problem.code}: ${problem.message}`, 8, style),
      ),
    ]),
  ];
};

/** `3 imported skills · 1 locally changed · 1 folder missing`, or the problems alone. */
const importsText = (imports: SourceImportFacts) =>
  [
    plural(imports.total, "imported skill"),
    ...(imports.locallyChanged === 0 ? [] : [`${imports.locallyChanged} locally changed`]),
    ...(imports.missing === 0 ? [] : [`${imports.missing} folder missing`]),
    ...(imports.uncataloged === 0 ? [] : [`${imports.uncataloged} not cataloged`]),
    ...(imports.invalid ? ["imports section unreadable"] : []),
    ...(imports.stagingLeftOver ? ["interrupted write left over"] : []),
  ].join(" · ");

const sourceEntry = (source: SourceListEntry, style: Style): Entry => {
  const { registration } = source;
  const issue = source.status === "unhealthy" ? source.issue : undefined;
  return {
    head: [
      source.status === "unhealthy"
        ? cell("✗ unhealthy", style.red)
        : sourceLoadsNothing(source)
          ? cell("✗ broken", style.red)
          : cell("✓ healthy", style.green),
      cell(style.path(registration.canonicalPath)),
    ],
    details: [
      ...facts(
        [
          ["id", registration.id],
          [
            "label",
            source.label === undefined
              ? "none"
              : `${source.label} (${source.labelOrigin ?? "none"})`,
          ],
          ...(source.maintainers === undefined || source.maintainers.length === 0
            ? []
            : [["maintainers", source.maintainers.join(", ")] as const]),
          ...(source.imports === undefined
            ? []
            : [["imports", importsText(source.imports)] as const]),
        ],
        4,
        style,
      ),
      ...(source.origin === "builtin" ? [`    ${style.dim("built-in")}`] : []),
      ...(source.labelIssues ?? []).flatMap((labelIssue) => issueLine(labelIssue, 4, style)),
      ...(source.warnings ?? []).flatMap((warning) => issueLine(warning, 4, style)),
      ...(source.status === "unhealthy" || source.declarations.length === 0
        ? []
        : declarationLines(source.declarations, style)),
      ...(issue === undefined
        ? []
        : [
            ...issueLine(issue, 4, style),
            ...facts(
              [
                ...(issue.operation === undefined ? [] : [["operation", issue.operation] as const]),
                ...(issue.path === undefined ? [] : [["path", style.path(issue.path)] as const]),
                ...(issue.sourcePath === undefined
                  ? []
                  : [["source path", style.path(issue.sourcePath)] as const]),
              ],
              4,
              style,
            ),
          ]),
    ],
  };
};

const sourceInspectView = resultView(
  decoderFor(SourceListPayloadSchema),
  ({ sources }, _envelope, style) => {
    const unhealthy = sources.filter(({ status }) => status === "unhealthy").length;
    const broken = sources.filter(sourceLoadsNothing);
    const healthy = sources.length - unhealthy - broken.length;
    return {
      scope: plural(sources.length, "source"),
      body: [
        sources.length === 0
          ? paragraph("No sources are registered.", { width: style.width })
          : [
              ...headingLines(
                "Sources",
                healthy === sources.length
                  ? "all healthy"
                  : [
                      `${healthy} healthy`,
                      ...(broken.length === 0 ? [] : [`${broken.length} broken`]),
                      ...(unhealthy === 0 ? [] : [`${unhealthy} unhealthy`]),
                    ].join(" · "),
                style,
              ),
              ...entryLines(
                sources.map((source) => sourceEntry(source, style)),
                style,
              ),
            ],
      ],
      hints:
        sources.length === 0
          ? []
          : [
              ...broken.map(({ registration }) => `tack check ${registration.canonicalPath}`),
              commandLine("catalog"),
            ],
    };
  },
);

const rootMark = (status: "active" | "stale" | "unhealthy", style: Style) =>
  status === "active"
    ? cell("✓ active", style.green)
    : status === "stale"
      ? cell("! missing", style.yellow)
      : cell("✗ unhealthy", style.red);

const needsAttention = ({ anchor, project, roots }: ProjectInspection) =>
  projectLifecycle(project) === "removing" ||
  anchor.status === "unhealthy" ||
  (project.removingRoots ?? []).length > 0 ||
  roots.some(({ status }) => status !== "active");

const projectEntry = ({ anchor, project, roots }: ProjectInspection, style: Style): Entry => {
  const removing = projectLifecycle(project) === "removing";
  const observations = [
    {
      cells: [
        cell("anchor", style.dim),
        anchor.status === "healthy"
          ? cell("✓ healthy", style.green)
          : cell("✗ unhealthy", style.red),
        cell(style.path(anchor.path)),
      ],
      issue: anchor.issue,
    },
    ...roots.map((root) => ({
      cells: [cell("root", style.dim), rootMark(root.status, style), cell(style.path(root.root))],
      issue: root.issue,
    })),
    ...(project.removingRoots ?? []).map((root) => ({
      cells: [cell("root", style.dim), cell("! removing", style.yellow), cell(style.path(root))],
      issue: undefined,
    })),
  ];
  const rows = tableRows(
    observations.map(({ cells }) => cells),
    { width: style.width, indent: 4 },
  );
  return {
    head: [
      cell(project.name, style.bold),
      removing ? cell("! removing", style.yellow) : cell("✓ active", style.green),
      // Every head of the list has three cells; a project without a removal intent leaves it empty.
      project.removalIntent === undefined ? cell("") : cell("removal requested", style.dim),
    ],
    details: observations.flatMap(({ issue }, index) => [
      ...(rows[index] ?? []),
      ...(issue === undefined ? [] : issueLine(issue, 8, style)),
    ]),
  };
};

const projectInspectView = resultView(
  decoderFor(ProjectInspectionsPayloadSchema),
  ({ projects }, _envelope, style) => {
    const attention = projects.filter(needsAttention);
    const [firstAttention] = attention;
    return {
      scope: plural(projects.length, "project"),
      body: [
        projects.length === 0
          ? paragraph("No projects are registered.", { width: style.width })
          : [
              ...headingLines(
                "Projects",
                attention.length === 0
                  ? "all healthy"
                  : `${projects.length - attention.length} healthy · ${needAttention(attention.length)}`,
                style,
              ),
              ...entryLines(
                projects.map((project) => projectEntry(project, style)),
                style,
              ),
            ],
      ],
      hints:
        firstAttention === undefined
          ? projects.length === 0
            ? []
            : [commandLine("status")]
          : [commandLine("project-refresh", "--project", firstAttention.project.name)],
    };
  },
);

/** Source and project inspection views. */
export const sourceInspectionViews = {
  "source-list": sourceInspectView,
  "project-list": projectInspectView,
} satisfies HumanViewRegistry;
