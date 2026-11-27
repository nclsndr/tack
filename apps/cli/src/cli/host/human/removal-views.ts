import { Option, Schema } from "effect";
import type {
  DocsLinkAction,
  DocsLinkApplication,
  DocsLinkOutcome,
  DocsLinkReport,
} from "../../../domain/docs/docs-schema.ts";
import {
  AdapterDisablementPlanSchema,
  AdapterDisablementResultSchema,
} from "../../../features/maintenance/adapter-disablement.ts";
import {
  SourceRemovalPlanSchema,
  SourceRemovalResultSchema,
  type SourceRemovalPlan,
} from "../../../features/maintenance/source-removal.ts";
import {
  ProjectRemovalPlanSchema,
  ProjectRemovalResultSchema,
} from "../../../features/maintenance/project-removal.ts";
import type {
  DroppedDocsAttachment,
  DroppedPick,
} from "../../../domain/reconciliation/dropped-intent-schema.ts";
import {
  ProjectRefreshCommandPlanSchema,
  ProjectRefreshCommandResultSchema,
  type ProjectRefreshChange,
  type ProjectRefreshProject,
} from "../../../domain/projects/project-refresh-schema.ts";
import {
  RemovalResultSchema,
  type RemovalPlan,
  type RemovalResult,
} from "../../../domain/reconciliation/removal-schema.ts";
import {
  HistoryClearApplicationSchema,
  HistoryClearPlanSchema,
} from "../../../features/execution/execution.ts";
import { SelectedRemovalPlanSchema } from "../../../features/maintenance/selected-removal.ts";
import type { PublicEnvelope } from "../public-outcome.ts";
import { commandLine, selectorFlags } from "../command-line.ts";
import { frameView } from "./frame.ts";
import { handMadeLines } from "./hand-made.ts";
import type { HumanView, HumanViewRegistry } from "./render.ts";
import { blockedStatusHints, retryHints, uniqueHints } from "./removal-hints.ts";
import {
  cleanupDocsRows,
  docsChanges,
  docsRows,
  docsSummary,
  labelLines,
  pendingRows,
  removalAppliedSummary,
  removalHasChanges,
  removalPreviewSummary,
  removalRows,
  removalScopeBlock,
  removalScopeText,
  rowLines,
  spansTargets,
  statementLines,
  targetSummaryLines,
  type Row,
} from "./removal-rows.ts";
import type { Style } from "./style.ts";
import { cell, flow, paragraph, type Paint } from "./text.ts";
import { headingLines, namespaceText, plural } from "./view.ts";

// Decoding

/** The decoded payload slots of a preview/apply envelope. */
type Slots<Plan, Applied> = { readonly plan: Plan; readonly applied: Applied | undefined };

/** Decodes the plan slot, and the applied slot when it is filled; either failing declines. */
const decodeSlots = <Plan, Applied>(
  envelope: PublicEnvelope,
  decodePlan: (input: unknown) => Option.Option<Plan>,
  decodeApplied: (input: unknown) => Option.Option<Applied>,
): Option.Option<Slots<Plan, Applied>> =>
  Option.flatMap(decodePlan(envelope.plan), (plan): Option.Option<Slots<Plan, Applied>> =>
    envelope.applied === null
      ? Option.some({ plan, applied: undefined })
      : Option.map(decodeApplied(envelope.applied), (applied) => ({ plan, applied })),
  );

/** A failure carries no payload: it shows its diagnostics and the commands they name as the fix. */
const withFailure =
  (view: HumanView): HumanView =>
  (envelope, style, details) =>
    envelope.status === "failure" && envelope.plan === null && envelope.applied === null
      ? frameView(envelope, style, { body: [], hints: envelope.next })
      : view(envelope, style, details);

