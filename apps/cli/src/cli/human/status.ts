import { Option } from "effect";
import type {
  StatusNamespace,
  StatusPayload,
  StatusPayloadDestination,
} from "../../domain/status/status-schema.ts";
import { destinationPlace } from "../../domain/status/destination-place.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { collisionExcludeCommands, userExcludeCommands } from "../envelope/collision-hints.ts";
import { commandLine, selectorFlags } from "../envelope/command-line.ts";
import type { HumanView } from "./render.ts";
import type { Style } from "./style.ts";
import { cell, sanitize, table, wrapText, type Cell } from "./text.ts";
import {
  capRows,
  cappedRows,
  diagnosticLines,
  factRows,
  headerLines,
  headingLines,
  hintLines,
  needAttention,
  plural,
  sections,
  withoutPayload,
} from "./view.ts";

type StatusAddress = {
  readonly kind: string;
  readonly name: string;
  readonly sourceRegistrationId: string;
};

/** An address as an operator names it; the style reads the catalog for the shortest form. */
const shortestAddress = (style: Style, address: StatusAddress) =>
  `${address.kind} ${style.reference(address)}`;

/** `project demo`, `user`, or `all projects and user`, as the scope reads in a sentence. */
const scopeText = (scope: StatusPayload["scope"]) =>
  scope._tag === "project"
    ? `project ${scope.projectName}`
    : scope._tag === "user"
      ? "user"
      : "all projects and user";

const destinationLabels: { readonly [K in StatusPayloadDestination["_tag"]]: string } = {
  drift: "drifted",
  "evidence-absent": "gone",
  "evidence-changed": "changed",
  "expected-absent": "missing",
  "foreign-entry": "foreign",
  "hand-made": "hand-made",
  matching: "linked",
  "observation-failed": "unreadable",
  "selection-conflict": "conflict",
  "target-missing": "no target",
  unrecorded: "unrecorded",
};

const destinationCell = (destination: StatusPayloadDestination, style: Style): Cell => {
  const label = destinationLabels[destination._tag];
  return destination._tag === "matching"
    ? cell(label, style.green)
    : destination._tag === "expected-absent" ||
        destination._tag === "evidence-absent" ||
        destination._tag === "evidence-changed" ||
        destination._tag === "hand-made" ||
        destination._tag === "unrecorded"
      ? cell(label, style.yellow)
      : cell(label, style.red);
};

/** The destination path relative to its target root, prefixed with the target it belongs to. */
const destinationText = (destination: StatusPayloadDestination, style: Style) =>
  destinationPlace(destination) ?? style.path(destination.destinationPath);

/** The candidates one destination has: every resource that wants it, as a reader names them. */
const candidates = (destination: StatusPayloadDestination, style: Style) => [
  ...new Set((destination.candidates ?? []).map((address) => style.reference(address))),
];

const destinationAddress = (destination: StatusPayloadDestination, style: Style) => {
  if (destination._tag === "selection-conflict")
    return `needed by ${candidates(destination, style).join(", ")}`;
  if (destination.address === undefined) return "";
  return destination._tag === "hand-made"
    ? `kept; Tack's ${shortestAddress(style, destination.address)} is not linked`
    : shortestAddress(style, destination.address);
};

const destinationLines = (
  report: StatusPayload,
  style: Style,
  details: boolean,
): ReadonlyArray<string> => {
  const { destinations } = report;
  if (destinations.length === 0) return [];
  const attention = destinations.filter(({ _tag }) => _tag !== "matching");
  const matching = destinations.filter(({ _tag }) => _tag === "matching");
  const linked = matching.length;
  const { shown, more } = capRows(attention, details);
  return [
    ...headingLines("Destinations", `${linked} linked, ${needAttention(attention.length)}`, style),
    ...table(
      (details ? [...shown, ...matching] : shown).map((destination) => [
        destinationCell(destination, style),
        cell(destination.adapter),
        cell(destinationText(destination, style)),
        cell(destinationAddress(destination, style), style.dim),
      ]),
      { width: style.width },
    ),
    ...more,
  ];
};

/**
 * An operator's directory alias, such as `.claude/skills` pointing at `.agents/skills`, is shown
 * once with the adapters that share it. Its links count as linked, never as foreign.
 */
