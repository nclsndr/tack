import { Option, Schema } from "effect";
import {
  type CatalogIssue,
  type ImportedSkillSchema,
  type CatalogReport,
  type CatalogResource,
  CatalogReportSchema,
} from "../../../domain/sources/catalog-report.ts";
import { activationIn } from "../../../domain/choices/selection.ts";
import {
  hasActivation,
  ResourceKindSchema,
  resourceKinds,
  type ResourceKind,
} from "../../../domain/resources/kinds.ts";
import type { PublicEnvelope } from "../public-outcome.ts";
import { referenceFor, type ReferenceIndex } from "../../../features/sources/resource-reference.ts";
import { withReferences, type Style } from "./style.ts";
import { cell, flow, table, wrapText, type Cell } from "./text.ts";
import {
  addressText,
  diagnosticLines,
  headerLines,
  kindHeading,
  plural,
  sections,
  withoutPayload,
} from "./view.ts";

const decodeCatalog = Schema.decodeUnknownOption(CatalogReportSchema);

/** The references a catalog report implies: its own resources, labelled by its own sources. */
export const referencesOf = (report: CatalogReport): ReferenceIndex => ({
  entries: report.resources,
  ...(report.sources === undefined ? {} : { sources: report.sources }),
});

type ImportedSkill = typeof ImportedSkillSchema.Type | undefined;

type ResourceOf<Kind extends ResourceKind> = Extract<CatalogResource, { readonly kind: Kind }>;

const described = (resource: { readonly description?: string }) => cell(resource.description ?? "");

/** What the third column shows: the description, or where a description-less resource lives. */
const details: {
  readonly [Kind in ResourceKind]: (resource: ResourceOf<Kind>, style: Style) => Cell;
} = {
  skill: described,
  command: described,
  context: (resource, style) => cell(style.path(resource.filePath), style.dim),
  script: described,
  docs: (resource, style) => cell(style.path(resource.directoryPath), style.dim),
};

/** The third-column function of one kind, typed so that a row of that kind is its argument. */
const detailOf = <Kind extends ResourceKind>(
  kind: Kind,
): ((resource: ResourceOf<Kind>, style: Style) => Cell) => details[kind];

/**
 * Origin and activation appear only when they differ from the defaults. The user activation is
 * the one sync resolves, so an omitted `user-activation` reads as `user opt-in`.
 */
const tagsOf = (resource: CatalogResource): string =>
  [
    ...(resource.origin === "builtin" ? ["builtin"] : []),
    ...(resource.kind === "skill" && resource.imported === true ? ["imported"] : []),
    ...(hasActivation(resource)
      ? [
          ...(resource.activation === "opt-in" ? ["opt-in"] : []),
          ...(resource.projects.length > 0 ? [`projects ${resource.projects.join(",")}`] : []),
          ...(activationIn(resource, "user") === resource.activation
            ? []
            : [`user ${activationIn(resource, "user")}`]),
        ]
      : []),
  ].join(" · ");

/**
 * `declared by skills: vendor/skills`, when the report says which entry found the resource. A
 * script's declared path is its own file, which every report carries, so only `--details`-style
 * paths of the other kinds are worth a line of their own.
 */
const declaredByText = (resource: CatalogResource): string =>
  resource.kind === "script"
    ? ""
    : resource.declaredPath !== undefined
      ? `declared by ${resourceKinds[resource.kind].declarationKey}: ${resource.declaredPath}`
      : "";

/** How an imported skill's ref request reads: `tracking main`, `pinned v1.2.0`, `tracking the default branch`. */
const refText = (ref: NonNullable<ImportedSkill>["ref"]) =>
  ref.kind === "default"
    ? "tracking the default branch"
    : `${ref.tracking ? "tracking" : "pinned"} ${ref.request ?? ""}`.trim();

const localText = (local: NonNullable<ImportedSkill>["local"]) =>
  local === "changed" ? "locally changed" : local === "missing" ? "folder missing" : "unchanged";

/** The `--details` line of an imported skill: where it came from and whether it was edited. */
const importDetailLines = (resource: CatalogResource, style: Style): ReadonlyArray<string> =>
  resource.kind === "skill" && resource.import !== undefined
    ? flow(
        [
          cell(resource.address.name, style.dim),
          cell("imported from"),
          cell(resource.import.location),
          cell("·", style.dim),
          cell(refText(resource.import.ref)),
          cell("·", style.dim),
          cell(resource.import.revision.slice(0, 12)),
          cell("·", style.dim),
          cell(
            localText(resource.import.local),
            resource.import.local === "unchanged" ? undefined : style.yellow,
          ),
        ],
        { width: style.width, indent: 4, hang: 6 },
      )
    : [];