const decodeSelectedRemovalPlan = Schema.decodeUnknownOption(SelectedRemovalPlanSchema);
const decodeRemovalResult = Schema.decodeUnknownOption(RemovalResultSchema);
const decodeAdapterPlan = Schema.decodeUnknownOption(AdapterDisablementPlanSchema);
const decodeAdapterResult = Schema.decodeUnknownOption(AdapterDisablementResultSchema);
const decodeSourcePlan = Schema.decodeUnknownOption(SourceRemovalPlanSchema);
const decodeSourceResult = Schema.decodeUnknownOption(SourceRemovalResultSchema);
const decodeProjectPlan = Schema.decodeUnknownOption(ProjectRemovalPlanSchema);
const decodeProjectResult = Schema.decodeUnknownOption(ProjectRemovalResultSchema);
const decodeRefreshPlan = Schema.decodeUnknownOption(ProjectRefreshCommandPlanSchema);
const decodeRefreshResult = Schema.decodeUnknownOption(ProjectRefreshCommandResultSchema);
const decodeHistoryPlan = Schema.decodeUnknownOption(HistoryClearPlanSchema);
const decodeHistoryResult = Schema.decodeUnknownOption(HistoryClearApplicationSchema);

// Shared cleanup body

/** The docs links a cleanup removes, as summary phrases. */
const cleanupDocsSummary = (plan: RemovalPlan, applied: RemovalResult | undefined) =>
  applied === undefined
    ? docsSummary({ actions: plan.docsActions ?? [] }, false)
    : docsAppliedSummary(applied.docsActions ?? []);

/** Summary phrases of one cleanup, as a preview or as an application. */
const cleanupSummary = (plan: RemovalPlan, applied: RemovalResult | undefined) =>
  applied === undefined
    ? [...removalPreviewSummary(plan), ...cleanupDocsSummary(plan, applied)]
    : [...removalAppliedSummary(applied), ...cleanupDocsSummary(plan, applied)];

/**
 * The count per adapter and target, the action rows (capped unless `details`), docs rows and
 * retained obligations of one cleanup.
 */
const cleanupBlocks = (
  plan: RemovalPlan,
  applied: RemovalResult | undefined,
  style: Style,
  showTarget: boolean,
  details: boolean,
): ReadonlyArray<ReadonlyArray<string>> => {
  const actions = removalRows(plan, applied, style, showTarget, details);
  const docs = cleanupDocsRows(plan, applied, style);
  const docsPending = applied?.docsPending ?? [];
  return [
    targetSummaryLines(plan, applied, style),
    actions.length === 0 ? [] : [style.bold("Actions"), ...actions],
    docs.length === 0 ? [] : [style.bold("Docs links"), ...docs],
    applied === undefined || (applied.pending.length === 0 && docsPending.length === 0)
      ? []
      : [style.bold("Pending cleanup"), ...pendingRows(applied.pending, docsPending, style)],
  ];
};

/** What finalizing the projects of a preview will do once cleanup settles. */
const finalizeLines = (plan: RemovalPlan, style: Style): ReadonlyArray<string> => {
  if (!plan.finalizeProject) return [];
  const names =
    plan.scope._tag === "maintenance"
      ? (plan.expectedProjects ?? []).map((project) => project.name)
      : plan.scope._tag === "project" || plan.scope._tag === "project-root"
        ? [plan.scope.projectName]
        : [];
  return names.length === 0
    ? []
    : paragraph(
        `Registration of ${plural(names.length, "project")} ${names.join(", ")} is removed once all its cleanup settles.`,
        { width: style.width, paint: style.dim },
      );
};

// clean, retry, reset

type SelectedCommand = "clean" | "reset" | "retry";

/** The flags that reproduce the selection a `clean` or `retry` echoes. */
const selectionArgs = (selection: (typeof SelectedRemovalPlanSchema.Type)["selection"]) => {
  if (selection === undefined) return [];
  if (selection.selector._tag !== "bare") return selectorFlags(selection.selector);
  return selection.containingRoot === undefined ? [] : ["--cwd", selection.containingRoot.root];
};

