import { maximumSearchLimit } from "@tackup/reader/search-core";
import { Option } from "effect";
import type { DocsResourceReference } from "../../domain/docs/docs-schema.ts";
import { commandLine } from "../envelope/command-line.ts";
import { frameView } from "./frame.ts";
import type { HumanView } from "./human-view.ts";
import { oneLine } from "../envelope/one-line.ts";
import { withoutPayload } from "./run-text.ts";
import type { Style } from "./style.ts";
import { cell, flow, paragraph, truncate, wrapText } from "./text.ts";
import { type FactRow, factRows, plural } from "./view.ts";

/** Startup readiness: the URL the reader serves on, written once when it is ready. */
export const readerView: HumanView<"docs-serve"> = (envelope, { result }, style) => {
  if (envelope.result === null) return withoutPayload(envelope, style);
  if (Option.isNone(result) === true) return undefined;
  const started = result.value;
  return frameView(envelope, style, {
    scope: started.project.name,
    body: [
      [
        style.bold("Reader ready"),
        ...factRows(
          [
            ["URL", [cell(started.url)]],
            ["Project", [cell(started.project.name)]],
            ["Root", [cell(style.path(started.project.root))]],
          ],
          style,
        ),
      ],
      paragraph("Serving the attached docs in the foreground until interrupted.", {
        width: style.width,
      }),
    ],
  });
};

const resourceText = (resource: DocsResourceReference, style: Style) =>
  style.reference({
    sourceRegistrationId: resource.sourceRegistrationId,
    name: resource.name,
    kind: "docs",
  });

const referenceText = (
  reference: { readonly path: string; readonly startLine: number; readonly endLine: number },
  style: { readonly path: (path: string) => string },
) =>
  `${style.path(reference.path)}:${reference.startLine}${
    reference.endLine === reference.startLine ? "" : `-${reference.endLine}`
  }`;

/** Search hits with their resource and file location, the total, and the completeness of the search. */
export const readerSearchView: HumanView<"docs-search"> = (envelope, { result }, style) => {
  if (envelope.result === null) return withoutPayload(envelope, style);
  if (Option.isNone(result) === true) return undefined;
  const search = result.value;

  const { hits } = search;
  const resultsText =
    search.total === 0
      ? "no documents match"
      : search.truncated
        ? `${hits.length} of ${search.total} hits shown, truncated at the limit of ${search.limit}`
        : `${plural(search.total, "hit")}, within the limit of ${search.limit}`;
  const rows: ReadonlyArray<FactRow> = [
    ["Query", [cell(search.query)]],
    ["Project", [cell(`${search.project.name} · ${style.path(search.project.root)}`)]],
    ["Results", [cell(resultsText, search.truncated ? style.yellow : undefined)]],
    [
      "Coverage",
      [
        cell(
          search.complete
            ? "complete"
            : search.setup !== undefined
              ? "incomplete, no docs are attached"
              : `incomplete, ${plural(search.issues.length, "issue")} found; hits come from everything that loaded`,
          search.complete ? undefined : style.yellow,
        ),
      ],
    ],
  ];

  const digits = String(hits.length).length;
  const bullet = " ".repeat(digits + 4);
  const lineRoom = Math.max(10, style.width - bullet.length);
  const hitLines = hits.flatMap((hit, index) => {
    const { document } = hit;
    const metadata = [
      document.metadata.type === undefined ? undefined : `type ${document.metadata.type}`,
      document.metadata.status === undefined ? undefined : `status ${document.metadata.status}`,
      document.metadata.tags.length === 0 ? undefined : `tags ${document.metadata.tags.join(", ")}`,
    ].filter((part): part is string => part !== undefined);
    return [
      `  ${String(index + 1).padStart(digits)}. ${style.bold(truncate(oneLine(document.title), Math.max(10, style.width - digits - 4)))}`,
      ...wrapText(
        `${document.relativePath}${document.resource === undefined ? "" : ` · ${resourceText(document.resource, style)}`}`,
        lineRoom,
      ).map((line) => `${bullet}${line}`),
      ...(metadata.length === 0
        ? []
        : paragraph(metadata.join(" · "), {
            width: style.width,
            indent: bullet.length,
            paint: style.dim,
          })),
      ...(hit.matches.length === 0
        ? [`${bullet}${style.dim(`no matching text; whole file ${style.path(document.path)}`)}`]
        : hit.matches.flatMap((match) => [
            ...paragraph(referenceText(match.source, style), {
              width: style.width,
              indent: bullet.length,
            }),
            `${bullet}  ${truncate(oneLine(match.excerpt), Math.max(10, lineRoom - 2))}`,
            ...match.contributors.flatMap((contributor) =>
              paragraph(
                `via ${referenceText(contributor, style)}${contributor.kind === undefined ? "" : ` (${contributor.kind})`}`,
                { width: style.width, indent: bullet.length + 2, paint: style.dim },
              ),
            ),
          ])),
    ];
  });

  const unavailable = [
    ...(search.setup === undefined
      ? []
      : [
          `  ${style.yellow("!")} ${search.setup.code}`,
          ...paragraph(search.setup.message, { width: style.width, indent: 4 }),
        ]),
    ...search.issues.flatMap((issue) => [
      ...flow(
        [
          cell("!", style.yellow),
          cell(resourceText(issue.resource, style)),
          cell("·"),
          cell(issue.code),
        ],
        { width: style.width, indent: 2, hang: 4 },
      ),
      ...paragraph(issue.message, { width: style.width, indent: 4 }),
      // A document issue's message already names its file, so only resource issues add a path.
      ...(issue.path === undefined
        ? paragraph(style.path(issue.sourcePath), {
            width: style.width,
            indent: 4,
            paint: style.dim,
          })
        : []),
    ]),
  ];

  const limitAdvice = !search.truncated
    ? undefined
    : search.limit < maximumSearchLimit
      ? `Raise --limit (up to ${maximumSearchLimit}) or refine the query to see the other ${search.total - hits.length}.`
      : `The limit is at its maximum of ${maximumSearchLimit}; refine the query or add --type, --status or --tag.`;

  return frameView(envelope, style, {
    scope: search.project.name,
    body: [
      factRows(rows, style),
      hitLines.length === 0 ? undefined : [style.bold("Hits"), ...hitLines],
      limitAdvice === undefined ? undefined : paragraph(limitAdvice, { width: style.width }),
      unavailable.length === 0 ? undefined : [style.bold("Coverage issues"), ...unavailable],
    ],
    hints: search.complete
      ? []
      : [search.setup?.next ?? commandLine("docs-list", "--project", search.project.name)],
  });
};