const aliasLines = (report: StatusPayload, style: Style): ReadonlyArray<string> => {
  const physical = new Map<string, Map<string, string>>();
  for (const { adapter, sharing } of report.destinations) {
    if (sharing === undefined) continue;
    const adapters = physical.get(sharing.physicalDirectory) ?? new Map<string, string>();
    adapters.set(adapter, sharing.directory);
    physical.set(sharing.physicalDirectory, adapters);
  }
  if (physical.size === 0) return [];
  return [
    ...headingLines(
      "Agent directories",
      plural(physical.size, "shared directory", "shared directories"),
      style,
    ),
    ...table(
      [...physical].flatMap(([directory, adapters]) =>
        [...adapters].map(([adapter, logical]) => [
          cell(adapter),
          cell(
            logical === directory
              ? `${style.path(directory)} (physical)`
              : `${style.path(logical)} → ${style.path(directory)}`,
          ),
        ]),
      ),
      { width: style.width },
    ),
  ];
};

/** The destinations whose path holds, or will hold once synced, a link Tack keeps. */
const keptLinkTags: ReadonlySet<StatusPayloadDestination["_tag"]> = new Set([
  "matching",
  "drift",
  "expected-absent",
]);

/**
 * The `.gitignore` line for a project's docs mounts: the whole `.tack/` folder for a destination
 * inside it, which Tack owns, or the configured folder itself. Docs mounts are folders, so the line
 * ends with `/`.
 */
const docsIgnoreLine = (docsDestination: string) =>
  sanitize(`/${docsDestination.split("/")[0] === ".tack" ? ".tack" : docsDestination}/`);

/**
 * Per project, the `.gitignore` lines for the links Tack keeps in it: each path from the
 * repository root, once for all of its worktrees, flush left and unwrapped so a copy works. A link
 * is a file to Git, so a line ends without `/`; a new skill is a new link, so it needs a new line.
 * A project with docs attached adds the line for its docs mounts.
 */
const ignoreLines = (report: StatusPayload, style: Style): ReadonlyArray<ReadonlyArray<string>> => {
  const withDocs = new Map(
    report.projects.flatMap((project) =>
      project.docsDestination === undefined
        ? []
        : [[project.name, new Set([docsIgnoreLine(project.docsDestination)])] as const],
    ),
  );
  const byProject = report.destinations.reduce((projects, destination) => {
    const { destinationPath, target } = destination;
    if (target._tag !== "project-root" || keptLinkTags.has(destination._tag) === false)
      return projects;
    if (destinationPath.startsWith(`${target.canonicalPath}/`) === false) return projects;
    const paths = projects.get(target.projectName) ?? new Set<string>();
    paths.add(sanitize(destinationPath.slice(target.canonicalPath.length)));
    return projects.set(target.projectName, paths);
  }, new Map(withDocs));
  return [...byProject]
    .toSorted(([left], [right]) => compareCodeUnits(left, right))
    .map(([projectName, paths]) => [
      style.bold(`For .gitignore in project ${projectName}`),
      ...wrapText(
        `One line per link Tack keeps in this repository. A link is a file to Git, so a line has no trailing /. A new skill needs its own line.${withDocs.has(projectName) ? " The docs mounts are in a folder, so their line ends with /." : ""}`,
        style.width - 2,
      ).map((line) => `  ${style.dim(line)}`),
      ...[...paths].toSorted(),
    ]);
};

const namespaceTitle = (namespace: StatusNamespace) =>
  namespace.namespace._tag === "project" ? `Project ${namespace.namespace.projectName}` : "User";

const undeliveredReasons: {
  readonly [K in StatusNamespace["undelivered"][number]["reason"]]: string;
} = {
  "capability-unsupported": "adapter cannot deliver this kind",
  "context-not-delivered": "context is not delivered",
  "linked-for-user": "linked for the user instead",
  "no-enabled-adapter": "no adapter enabled",
};

/** One row per undelivered resource and reason, naming every adapter it concerns. */
const undeliveredRows = (namespace: StatusNamespace, style: Style) => {
  const rows = new Map<string, { resource: string; adapters: string[]; reason: string }>();
  for (const entry of namespace.undelivered) {
    const resource = shortestAddress(style, entry.address);
    const key = `${resource}\u0000${entry.reason}`;
    const row = rows.get(key) ?? {
      adapters: [],
      reason: undeliveredReasons[entry.reason],
      resource,
    };
    if (entry.adapter !== undefined) row.adapters.push(entry.adapter);
    rows.set(key, row);
  }
  return [...rows.values()];
};