const selectedRemovalView = (command: SelectedCommand): HumanView =>
  withFailure((envelope, style, details) =>
    Option.match(decodeSlots(envelope, decodeSelectedRemovalPlan, decodeRemovalResult), {
      onNone: () => undefined,
      onSome: ({ plan, applied }) => {
        const selection = plan.selection;
        const summary = cleanupSummary(plan, applied);
        const stateDeleted =
          applied !== undefined &&
          command === "reset" &&
          applied.pending.length === 0 &&
          (applied.docsPending ?? []).length === 0 &&
          applied.actions.every((outcome) => outcome._tag === "applied");
        return frameView(envelope, style, {
          scope:
            selection?.selector._tag === "bare"
              ? `project ${selection.containingRoot?.projectName ?? "unknown"}`
              : selection?.selector._tag === "all"
                ? "all projects and user"
                : removalScopeText(plan.scope),
          body: [
            statementLines(
              applied !== undefined,
              stateDeleted ? [...summary, "Tack state deleted"] : summary,
              "Nothing to remove.",
              style,
            ),
            removalScopeBlock(plan.scope, selection?.containingRoot?.root, style),
            ...(selection?.containingRoot !== undefined &&
            plan.scope._tag !== "selected-targets" &&
            plan.scope._tag !== "retry-targets"
              ? [
                  paragraph(
                    `selected from the containing root ${style.path(selection.containingRoot.root)}`,
                    { width: style.width, paint: style.dim },
                  ),
                ]
              : []),
            ...cleanupBlocks(plan, applied, style, spansTargets([plan]), details === true),
            applied === undefined ? finalizeLines(plan, style) : [],
          ],
          hints: uniqueHints(
            applied === undefined
              ? [
                  ...(removalHasChanges(plan)
                    ? [
                        command === "reset"
                          ? commandLine("reset", ...selectionArgs(selection), "--apply")
                          : plan.scope._tag === "retry-targets" || plan.scope._tag === "maintenance"
                            ? commandLine(
                                "retry",
                                "--pending",
                                ...selectionArgs(selection),
                                "--apply",
                              )
                            : commandLine("clean", ...selectionArgs(selection), "--apply"),
                      ]
                    : []),
                  ...blockedStatusHints([plan]),
                ]
              : command === "reset"
                ? applied.actions.some((outcome) => outcome._tag !== "applied")
                  ? [commandLine("reset", "--apply")]
                  : []
                : retryHints([applied]),
          ),
        });
      },
    }),
  );

// adapter disable

const enabledText = (adapters: ReadonlyArray<string>) =>
  adapters.length === 0 ? "none" : adapters.join(", ");

const adapterDisableView: HumanView = withFailure((envelope, style, details) =>
  Option.match(decodeSlots(envelope, decodeAdapterPlan, decodeAdapterResult), {
    onNone: () => undefined,
    onSome: ({ plan, applied }) => {
      const removal = applied?.removal;
      const enabledValue =
        applied !== undefined
          ? `now ${enabledText(applied.enabledAdapters)}`
          : plan.expectedEnabledAdapters.includes(plan.adapter)
            ? `${enabledText(plan.expectedEnabledAdapters)} → ${enabledText(plan.enabledAdapters)}`
            : `${enabledText(plan.expectedEnabledAdapters)} (${plan.adapter} is not enabled)`;
      const settingChanges = plan.enabledAdapters.length !== plan.expectedEnabledAdapters.length;
      return frameView(envelope, style, {
        scope: `adapter ${plan.adapter}`,
        body: [
          statementLines(
            applied !== undefined,
            cleanupSummary(plan.removal, removal),
            "Nothing to remove.",
            style,
          ),
          [
            ...removalScopeBlock(plan.removal.scope, undefined, style),
            ...labelLines("Enabled adapters", enabledValue, style),
          ],
          ...cleanupBlocks(
            plan.removal,
            removal,
            style,
            spansTargets([plan.removal]),
            details === true,
          ),
        ],
        hints: uniqueHints(
          removal === undefined
            ? [
                ...(removalHasChanges(plan.removal) || settingChanges
                  ? [commandLine("adapter-disable", plan.adapter, "--apply")]
                  : []),
                ...blockedStatusHints([plan.removal]),
              ]
            : // Every target can hold links of the adapter, so a settled disable is checked everywhere.
              retryHints([removal]).length === 0
              ? [commandLine("status", "--all")]
              : retryHints([removal]),
        ),
      });
    },
  }),
);

