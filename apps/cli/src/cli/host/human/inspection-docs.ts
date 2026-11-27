import type { DocsResourceReference as Reference } from "../../../domain/docs/docs-schema.ts";
import {
  DocsListPayloadSchema,
  DocsTargetPayloadSchema,
  type DocsList,
} from "../../../features/docs/docs.ts";
import type { HumanViewRegistry } from "./render.ts";
import type { Style } from "./style.ts";
import { cell, paragraph } from "./text.ts";
import { factRows, headingLines, plural } from "./view.ts";
import {
  decoderFor,
  type Entry,
  entryLines,
  facts,
  indented,
  resultView,
} from "./inspection-support.ts";
import { commandLine } from "../command-line.ts";

const referenceText = (resource: Reference, style: Style) =>
  style.reference({ ...resource, kind: "docs" });

const sameResource = (left: Reference, right: Reference | undefined) =>
  right !== undefined &&
  left.sourceRegistrationId === right.sourceRegistrationId &&
  left.name === right.name;

/**
 * Unavailable resources point at reconciliation. Healthy ones point at the writing target when it
 * resolves (a default, or one attachment), and otherwise at choosing the default.
 */
const docsListHints = (
  { project, resources, issues, settings, setup, mounts }: DocsList,
  style: Style,
) => {
  const [first, ...others] = resources;
  const unmounted = mounts.some((mount) => mount.state !== "mounted");
  return [
    ...(setup === undefined ? [] : [setup.next]),
    ...(issues.length === 0 && !unmounted ? [] : [commandLine("sync", "--project", project.name)]),
    ...(first === undefined
      ? []
      : settings.defaultWritingResource !== undefined || others.length === 0
        ? [commandLine("docs-target", "--project", project.name)]
        : [
            commandLine(
              "docs-configure",
              "--project",
              project.name,
              "--default",
              referenceText(first, style),
            ),
          ]),
  ];
};

const writingMark = (resource: Reference, writing: Reference | undefined, style: Style) =>
  sameResource(resource, writing) ? [`    ${style.cyan("default writing resource")}`] : [];

const docsListView = resultView(decoderFor(DocsListPayloadSchema), (docs, _envelope, style) => {
  const { project, resources, issues, settings } = docs;
  const writing = settings.defaultWritingResource;
  const resourceEntries = resources.map((resource): Entry => ({
    head: [cell("✓ available", style.green), cell(referenceText(resource, style), style.bold)],
    details: [
      ...writingMark(resource, writing, style),
      ...facts(
        [
          ["source", style.source(resource.sourceRegistrationId)],
          ["source path", style.path(resource.sourcePath)],
          ["docs", style.path(resource.directoryPath)],
          ...(resource.readerConfig === undefined
            ? []
            : [
                [
                  `reader config (${resource.readerConfig.kind})`,
                  style.path(resource.readerConfig.path),
                ] as const,
              ]),
        ],
        4,
        style,
      ),
    ],
  }));
  const unavailable = issues.filter((issue) => issue.path === undefined);
  const documentIssues = issues.filter((issue) => issue.path !== undefined);
  const issueEntries = unavailable.map((issue): Entry => ({
    head: [
      cell("! unavailable", style.yellow),
      cell(referenceText(issue.resource, style), style.bold),
    ],
    details: [
      ...writingMark(issue.resource, writing, style),
      ...facts(
        [
          ["source", style.source(issue.resource.sourceRegistrationId)],
          ...(issue.sourcePath === ""
            ? []
            : [["source path", style.path(issue.sourcePath)] as const]),
        ],
        4,
        style,
      ),
      ...indented(`${issue.code}: ${issue.message}`, 4, style),
    ],
  }));
  return {
    scope: `project ${project.name}`,
    body: [
      factRows(
        [
          ["root", [cell(style.path(project.root))]],
          ["destination", [cell(settings.destination ?? "default")]],
          [
            "default writing",
            [cell(writing === undefined ? "none set" : referenceText(writing, style))],
          ],
          ...(writing === undefined
            ? []
            : [["writing source", [cell(style.source(writing.sourceRegistrationId))]] as const]),
        ],
        style,
      ),
      resources.length + issues.length === 0
        ? [
            ...paragraph("No docs resources are attached.", { width: style.width }),
            ...(docs.setup === undefined
              ? []
              : [
                  ...paragraph(docs.setup.message, { width: style.width }),
                  ...paragraph(`Next: ${docs.setup.next}`, { width: style.width }),
                ]),
          ]
        : [
            ...headingLines(
              "Attached docs",
              unavailable.length === 0
                ? plural(resources.length, "resource")
                : `${resources.length} available · ${unavailable.length} unavailable`,
              style,
            ),
            ...entryLines([...resourceEntries, ...issueEntries], style),
          ],
      factRows(
        [
          ["documents", [cell(String(docs.documents))]],
          [
            "coverage",
            [cell(issues.length === 0 && docs.setup === undefined ? "complete" : "incomplete")],
          ],
        ],
        style,
      ),
      documentIssues.length === 0
        ? undefined
        : [
            ...headingLines(
              "Documents that failed to load",
              plural(documentIssues.length, "document"),
              style,
            ),
            ...documentIssues.flatMap((issue) => [
              ...indented(`! ${referenceText(issue.resource, style)}`, 2, style),
              ...indented(issue.message, 4, style),
            ]),
          ],
      docs.mounts.length === 0
        ? undefined
        : [
            ...headingLines("Mounts", "managed writing links", style),
            ...entryLines(
              docs.mounts.map((mount): Entry => ({
                head: [
                  mount.state === "mounted"
                    ? cell("✓ mounted", style.green)
                    : cell(`! ${mount.state}`, style.yellow),
                  cell(referenceText(mount.resource, style)),
                ],
                details: [
                  ...facts([["path", style.path(mount.destinationPath)]], 4, style),
                  ...(mount.message === undefined ? [] : indented(mount.message, 4, style)),
                ],
              })),
              style,
            ),
          ],
    ],
    hints: docsListHints(docs, style),
  };
});

const docsTargetView = resultView(
  decoderFor(DocsTargetPayloadSchema),
  (target, _envelope, style) => ({
    scope: `project ${target.projectName}`,
    body: [
      [
        style.bold("Verified writing target"),
        ...factRows(
          [
            ["mount", [cell(style.path(target.destinationPath))]],
            ["resource", [cell(referenceText(target.resource, style))]],
            ["source", [cell(style.source(target.resource.sourceRegistrationId))]],
            ["docs directory", [cell(style.path(target.sourceDirectoryPath))]],
            ["project root", [cell(style.path(target.root))]],
          ],
          style,
        ),
      ],
    ],
  }),
);

/** Docs list and docs target views. */
export const docsViews = {
  "docs-list": docsListView,
  "docs-target": docsTargetView,
} satisfies HumanViewRegistry;