const selectedRows = (namespace: StatusNamespace, style: Style) => {
  if (namespace.desired.length === 0) return [[cell("selected", style.dim), cell("nothing")]];
  const byKind = new Map<string, string[]>();
  for (const address of namespace.desired) {
    const names = byKind.get(address.kind) ?? [];
    names.push(style.reference(address));
    byKind.set(address.kind, names);
  }
  return [...byKind].map(([kind, names]) => [
    cell(`selected ${kind}`, style.dim),
    cell(names.join(", ")),
  ]);
};

const namespaceLines = (namespace: StatusNamespace, style: Style): ReadonlyArray<string> => [
  ...(namespace.profile === undefined
    ? []
    : [
        `Fixed profile ${namespace.profile.application.profileName}: ${namespace.profile.application.inventory.length} retained members`,
        ...[...namespace.profile.issues, ...namespace.profile.delivery.issues].map(
          (issue) => `  ${issue}`,
        ),
      ]),
  `${style.bold(namespaceTitle(namespace))}${namespace.lifecycle === "active" ? "" : style.red("  (removing)")}`,
  ...table(
    [
      ...selectedRows(namespace, style),
      ...(namespace.choices.length === 0
        ? []
        : [
            [
              cell("choices", style.dim),
              cell(
                namespace.choices
                  .map(
                    (choice) =>
                      `${choice.decision === "include" ? "+" : "−"}${shortestAddress(style, choice.address)}`,
                  )
                  .join("  "),
              ),
            ],
          ]),
      ...undeliveredRows(namespace, style).map(({ adapters, reason, resource }) => [
        cell("not delivered", style.dim),
        cell(`${resource}${adapters.length === 0 ? "" : ` → ${adapters.join(", ")}`} (${reason})`),
      ]),
    ],
    { width: style.width },
  ),
];

const overviewLines = (report: StatusPayload, style: Style): ReadonlyArray<string> => {
  const unhealthySources = report.sources.filter(({ status }) => status === "unhealthy").length;
  const declaringNothing = report.sources.filter(
    (source) => source.status === "healthy" && (source.warnings ?? []).length > 0,
  ).length;
  const sourceCell =
    unhealthySources === 0
      ? cell(
          `${plural(report.sources.length, "source")}, all healthy${
            declaringNothing === 0 ? "" : `; ${declaringNothing} declare no resources`
          }`,
          declaringNothing === 0 ? undefined : style.yellow,
        )
      : cell(`${unhealthySources} of ${report.sources.length} sources unhealthy`, style.red);
  const { quarantined, unavailable } = report.catalog;
  const projects = report.projects.map((project) => {
    const unhealthy = project.roots.filter(({ health }) => health !== "healthy").length;
    return `${project.name} (${plural(project.roots.length, "root")}${unhealthy === 0 ? "" : `, ${unhealthy} unhealthy`})`;
  });
  return factRows(
    [
      [
        "Adapters",
        [
          report.enabledAdapters.length === 0
            ? cell("none enabled", style.red)
            : cell(report.enabledAdapters.join(", ")),
        ],
      ],
      ["Sources", [sourceCell]],
      [
        "Catalog",
        [
          cell(
            `${plural(report.catalog.resources, "resource")}${
              quarantined === 0 ? "" : `, ${plural(quarantined, "quarantined candidate")}`
            }${unavailable === 0 ? "" : `, ${plural(unavailable, "unavailable source")}`}`,
          ),
        ],
      ],
      ...(projects.length === 0 ? [] : [["Projects", [cell(projects.join(", "))]] as const]),
      ...(report.imports.total === 0 && report.imports.problems.length === 0
        ? []
        : [
            [
              "Imports",
              [
                cell(
                  `${plural(report.imports.total, "imported skill")}${
                    report.imports.locallyChanged === 0
                      ? ""
                      : `, ${report.imports.locallyChanged} locally changed`
                  }${
                    report.imports.problems.length === 0
                      ? ""
                      : `, ${plural(report.imports.problems.length, "problem")}`
                  }`,
                  report.imports.problems.length === 0 ? undefined : style.yellow,
                ),
              ],
            ] as const,
          ]),
      ...(obligationCount(report) === 0
        ? []
        : [
            [
              "Pending",
              [cell(plural(obligationCount(report), "cleanup obligation"), style.yellow)],
            ] as const,
          ]),
      ["State", [cell(style.path(report.stateDirectory))]],
    ],
    style,
  );
};