// source remove, project remove

/** Summary phrases for the picks and docs attachments a removal deletes. */
const intentSummary = (
  picks: ReadonlyArray<DroppedPick>,
  attachments: ReadonlyArray<DroppedDocsAttachment>,
  applied: boolean,
) => {
  const verb = applied ? "deleted" : "to delete";
  return [
    ...(picks.length === 0 ? [] : [`${plural(picks.length, "pick")} ${verb}`]),
    ...(attachments.length === 0
      ? []
      : [`${plural(attachments.length, "docs attachment")} ${applied ? "detached" : "to detach"}`]),
  ];
};

/** The picks and docs attachments a removal deletes, one block each. */
const intentBlocks = (
  picks: ReadonlyArray<DroppedPick>,
  attachments: ReadonlyArray<DroppedDocsAttachment>,
  style: Style,
): ReadonlyArray<ReadonlyArray<string>> => [
  picks.length === 0
    ? []
    : [
        style.bold("Picks"),
        ...rowLines(
          picks.map((pick): Row => ({
            cells: [
              cell(namespaceText(pick.namespace, "label")),
              cell(`${pick.address.kind} ${pick.address.name}`),
              cell(pick.decision, style.dim),
            ],
            notes: [],
            paintNotes: style.dim,
          })),
          style,
        ),
      ],
  attachments.length === 0
    ? []
    : [
        style.bold("Docs attachments"),
        ...rowLines(
          attachments.map((attachment): Row => ({
            cells: [
              cell(`project ${attachment.projectName}`),
              cell(attachment.name),
              cell(attachment.writingDefault === true ? "writing default" : "", style.dim),
            ],
            notes: [],
            paintNotes: style.dim,
          })),
          style,
        ),
      ],
];

const profileRows = (plan: SourceRemovalPlan, style: Style): ReadonlyArray<string> =>
  plan.profileApplications.length === 0
    ? []
    : [
        style.bold("Fixed profile applications"),
        ...rowLines(
          plan.profileApplications.map((application): Row => ({
            cells: [
              cell(
                application.outcome === "dropped" ? "− drop" : "! keep",
                application.outcome === "dropped" ? style.red : style.yellow,
              ),
              cell(namespaceText(application.namespace, "label")),
              cell(application.profileName),
            ],
            notes: [
              application.outcome === "dropped"
                ? "returns to daily selection on its next sync, which can deliver other resources"
                : `members that no longer resolve: ${application.members.map((member) => member.name).join(", ")}`,
            ],
            paintNotes: style.dim,
          })),
          style,
        ),
      ];

const dependantRows = (plan: SourceRemovalPlan, style: Style): ReadonlyArray<string> =>
  plan.dependants.length === 0
    ? []
    : [
        style.bold("Dependants"),
        ...rowLines(
          plan.dependants.map((dependant): Row => ({
            cells: [
              cell("!", style.yellow),
              cell(dependant.label ?? dependant.sourceRegistrationId),
              cell(
                dependant.reason === "depends-on"
                  ? "declares this source in depends-on"
                  : "binds this source in its bundle",
                style.dim,
              ),
            ],
            notes: [
              dependant.reason === "depends-on"
                ? "its resources that require a resource of this source become blocked"
                : "it becomes unhealthy",
            ],
            paintNotes: style.dim,
          })),
          style,
        ),
      ];

