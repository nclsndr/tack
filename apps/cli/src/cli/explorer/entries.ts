import { isBuiltinSkill } from "../../domain/choices/builtin.ts";
import {
  choiceNamespaceIdentity,
  type Namespace,
  type Choice,
} from "../../domain/choices/choice-schema.ts";
import { docsResourceIdentity, type DocsResourceReference } from "../../domain/docs/docs-schema.ts";
import type {
  CatalogIssue,
  CatalogReport,
  CatalogResource,
} from "../../domain/sources/catalog-report.ts";
import { isSelectableAddress, type ResourceAddress } from "../../domain/sources/catalog-schema.ts";
import { hasActivation, ResourceKindSchema, resourceKinds } from "../../domain/resources/kinds.ts";
import { sourceQualifier } from "../../features/sources/resource-reference.ts";
import { kindHeading } from "../human/view.ts";
import {
  activityIn,
  activityText,
  scopeKey,
  type ActivityScope,
  type DestinationActivity,
  type ExplorerActivity,
} from "./activity.ts";
import { activationIn } from "../../domain/choices/selection.ts";
import { posixPath } from "../../domain/identity/portable.ts";
import type { Editable } from "./edit.ts";
import type { ExplorerEntry } from "./model.ts";

/** What edit mode needs beyond the catalog: the namespace and its current docs attachments. */
export type ExplorerEditing = {
  readonly namespace: Namespace;
  readonly attachments: ReadonlyArray<DocsResourceReference>;
};

const editableOf = (
  resource: CatalogResource,
  choices: ReadonlyArray<Choice>,
  editing: ExplorerEditing,
  fixedBy: string | undefined,
): Editable | undefined => {
  if (isBuiltinSkill(resource)) return { kind: "builtin" };
  // A fixed profile owns the whole selection, docs included: nothing here can stage.
  if (fixedBy !== undefined) return { kind: "fixed", profile: fixedBy };
  const address = resource.address;
  if (address.kind === "docs") {
    // Docs attach to a project only; the user namespace has no attachments.
    if (editing.namespace._tag !== "project" || resource.kind !== "docs") return undefined;
    const reference = {
      sourceRegistrationId: resource.sourceRegistrationId,
      name: address.name,
    };
    return {
      kind: "docs",
      resource: reference,
      attached: editing.attachments.some(
        (attached) => docsResourceIdentity(attached) === docsResourceIdentity(reference),
      ),
    };
  }
  if (isSelectableAddress(address) === false) return undefined;
  const namespace = choiceNamespaceIdentity(editing.namespace);
  const current = choices.find(
    (choice) =>
      choiceNamespaceIdentity(choice.namespace) === namespace &&
      choice.address.sourceRegistrationId === resource.sourceRegistrationId &&
      choice.address.kind === address.kind &&
      choice.address.name === address.name,
  );
  return { kind: "choice", address, current: current?.decision };
};

/** Formats the portable address words accepted by choice and script operations. */
const addressText = (address: ResourceAddress): string =>
  `${address.kind} ${address.sourceRegistrationId}:${address.name}`;

/** Formats a dependency edge, which names a kind and a name and not yet a source. */
const dependencyText = (edge: { readonly kind: string; readonly name: string }): string =>
  `${edge.kind} ${edge.name}`;

/**
 * Names a resource by its kind and source-qualified name, such as `skill kit:review`. `source`
 * names a registration by its label, falling back to the registration ID on a label clash.
 */
export const labelledAddress = (
  address: { readonly kind: string; readonly sourceRegistrationId: string; readonly name: string },
  source: (registrationId: string) => string,
) => `${address.kind} ${source(address.sourceRegistrationId)}:${address.name}`;

/** The groups of the state block, in display order, with the label of their first line. */
const stateGroups = [
  ["user", "user"],
  ["project", "projects"],
  ["profile", "profiles"],
] as const satisfies ReadonlyArray<readonly [ActivityScope["_tag"], string]>;