/** One section per resource kind, each row wrapped to the terminal width. */
const resourceSections = (
  resources: ReadonlyArray<CatalogResource>,
  style: Style,
  sources: NonNullable<CatalogReport["sources"]> = [],
): ReadonlyArray<ReadonlyArray<string>> =>
  ResourceKindSchema.literals.flatMap((kind) => {
    const ofKind = resources.filter((resource) => resource.kind === kind);
    if (ofKind.length === 0) return [];
    const rows: ReadonlyArray<ReadonlyArray<Cell>> = ofKind.map((resource) => {
      const source = sources.find(
        (candidate) => candidate.registration.id === resource.sourceRegistrationId,
      );
      return [
        cell(
          referenceFor(
            { entries: resources, sources },
            { ...resource.address, sourceRegistrationId: resource.sourceRegistrationId },
          ),
        ),
        cell(
          [
            [
              ...(source === undefined ? [] : [source.label ?? source.registration.id]),
              tagsOf(resource),
            ]
              .filter((part) => part !== "")
              .join(" · "),
            declaredByText(resource),
          ]
            .filter((text) => text !== "")
            .join(" · "),
          style.dim,
        ),
        detailOf(resource.kind)(resource, style),
      ];
    });
    return [
      [
        style.bold(`${kindHeading(kind)} (${ofKind.length})`),
        ...table(rows, { width: style.width }),
        ...ofKind.flatMap((resource) => importDetailLines(resource, style)),
      ],
    ];
  });

const sourceSections = (sources: NonNullable<CatalogReport["sources"]>, style: Style) =>
  sources.length === 0
    ? []
    : [
        [
          style.bold(`Sources (${sources.length})`),
          ...sources.flatMap((source) => [
            ...flow(
              [
                cell(source.label ?? source.registration.id),
                cell(`(${source.labelOrigin ?? "none"})`, style.dim),
                cell("·", style.dim),
                cell(style.path(source.registration.canonicalPath)),
              ],
              { width: style.width, indent: 2, hang: 4 },
            ),
            ...(source.maintainers === undefined || source.maintainers.length === 0
              ? []
              : wrapText(`maintainers ${source.maintainers.join(", ")}`, style.width - 4).map(
                  (line) => `    ${line}`,
                )),
          ]),
        ],
      ];

const issueSubject = (issue: CatalogIssue, style: Style) =>
  issue.subject._tag === "resource"
    ? issue.subject.address === undefined
      ? `${issue.subject.candidateKind ?? "unknown"} candidate`
      : addressText(issue.subject.address, style)
    : "source";

/** Catalog issues, each with the source or candidate path to inspect. */
const issueLines = (issues: ReadonlyArray<CatalogIssue>, style: Style): ReadonlyArray<string> =>
  issues.length === 0
    ? []
    : [
        style.bold(`Issues (${issues.length})`),
        ...issues.flatMap((issue) => [
          ...flow(
            [
              cell("!", style.yellow),
              ...issueSubject(issue, style)
                .split(" ")
                .map((word) => cell(word)),
              cell("·", style.dim),
              cell(issue.code, style.dim),
            ],
            { width: style.width, indent: 2, hang: 4 },
          ),
          ...wrapText(issue.message, style.width - 4).map((line) => `    ${line}`),
          ...flow(
            [
              cell(
                style.path(
                  issue.subject._tag === "resource"
                    ? issue.subject.candidatePath
                    : issue.subject.sourcePath,
                ),
                style.dim,
              ),
            ],
            { width: style.width, indent: 4 },
          ),
        ]),
      ];

/** How each resource kind reads after a count; `docs` is already plural, so it only drops its `s` at one. */
const kindNouns: Record<CatalogResource["kind"], readonly [singular: string, pluralForm: string]> =
  {
    skill: ["skill", "skills"],
    command: ["command", "commands"],
    context: ["context", "contexts"],
    script: ["script", "scripts"],
    docs: ["doc", "docs"],
  };

/** `0 docs`, `1 skill`, `2 scripts`; unscoped catalogs count generic `resource`s. */
export const resourceCountText = (count: number, kind?: CatalogResource["kind"]) => {
  const [singular, pluralForm] = kind === undefined ? ["resource", "resources"] : kindNouns[kind];
  return plural(count, singular, pluralForm);
};

const summaryText = (report: CatalogReport) =>
  [
    resourceCountText(report.resources.length, report.scope),
    ...(report.issues.length === 0 ? [] : [plural(report.issues.length, "issue")]),
  ].join(", ");

/**
 * Renders `catalog`, with or without `--kind`, or `undefined` when the payload is present but is not a
 * catalog report. The catalog summary diagnostic is dropped because the issues section explains it.
 */
export const renderCatalog = (envelope: PublicEnvelope, style: Style): string | undefined =>
  Option.match(decodeCatalog(envelope.result), {
    onNone: () => withoutPayload(envelope, undefined, style),
    onSome: (report) =>
      sections(
        headerLines(envelope, summaryText(report), style),
        ...sourceSections(report.sources ?? [], style),
        ...(report.resources.length === 0 && report.issues.length === 0
          ? [[style.dim("No resources are declared.")]]
          : resourceSections(report.resources, style, report.sources ?? [])),
        issueLines(report.issues, withReferences(style, referencesOf(report))),
        diagnosticLines(
          envelope.diagnostics.filter(
            ({ code }) => !(code === "catalog-partial" && report.issues.length > 0),
          ),
          style,
        ),
      ),
  });