const sourceRemoveView: HumanView = withFailure((envelope, style, details) =>
  Option.match(decodeSlots(envelope, decodeSourcePlan, decodeSourceResult), {
    onNone: () => undefined,
    onSome: ({ plan, applied }) => {
      const removal = applied?.removal;
      const name = plan.source.label ?? plan.source.id;
      return frameView(envelope, style, {
        scope: `source ${name}`,
        body: [
          statementLines(
            applied !== undefined,
            [
              ...cleanupSummary(plan.removal, removal),
              ...intentSummary(plan.picks, plan.docsAttachments, applied !== undefined),
              applied === undefined
                ? "1 source registration to remove"
                : "1 source registration removed",
            ],
            "Nothing to remove.",
            style,
            "Add --apply to remove the source.",
          ),
          [
            ...labelLines("Source", `${name}  ${style.path(plan.source.canonicalPath)}`, style),
            ...removalScopeBlock(plan.removal.scope, undefined, style),
          ],
          ...cleanupBlocks(
            plan.removal,
            removal,
            style,
            spansTargets([plan.removal]),
            details === true,
          ),
          ...intentBlocks(plan.picks, plan.docsAttachments, style),
          profileRows(plan, style),
          dependantRows(plan, style),
        ],
        hints: uniqueHints(
          removal === undefined
            ? [commandLine("source-remove", name, "--apply"), ...blockedStatusHints([plan.removal])]
            : retryHints([removal]),
        ),
      });
    },
  }),
);

const projectRemoveView: HumanView = withFailure((envelope, style, details) =>
  Option.match(decodeSlots(envelope, decodeProjectPlan, decodeProjectResult), {
    onNone: () => undefined,
    onSome: ({ plan, applied }) => {
      const removal = applied?.removal;
      const application = plan.profileApplication;
      return frameView(envelope, style, {
        scope: `project ${plan.project}`,
        body: [
          statementLines(
            applied !== undefined,
            [
              ...cleanupSummary(plan.removal, removal),
              ...intentSummary(plan.picks, plan.docsAttachments, applied !== undefined),
              // A finalized removal already says "1 project registration removed".
              ...(removal === undefined || removal.finalizedProject
                ? []
                : ["project kept until its cleanup settles"]),
            ],
            "The project holds no links, picks or docs attachments.",
            style,
          ),
          removalScopeBlock(plan.removal.scope, undefined, style),
          ...cleanupBlocks(
            plan.removal,
            removal,
            style,
            spansTargets([plan.removal]),
            details === true,
          ),
          ...intentBlocks(plan.picks, plan.docsAttachments, style),
          application === undefined
            ? []
            : labelLines("Fixed profile application", `${application.profileName}, dropped`, style),
          applied === undefined ? finalizeLines(plan.removal, style) : [],
        ],
        hints: uniqueHints(
          removal === undefined
            ? [
                commandLine("project-remove", plan.project, "--apply"),
                ...blockedStatusHints([plan.removal]),
              ]
            : removal.finalizedProject
              ? []
              : [commandLine("project-remove", plan.project, "--apply")],
        ),
      });
    },
  }),
);

// docs reconcile

/** The project a docs report is about, when its actions name exactly one. */
const docsProject = (actions: ReadonlyArray<DocsLinkAction>) => {
  const names = [...new Set(actions.map((action) => action.evidence.projectName))];
  return names.length === 1 ? names[0] : undefined;
};

const docsIssueLines = (
  issues: ReadonlyArray<{ readonly code: string; readonly message: string }>,
  style: Style,
): ReadonlyArray<string> =>
  issues.length === 0
    ? []
    : [
        style.bold("Issues"),
        ...issues.flatMap((issue) => [
          ...flow([cell("!", style.yellow), cell(issue.code)], {
            width: style.width,
            indent: 2,
            hang: 4,
          }),
          ...paragraph(issue.message, { width: style.width, indent: 6, paint: style.dim }),
        ]),
      ];