/** Where a state comes from, in a few words: a pick, a fixed profile, the user scope. */
const stateNote = (destination: DestinationActivity, activity: ExplorerActivity): string =>
  [
    ...(activity.reason === "included" || activity.reason === "excluded" ? ["pick"] : []),
    ...(destination.fixedBy === undefined ? [] : [`fixed by ${destination.fixedBy}`]),
    ...(destination.scope._tag === "user" && activity.active ? ["loads in every project"] : []),
    ...(activity.viaUser === true ? ["loaded through user"] : []),
    ...(destination.appliedTo === undefined || destination.appliedTo.length === 0
      ? []
      : [`applied to ${destination.appliedTo.join(", ")}`]),
  ].join(" · ");

/**
 * The state block: the user scope, then projects, then profiles, one line each with the edited
 * destination marked. Names, states and notes line up across every group.
 */
const stateFacts = (
  address: ResourceAddress,
  destinations: ReadonlyArray<DestinationActivity>,
  edited: string | undefined,
): ReadonlyArray<readonly [string, string]> => {
  const rows = stateGroups.flatMap(([tag, label]) =>
    destinations
      .filter((destination) => destination.scope._tag === tag)
      .flatMap((destination) => {
        const activity = activityIn(destination, address);
        return activity === undefined
          ? []
          : [
              {
                label,
                name: destination.scope._tag === "user" ? "" : destination.label,
                edited: scopeKey(destination.scope) === edited,
                state: activityText(activity),
                note: stateNote(destination, activity),
              },
            ];
      }),
  );
  const nameWidth = Math.max(0, ...rows.map((row) => row.name.length));
  const stateWidth = Math.max(0, ...rows.map((row) => row.state.length));
  return rows.map(
    (row, index) =>
      [
        index > 0 && rows[index - 1]?.label === row.label ? "" : row.label,
        `${row.edited ? "›" : " "} ${row.name.padEnd(nameWidth)}  ${row.note === "" ? row.state : `${row.state.padEnd(stateWidth)}  ${row.note}`}`,
      ] as const,
  );
};

/** The folders between a source and a resource's own directory; none for built-ins or elsewhere. */
const foldersUnder = (resource: CatalogResource): ReadonlyArray<string> => {
  if (resource.origin === "builtin") return [];
  const relative = posixPath.relative(resource.sourcePath, resource.directoryPath);
  const segments = relative.split("/").filter((segment) => segment.length > 0);
  return segments.includes("..") ? [] : segments.slice(0, -1);
};