/** The removals a status report says are owed, for agent links and docs mounts alike. */
const obligationCount = (report: StatusPayload) =>
  report.pendingRemovals.length + (report.docsPendingRemovals?.length ?? 0);

/** Diagnostics the destination rows and the catalog line already carry. */
const repeatedByView = (code: string) =>
  code.startsWith("destination-") ||
  code === "catalog-quarantined" ||
  code === "selection-collision";

/** The command that addresses the first import problem of each kind. */
const importSteps = (report: StatusPayload): ReadonlyArray<string> => {
  const first = (code: StatusPayload["imports"]["problems"][number]["code"]) =>
    report.imports.problems.find((problem) => problem.code === code);
  const missing = first("import-folder-missing");
  return [
    ...(missing?.reference === undefined ? [] : [commandLine("import-remove", missing.reference)]),
    ...(first("import-folder-not-cataloged") === undefined ? [] : [commandLine("catalog")]),
    ...(first("imports-invalid") === undefined && first("import-staging-left-over") === undefined
      ? []
      : [commandLine("import-list")]),
  ];
};

/** The exclude commands that resolve each selection collision, as the sync preview names them. */
const collisionSteps = (report: StatusPayload, style: Style): ReadonlyArray<string> =>
  report.destinations.flatMap((destination) =>
    destination._tag === "selection-conflict"
      ? collisionExcludeCommands(
          { addresses: destination.candidates ?? [], target: destination.target },
          style.reference,
        )
      : [],
  );

/**
 * The exclude that keeps each hand-made entry on purpose, naming the resource by its source as
 * `doctor` does, with the selector of the namespace that selected it.
 */
const handMadeSteps = (report: StatusPayload, style: Style): ReadonlyArray<string> =>
  report.destinations.flatMap((destination) =>
    destination._tag === "hand-made" && destination.address !== undefined
      ? collisionExcludeCommands(
          { addresses: [destination.address], target: destination.target },
          (address) => `${style.source(address.sourceRegistrationId)}:${address.name}`,
        )
      : [],
  );

const nextSteps = (report: StatusPayload, style: Style): ReadonlyArray<string> => {
  // The selector flags that reproduce this status request.
  const flags = selectorFlags(report.selection.selector);
  const undelivered = report.destinations.some(
    ({ _tag }) =>
      _tag === "expected-absent" ||
      _tag === "evidence-absent" ||
      _tag === "evidence-changed" ||
      _tag === "drift",
  );
  return [
    ...new Set([
      ...collisionSteps(report, style),
      ...(undelivered
        ? [commandLine("sync", ...flags), commandLine("sync", ...flags, "--apply")]
        : []),
      ...(obligationCount(report) > 0 ? [commandLine("state-clean", "--pending", ...flags)] : []),
      ...(report.catalog.quarantined + report.catalog.unavailable > 0
        ? [commandLine("catalog")]
        : []),
      ...importSteps(report),
      ...handMadeSteps(report, style),
    ]),
  ];
};

/** Renders `status`, or `undefined` when the payload is present but is not a status report. */
export const renderStatus: HumanView<"status"> = (envelope, { result }, style, details) =>
  Option.match(result, {
    onNone: () => withoutPayload(envelope, undefined, style),
    onSome: (report) =>
      sections(
        headerLines(envelope, scopeText(report.scope), style),
        destinationLines(report, style, details),
        overviewLines(report, style),
        ...report.namespaces
          .filter((namespace) => details || namespace.profile !== undefined)
          .map((namespace) => namespaceLines(namespace, style)),
        ...(details ? [aliasLines(report, style), ...ignoreLines(report, style)] : []),
        diagnosticLines(
          (details ? envelope.diagnostics : envelope.diagnostics.slice(0, cappedRows)).filter(
            ({ code }) => !repeatedByView(code),
          ),
          style,
        ),
        hintLines(
          [
            ...new Set([
              ...envelope.next,
              ...userExcludeCommands(envelope.diagnostics, style.reference),
              ...nextSteps(report, style),
            ]),
          ],
          style,
        ),
      ),
  });