/** Summary phrases of a docs application, set against the actions its plan chose. */
const docsAppliedSummary = (applied: ReadonlyArray<DocsLinkOutcome>): ReadonlyArray<string> => {
  const count = (select: (item: DocsLinkOutcome) => boolean) => applied.filter(select).length;
  const created = count(
    (outcome) => outcome._tag === "applied" && outcome.action.action === "create",
  );
  const removed = count(
    (outcome) => outcome._tag === "applied" && outcome.action.action === "remove",
  );
  const kept = count((outcome) => outcome._tag === "applied" && outcome.action.action === "keep");
  const failed = count((outcome) => outcome._tag === "failed");
  const blocked = count((outcome) => outcome._tag === "blocked");
  const unattempted = count((outcome) => outcome._tag === "skipped");
  const phrase = (value: number, text: string) =>
    value === 0 ? [] : [`${plural(value, "docs link")} ${text}`];
  return [
    ...phrase(created, "created"),
    ...phrase(removed, "removed"),
    ...phrase(kept, "unchanged"),
    ...phrase(failed, "failed"),
    ...phrase(blocked, "skipped (conflict)"),
    ...phrase(unattempted, "not attempted"),
  ];
};

/** One project's docs part of a sync, ready to place in the sync frame. */
export type DocsSyncPart = {
  /** The project the part's actions name, when they name exactly one. */
  readonly project: string | undefined;
  /** True when the part has no action and no issue, so it has nothing of its own to show. */
  readonly empty: boolean;
  readonly body: ReadonlyArray<ReadonlyArray<string>>;
  readonly hints: ReadonlyArray<string>;
};

/**
 * The docs part of a sync for one project. `flags` are the narrowing flags of the request, repeated
 * on the apply and retry commands so that they cannot do more than the preview showed.
 */
export const docsSyncPart = (
  plan: DocsLinkReport,
  applied: DocsLinkApplication | undefined,
  flags: ReadonlyArray<string>,
  style: Style,
): DocsSyncPart => {
  const project = docsProject(plan.actions);
  const rows = docsRows(plan.actions, applied?.actions, style);
  const issues = (applied ?? plan).issues;
  const hasConflict = (applied?.actions ?? []).some(
    (outcome) => outcome._tag === "blocked" || outcome._tag === "failed",
  );
  const unattempted = (applied?.actions ?? []).some((outcome) => outcome._tag === "skipped");
  return {
    project,
    empty: plan.actions.length === 0 && issues.length === 0,
    body: [
      statementLines(
        applied !== undefined,
        applied === undefined ? docsSummary(plan, false) : docsAppliedSummary(applied.actions),
        "There are no docs links to reconcile.",
        style,
      ),
      rows.length === 0 ? [] : [style.bold("Docs links"), ...rows],
      docsIssueLines(issues, style),
    ],
    hints:
      project === undefined
        ? []
        : applied === undefined
          ? docsChanges(plan.actions) > 0
            ? [commandLine("sync", "--project", project, ...flags, "--apply")]
            : []
          : hasConflict || unattempted
            ? [commandLine("sync", "--project", project, ...flags)]
            : [],
  };
};

// history clear

const historyClearView: HumanView = withFailure((envelope, style) =>
  Option.match(decodeSlots(envelope, decodeHistoryPlan, decodeHistoryResult), {
    onNone: () => undefined,
    onSome: ({ plan, applied }) =>
      frameView(envelope, style, {
        body: [
          statementLines(
            applied !== undefined,
            applied === undefined
              ? plan.count === 0
                ? []
                : [`${plural(plan.count, "run record")} would be removed`]
              : applied.removedCount === 0
                ? []
                : [
                    `${plural(applied.removedCount, "run record")} removed${
                      applied.removedCount === plan.count ? "" : ` (${plan.count} were planned)`
                    }`,
                  ],
            applied === undefined
              ? "There is no run history to clear."
              : plan.count === 0
                ? "There was no run history to clear."
                : `No run records were removed (${plan.count} were planned).`,
            style,
          ),
        ],
        hints:
          applied === undefined && plan.count > 0 ? [commandLine("history-clear", "--apply")] : [],
      }),
  }),
);