const resourceEntry = (
  resource: CatalogResource,
  report: Pick<CatalogReport, "sources">,
  choices: ReadonlyArray<Choice>,
  path: (value: string) => string,
  source: string | undefined,
  editing: ExplorerEditing | undefined,
  destinations: ReadonlyArray<DestinationActivity>,
  edited: string | undefined,
): ExplorerEntry => {
  const destination = destinations.find((item) => scopeKey(item.scope) === edited);
  const editable =
    editing === undefined
      ? undefined
      : editableOf(resource, choices, editing, destination?.fixedBy);
  const locked = isBuiltinSkill(resource);
  // A user or project selection gives the row its state; a profile's rows get it from membership.
  const activity =
    destination === undefined || editing === undefined
      ? undefined
      : activityIn(destination, resource.address);
  const facts: Array<readonly [string, string]> = [
    ["address", labelledAddress(resource.address, (id) => sourceQualifier(report, id))],
    ["origin", resource.origin],
    ["source", path(resource.sourcePath)],
    ["directory", path(resource.directoryPath)],
  ];
  if (resource.declaredPath !== undefined)
    facts.push([
      "declared by",
      `${resourceKinds[resource.kind].declarationKey}: ${resource.declaredPath}`,
    ]);
  if (resource.kind !== "docs") facts.push(["file", path(resource.filePath)]);
  if (hasActivation(resource)) {
    facts.push([
      "activation",
      `project ${activationIn(resource, "project")} · user ${activationIn(resource, "user")}`,
    ]);
    if (resource.dependencies.length > 0)
      facts.push([
        "depends on",
        resource.dependencies
          .map((item) => `${dependencyText(item)}${item.optional === true ? " (optional)" : ""}`)
          .join(", "),
      ]);
    if (resource.projects.length > 0) facts.push(["projects", resource.projects.join(", ")]);
  }
  facts.push(...stateFacts(resource.address, destinations, edited));
  if (locked) facts.push(["choices", "locked (managed by the release; saved picks ignored)"]);
  return {
    id: addressText(resource.address),
    address: resource.address,
    ...(editable === undefined ? {} : { editable }),
    ...(activity === undefined ? {} : { activity }),
    section: kindHeading(resource.kind),
    title: resource.address.name,
    description: "description" in resource ? (resource.description ?? "") : "",
    tags: [
      ...(locked ? ["built-in", "locked"] : resource.origin === "builtin" ? ["builtin"] : []),
      ...(editable?.kind === "docs" && editable.attached ? ["attached"] : []),
    ],
    facts,
    issue: false,
    tree: { ...(source === undefined ? {} : { source }), folders: foldersUnder(resource) },
    preview:
      resource.kind === "docs"
        ? {
            kind: "docs",
            path: resource.directoryPath,
            sourcePath: resource.sourcePath,
            sourceRegistrationId: resource.sourceRegistrationId,
            name: resource.address.name,
            readerConfig: resource.readerConfig,
          }
        : { kind: "file", path: resource.filePath },
  };
};

const issueEntry = (
  issue: CatalogIssue,
  index: number,
  path: (value: string) => string,
): ExplorerEntry => {
  const subject = issue.subject;
  const candidate = subject._tag === "resource" ? subject.candidatePath : undefined;
  const address = subject._tag === "resource" ? subject.address : undefined;
  return {
    id: `issue-${index}`,
    section: "Issues",
    issue: true,
    title:
      candidate === undefined
        ? `source ${path(subject.sourcePath)}`
        : address === undefined
          ? path(candidate)
          : addressText(address),
    description: issue.code,
    tags: [],
    facts: [
      ["code", issue.code],
      ["message", issue.message.replace(/\s*\n\s*/g, " ")],
      ["source", path(subject.sourcePath)],
      ...(candidate === undefined ? [] : [["file", path(candidate)] as const]),
    ],
    ...(candidate === undefined ? {} : { preview: { kind: "file" as const, path: candidate } }),
  };
};

/**
 * Projects the same catalog report and choice list as the JSON operations. `destinations` gives
 * each resource its state per destination; the edited one, named by `edited` (a
 * {@link scopeKey}), is marked, and in a user or project selection it becomes the row's activity.
 */
export const explorerEntries = (
  report: CatalogReport,
  choices: ReadonlyArray<Choice>,
  path: (value: string) => string,
  editing?: ExplorerEditing,
  destinations: ReadonlyArray<DestinationActivity> = [],
  edited: string | undefined = editing === undefined ? undefined : scopeKey(editing.namespace),
): ReadonlyArray<ExplorerEntry> => [
  ...ResourceKindSchema.literals.flatMap((kind) => {
    const resources = report.resources.filter((resource) => resource.kind === kind);
    // Sources become the top folders only when a section draws from more than one.
    const several = new Set(resources.map((resource) => resource.sourcePath)).size > 1;
    return resources.map((resource) =>
      resourceEntry(
        resource,
        report,
        choices,
        path,
        several
          ? resource.origin === "builtin"
            ? "built-in"
            : path(resource.sourcePath)
          : undefined,
        editing,
        destinations,
        edited,
      ),
    );
  }),
  ...report.issues.map((issue, index) => issueEntry(issue, index, path)),
];