// project refresh

const changeCount = (project: ProjectRefreshProject) =>
  project.additions.length + project.reactivations.length + project.removals.length;

const removalDetail = (removal: ProjectRefreshProject["removals"][number]) =>
  [
    ...(removal.finalProject ? ["final root of the project"] : []),
    ...(removal.hasManagedEvidence ? ["has managed links"] : []),
    ...(removal.rootReachable ? [] : ["root unreachable"]),
  ].join(" · ");

const refreshPreviewRows = (project: ProjectRefreshProject, style: Style) => {
  const row = (lead: string, paint: Paint, path: string, detail = ""): Row => ({
    cells: [cell(lead, paint), cell(style.path(path)), cell(detail, style.dim)],
    notes: [],
    paintNotes: style.dim,
  });
  return rowLines(
    [
      ...project.additions.map((path) => row("+ add", style.green, path)),
      ...project.reactivations.map((path) => row("+ reactivate", style.green, path)),
      ...project.removals.map((removal) =>
        row(`− ${removal.action}`, style.red, removal.canonicalRoot, removalDetail(removal)),
      ),
    ],
    style,
  );
};

const changeVerb = (change: ProjectRefreshChange) =>
  change.action === "added"
    ? "add"
    : change.action === "reactivated"
      ? "reactivate"
      : change.action === "deregistered"
        ? "deregister"
        : "handoff";

const refreshChangeRows = (changes: ReadonlyArray<ProjectRefreshChange>, style: Style) =>
  rowLines(
    changes.map((change): Row => ({
      cells: [
        cell("✓ applied", style.green),
        cell(changeVerb(change)),
        cell(style.path(change.canonicalRoot)),
      ],
      notes: [],
      paintNotes: style.dim,
    })),
    style,
  );

/** One project's block: its heading with the number of root changes, then their rows. */
const projectBlock = (
  name: string,
  count: number,
  rows: ReadonlyArray<string>,
  style: Style,
): ReadonlyArray<string> => [
  ...headingLines(
    `Project ${name}`,
    count === 0 ? "no root changes" : plural(count, "root change"),
    style,
  ),
  ...rows,
];

/**
 * One block per project: the root changes a preview plans, or those an application made, which
 * can name a project the plan did not.
 */
const projectBlocks = (
  plan: typeof ProjectRefreshCommandPlanSchema.Type,
  applied: typeof ProjectRefreshCommandResultSchema.Type | undefined,
  style: Style,
): ReadonlyArray<ReadonlyArray<string>> => {
  if (applied === undefined)
    return plan.refresh.projects.map((project) =>
      projectBlock(
        project.expectedProject.name,
        changeCount(project),
        refreshPreviewRows(project, style),
        style,
      ),
    );
  const names = [
    ...new Set([
      ...plan.refresh.projects.map((project) => project.expectedProject.name),
      ...applied.refresh.changes.map((change) => change.projectName),
    ]),
  ];
  return names.map((name) => {
    const changes = applied.refresh.changes.filter((change) => change.projectName === name);
    return projectBlock(name, changes.length, refreshChangeRows(changes, style), style);
  });
};

const refreshCleanupBlocks = (
  plan: typeof ProjectRefreshCommandPlanSchema.Type,
  applied: typeof ProjectRefreshCommandResultSchema.Type | undefined,
  style: Style,
  details: boolean,
): ReadonlyArray<ReadonlyArray<string>> =>
  plan.removals.flatMap((removal, index) => {
    const result = applied?.removals[index];
    return [
      [
        ...removalScopeBlock(removal.scope, undefined, style, "Cleanup targets"),
        ...(applied !== undefined && result === undefined
          ? paragraph("No result was recorded for this cleanup; it was not applied.", {
              width: style.width,
              indent: 2,
              paint: style.yellow,
            })
          : []),
      ],
      ...cleanupBlocks(removal, result, style, spansTargets([removal]), details),
    ];
  });

/** A root refresh added or brought back has no links yet: sync the projects that gained one. */
const linkNewRootHints = (changes: ReadonlyArray<ProjectRefreshChange>) =>
  [
    ...new Set(
      changes.flatMap((change) =>
        change.action === "added" || change.action === "reactivated" ? [change.projectName] : [],
      ),
    ),
  ].flatMap((name) => [
    commandLine("sync", "--project", name),
    commandLine("sync", "--project", name, "--apply"),
  ]);

const projectRefreshView: HumanView = withFailure((envelope, style, details) =>
  Option.match(decodeSlots(envelope, decodeRefreshPlan, decodeRefreshResult), {
    onNone: () => undefined,
    onSome: ({ plan, applied }) => {
      const rootChanges =
        applied === undefined
          ? plan.refresh.projects.reduce((total, project) => total + changeCount(project), 0)
          : applied.refresh.changes.length;
      const summary = [
        ...(rootChanges === 0 ? [] : [plural(rootChanges, "root change")]),
        ...plan.removals.flatMap((removal, index) =>
          cleanupSummary(removal, applied?.removals[index]),
        ),
        ...(applied === undefined
          ? docsSummary(plan.docs, false)
          : docsAppliedSummary(applied.docs.actions)),
        ...(applied !== undefined && applied.refresh.removedProjects.length > 0
          ? [
              `${plural(applied.refresh.removedProjects.length, "project")} removed (${applied.refresh.removedProjects.join(", ")})`,
            ]
          : []),
      ];
      const docsBlock = docsRows(plan.docs.actions, applied?.docs.actions, style);
      const scopeArgs =
        plan.selection.selector._tag !== "bare"
          ? selectorFlags(plan.selection.selector)
          : plan.selection.cwd === undefined
            ? []
            : ["--cwd", plan.selection.cwd];
      const hasChanges =
        plan.refresh.projects.some((project) => changeCount(project) > 0) ||
        plan.removals.some(removalHasChanges) ||
        docsChanges(plan.docs.actions) > 0;
      return frameView(envelope, style, {
        scope:
          plan.refresh.scope._tag === "project"
            ? `project ${plan.refresh.scope.projectName}`
            : "all projects",
        body: [
          statementLines(applied !== undefined, summary, "Everything is up to date.", style),
          ...projectBlocks(plan, applied, style),
          handMadeLines(plan.handMade, style),
          ...refreshCleanupBlocks(plan, applied, style, details === true),
          docsBlock.length === 0 ? [] : [style.bold("Docs links"), ...docsBlock],
          docsIssueLines((applied ?? plan).docs.issues, style),
        ],
        hints: uniqueHints(
          applied === undefined
            ? [
                ...(hasChanges ? [commandLine("project-refresh", ...scopeArgs, "--apply")] : []),
                ...blockedStatusHints(plan.removals),
              ]
            : [
                ...retryHints(applied.removals, applied.refresh.removedProjects),
                ...[
                  ...new Set(
                    applied.docs.actions.flatMap((action) =>
                      action._tag !== "applied" ? [action.action.evidence.projectName] : [],
                    ),
                  ),
                ].map((name) => commandLine("sync", "--no-adapters", "--project", name)),
                ...linkNewRootHints(applied.refresh.changes),
              ],
        ),
      });
    },
  }),
);

/** Dedicated views for the preview/apply operations that remove or reconcile. */
export const removalViews: HumanViewRegistry = {
  "adapter disable": adapterDisableView,
  "state clean": selectedRemovalView("clean"),
  "script history clear": historyClearView,
  "project refresh": projectRefreshView,
  "project remove": projectRemoveView,
  "source remove": sourceRemoveView,
  "state reset": selectedRemovalView("reset"),
};
