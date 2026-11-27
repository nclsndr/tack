import type {
  DocsLinkAction,
  DocsLinkOutcome,
  DocsManagedLink,
  DocsPendingRemoval,
  DocsLinkReport,
} from "../../domain/docs/docs-schema.ts";
import type {
  RemovalAction,
  RemovalActionOutcome,
  RemovalPlan,
  RemovalResult,
  RemovalScope,
} from "../../domain/reconciliation/removal-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import type {
  ManagedLinkEvidence,
  ManagedLinkTarget,
} from "../../domain/links/managed-link-schema.ts";
import type { ReportedPendingRemoval as PendingRemoval } from "../../domain/links/pending-removal-schema.ts";
import type { Style } from "./style.ts";
import { cell, flow, paragraph, table, tableRows, type Cell, type Paint } from "./text.ts";
import { addressText, capRows, plural } from "./view.ts";

/**
 * One row of a removal block: its cells (what happens, to which path, about which resource) and the
 * sentences under it, such as why an action failed. Every row of one block has the same cells.
 */
export type Row = {
  readonly cells: ReadonlyArray<Cell>;
  readonly notes: ReadonlyArray<string>;
  readonly paintNotes: Paint;
};

/**
 * Lays the rows of one block out as one table, so they share their columns, with each row's notes
 * wrapped under it.
 */
export const rowLines = (rows: ReadonlyArray<Row>, style: Style): ReadonlyArray<string> => {
  const groups = tableRows(
    rows.map((row) => row.cells),
    { width: style.width },
  );
  return rows.flatMap((row, index) => [
    // The table's lines for this row: one group per row, in row order.
    ...groups.slice(index, index + 1).flat(),
    ...row.notes.flatMap((note) =>
      paragraph(note, { width: style.width, indent: 6, paint: row.paintNotes }),
    ),
  ]);
};

/** How a removal row reads: the symbol and word of the action or of its outcome. */
const removalVerb = (action: RemovalAction) =>
  action._tag === "remove" ? "remove" : action._tag === "retire" ? "forget" : "blocked";

const targetLabel = (target: ManagedLinkTarget) =>
  target._tag === "project-root" ? `project ${target.projectName}` : "user";

const pendingAnnotation = (pending: PendingRemoval | undefined) =>
  pending === undefined ? [] : [`pending (${pending.cause})`];

const pendingNotes = (pending: PendingRemoval | undefined) =>
  pending?.lastResult === undefined
    ? []
    : [`last attempt ${pending.lastResult._tag}: ${pending.lastResult.message}`];

const actionDetail = (
  action: RemovalAction,
  pending: PendingRemoval | undefined,
  showTarget: boolean,
  style: Style,
) =>
  [
    addressText(action.evidence.address, style),
    action.evidence.adapter,
    ...(showTarget ? [targetLabel(action.evidence.target)] : []),
    ...pendingAnnotation(pending),
  ].join(" · ");

const previewRow = (
  action: RemovalAction,
  pending: PendingRemoval | undefined,
  showTarget: boolean,
  style: Style,
): Row => {
  const lead =
    action._tag === "remove"
      ? cell(`− ${removalVerb(action)}`, style.red)
      : action._tag === "retire"
        ? cell(`· ${removalVerb(action)}`, style.dim)
        : cell(`! ${removalVerb(action)}`, style.yellow);
  return {
    cells: [
      lead,
      cell(style.path(action.destinationPath)),
      cell(actionDetail(action, pending, showTarget, style), style.dim),
    ],
    notes: [
      ...(action._tag === "blocked" ? [`blocked: ${action.message}`] : []),
      ...(action._tag === "remove" && action.alsoReachedBy !== undefined
        ? [
            `also reached by ${action.alsoReachedBy.join(", ")} through a directory alias; they lose this link too`,
          ]
        : []),
      ...pendingNotes(pending),
    ],
    paintNotes: action._tag === "blocked" ? style.yellow : style.dim,
  };
};

const outcomeRow = (
  outcome: RemovalActionOutcome,
  pending: PendingRemoval | undefined,
  showTarget: boolean,
  style: Style,
): Row => ({
  cells: [
    outcome._tag === "applied"
      ? cell("✓ applied", style.green)
      : outcome._tag === "failed"
        ? cell("✗ failed", style.red)
        : cell("− skipped", style.yellow),
    cell(removalVerb(outcome.action)),
    cell(style.path(outcome.action.destinationPath)),
    cell(actionDetail(outcome.action, pending, showTarget, style), style.dim),
  ],
  notes:
    outcome._tag === "failed"
      ? [`failed (${outcome.code}): ${outcome.message}`]
      : outcome._tag === "skipped"
        ? [`skipped: ${outcome.reason}`]
        : [],
  paintNotes: outcome._tag === "failed" ? style.red : style.yellow,
});

// Docs links

const docsDetail = (evidence: DocsManagedLink, style: Style) =>
  `${addressText({ sourceRegistrationId: evidence.resource.sourceRegistrationId, kind: "docs", name: evidence.resource.name }, style)} · project ${evidence.projectName}`;

const docsPreviewRow = (action: DocsLinkAction, style: Style): Row => ({
  cells: [
    action.action === "create"
      ? cell(`+ ${action.action}`, style.green)
      : action.action === "remove"
        ? cell(`− ${action.action}`, style.red)
        : action.action === "keep"
          ? cell(`· ${action.action}`, style.dim)
          : cell(`! ${action.action}`, style.yellow),
    cell(style.path(action.evidence.destinationPath)),
    cell(docsDetail(action.evidence, style), style.dim),
  ],
  notes: action.action === "conflict" ? [`${action.action}: ${action.message}`] : [],
  paintNotes: style.yellow,
});

/** One docs row after an application, using its explicit outcome and planned action. */
const docsOutcomeRow = (outcome: DocsLinkOutcome, style: Style): Row => {
  const planned = outcome.action;
  const evidence = planned.evidence;
  const [lead, verb, notes] = ((): readonly [Cell, string, ReadonlyArray<string>] => {
    if (outcome._tag === "skipped")
      return [
        cell("− skipped", style.yellow),
        planned.action,
        ["skipped: the application stopped before this action"],
      ];
    if (outcome._tag === "applied")
      return planned.action === "keep"
        ? [cell("· kept", style.dim), "keep", []]
        : [cell("✓ applied", style.green), planned.action, []];
    return outcome._tag === "blocked"
      ? [cell("− skipped", style.yellow), "conflict", [`skipped: ${outcome.message}`]]
      : [cell("✗ failed", style.red), planned.action, [`failed: ${outcome.message}`]];
  })();
  return {
    cells: [
      lead,
      cell(verb),
      cell(style.path(evidence.destinationPath)),
      cell(docsDetail(evidence, style), style.dim),
    ],
    notes,
    paintNotes: outcome._tag === "failed" ? style.red : style.yellow,
  };
};

/** Docs rows for a preview, or for an application aligned with the actions the plan chose. */
export const docsRows = (
  planned: ReadonlyArray<DocsLinkAction>,
  applied: ReadonlyArray<DocsLinkOutcome> | undefined,
  style: Style,
): ReadonlyArray<string> =>
  rowLines(
    applied === undefined
      ? planned.map((action) => docsPreviewRow(action, style))
      : applied.map((outcome) => docsOutcomeRow(outcome, style)),
    style,
  );

/** Docs rows for the links a cleanup removes: the plan's evidence, or the application's actions. */
export const cleanupDocsRows = (
  plan: RemovalPlan,
  applied: RemovalResult | undefined,
  style: Style,
): ReadonlyArray<string> => {
  const planned = plan.docsActions ?? [];
  return applied === undefined
    ? docsRows(planned, undefined, style)
    : docsRows(planned, applied.docsActions ?? [], style);
};

/** The number of docs links a docs report would create or remove. */
export const docsChanges = (actions: ReadonlyArray<DocsLinkAction>) =>
  actions.filter(({ action }) => action === "create" || action === "remove").length;

/** Docs counts as summary phrases: `1 docs link to create`, or `1 docs link created`. */
export const docsSummary = (
  report: Pick<DocsLinkReport, "actions">,
  applied: boolean,
): ReadonlyArray<string> => {
  const count = (action: DocsLinkAction["action"]) =>
    report.actions.filter((candidate) => candidate.action === action).length;
  const phrase = (action: DocsLinkAction["action"], preview: string, done: string) =>
    count(action) === 0
      ? []
      : [`${plural(count(action), "docs link")} ${applied ? done : preview}`];
  return [
    ...phrase("create", "to create", "created"),
    ...phrase("remove", "to remove", "removed"),
    ...phrase("keep", "unchanged", "unchanged"),
    ...(count("conflict") === 0 ? [] : [plural(count("conflict"), "docs conflict")]),
  ];
};

// Removal actions

/** The items of a list that need the operator first, then the rest, each part in its own order. */
const attentionFirst = <A>(items: ReadonlyArray<A>, needsAttention: (item: A) => boolean) => [
  ...items.filter((item) => needsAttention(item) === true),
  ...items.filter((item) => needsAttention(item) === false),
];

/**
 * The rows of one removal plan, or of its outcomes after an application: those that need the
 * operator first (blocked, failed, skipped), then the first others up to the cap, unless `details`.
 */
export const removalRows = (
  plan: RemovalPlan,
  applied: RemovalResult | undefined,
  style: Style,
  showTarget: boolean,
  details: boolean,
): ReadonlyArray<string> => {
  const pendingAt = (destinationPath: string) =>
    plan.expectedPendingRemovals.find((pending) => pending.destinationPath === destinationPath);
  const { shown, more } = capRows(
    applied === undefined
      ? attentionFirst(plan.actions, (action) => action._tag === "blocked").map((action) =>
          previewRow(action, pendingAt(action.destinationPath), showTarget, style),
        )
      : attentionFirst(applied.actions, (outcome) => outcome._tag !== "applied").map((outcome) =>
          outcomeRow(outcome, pendingAt(outcome.action.destinationPath), showTarget, style),
        ),
    details,
  );
  return [...rowLines(shown, style), ...more];
};

/** What the target summary of a removal groups by: the adapter and the user or the project. */
const tallyKey = ({ adapter, target }: ManagedLinkEvidence) =>
  `${adapter}\u0000${target._tag === "user" ? "" : target.projectName}`;

/**
 * `cursor → user`, `cursor → app`, or `cursor → app (3 roots)` when the links of a group span several
 * worktrees. Any link of the group names it; `roots` counts the roots its links are in.
 */
const tallyLabel = ({ adapter, target }: ManagedLinkEvidence, roots: number) =>
  `${adapter} → ${
    target._tag === "user" ? "user" : `${target.projectName}${roots > 1 ? ` (${roots} roots)` : ""}`
  }`;

/**
 * One line per adapter and target before the rows of a removal, in the words `tack sync` heads its
 * units with: `cursor → user · 5 to remove`, `cursor → app (3 roots) · 36 removed`. The user target
 * comes before the projects of each adapter.
 */
export const targetSummaryLines = (
  plan: RemovalPlan,
  applied: RemovalResult | undefined,
  style: Style,
): ReadonlyArray<string> => {
  const evidence =
    applied === undefined
      ? plan.actions.map((action) => action.evidence)
      : applied.actions.map((outcome) => outcome.action.evidence);
  const phrasesOf = (key: string) =>
    applied === undefined
      ? actionPhrases(plan.actions.filter((action) => tallyKey(action.evidence) === key))
      : outcomePhrases(
          applied.actions.filter((outcome) => tallyKey(outcome.action.evidence) === key),
        );
  // One link stands for each group: all its links share the adapter and the user or project.
  const groups = new Map(evidence.map((item) => [tallyKey(item), item] as const));
  return [...groups]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .flatMap(([key, one]) => {
      const summary = phrasesOf(key);
      const roots = new Set(
        evidence.flatMap((item) => (tallyKey(item) === key ? [item.target.canonicalPath] : [])),
      ).size;
      return flow(
        [
          cell(tallyLabel(one, roots), style.bold),
          cell("·", style.dim),
          ...summary
            .join(", ")
            .split(" ")
            .map((word) => cell(word)),
        ],
        { width: style.width, indent: 0, hang: 2 },
      );
    });
};

/** Whether the actions of a plan, or of several, span more than one target. */
export const spansTargets = (plans: ReadonlyArray<RemovalPlan>) =>
  new Set(
    plans.flatMap((plan) =>
      plan.actions.map(({ evidence }) =>
        evidence.target._tag === "user"
          ? "user"
          : `${evidence.target.projectName}\u0000${evidence.target.canonicalPath}`,
      ),
    ),
  ).size > 1;

/** One retained obligation: the path still owed a removal, what it is and why. */
const pendingRow = (
  destinationPath: string,
  detail: ReadonlyArray<string>,
  lastResult: PendingRemoval["lastResult"],
  style: Style,
): Row => ({
  cells: [
    cell("! pending", style.yellow),
    cell(style.path(destinationPath)),
    cell(detail.join(" · "), style.dim),
  ],
  notes: lastResult === undefined ? [] : [`last attempt ${lastResult._tag}: ${lastResult.message}`],
  paintNotes: style.yellow,
});

/**
 * Retained obligations after an application, agent links then docs mounts: what is still pending,
 * and why.
 */
export const pendingRows = (
  pending: ReadonlyArray<PendingRemoval>,
  docsPending: ReadonlyArray<DocsPendingRemoval>,
  style: Style,
): ReadonlyArray<string> =>
  rowLines(
    [
      ...pending.map((item) =>
        pendingRow(
          item.destinationPath,
          [
            addressText(item.evidence.address, style),
            item.evidence.adapter,
            targetLabel(item.evidence.target),
            item.cause,
          ],
          item.lastResult,
          style,
        ),
      ),
      ...docsPending.map((item) =>
        pendingRow(
          item.evidence.destinationPath,
          [docsDetail(item.evidence, style), item.cause],
          item.lastResult,
          style,
        ),
      ),
    ],
    style,
  );

/** Phrases counting planned removal actions: `3 to remove`, `1 blocked`. */
const actionPhrases = (actions: ReadonlyArray<RemovalAction>) => {
  const count = (tag: RemovalAction["_tag"]) =>
    actions.filter((action) => action._tag === tag).length;
  return [
    ...(count("remove") === 0 ? [] : [`${count("remove")} to remove`]),
    ...(count("retire") === 0 ? [] : [`${count("retire")} to forget`]),
    ...(count("blocked") === 0 ? [] : [`${count("blocked")} blocked`]),
  ];
};

/** Phrases counting removal outcomes: `2 removed`, `1 failed`. */
const outcomePhrases = (outcomes: ReadonlyArray<RemovalActionOutcome>) => {
  const count = (select: (outcome: RemovalActionOutcome) => boolean) =>
    outcomes.filter(select).length;
  const removed = count(
    (outcome) => outcome._tag === "applied" && outcome.action._tag === "remove",
  );
  const forgotten = count(
    (outcome) => outcome._tag === "applied" && outcome.action._tag === "retire",
  );
  const failed = count((outcome) => outcome._tag === "failed");
  const skipped = count((outcome) => outcome._tag === "skipped");
  return [
    ...(removed === 0 ? [] : [`${removed} removed`]),
    ...(forgotten === 0 ? [] : [`${forgotten} forgotten`]),
    ...(failed === 0 ? [] : [`${failed} failed`]),
    ...(skipped === 0 ? [] : [`${skipped} skipped`]),
  ];
};

/** Summary phrases of a removal preview: `3 to remove`, `1 blocked`. */
export const removalPreviewSummary = (plan: Pick<RemovalPlan, "actions">) =>
  actionPhrases(plan.actions);

/** Summary phrases of a removal application: `2 removed`, `1 failed`. */
export const removalAppliedSummary = (result: RemovalResult) => {
  return [
    ...outcomePhrases(result.actions),
    ...(result.finalizedProject ? ["1 project registration removed"] : []),
    ...(result.pendingRemovals.length === 0
      ? []
      : [`${plural(result.pendingRemovals.length, "cleanup obligation")} still pending`]),
  ];
};

/** Whether applying a removal plan would change anything: a link to remove or a record to forget. */
export const removalHasChanges = (plan: Pick<RemovalPlan, "actions" | "docsActions">) =>
  plan.actions.some((action) => action._tag !== "blocked") ||
  (plan.docsActions ?? []).some((action) => action.action === "remove");

// Scope

/** The short scope a header names for a removal plan. */
export const removalScopeText = (scope: RemovalScope): string => {
  if (scope._tag === "project-root" || scope._tag === "project")
    return `project ${scope.projectName}`;
  if (scope._tag === "selected-targets" || scope._tag === "retry-targets")
    return scope.targets.length === 1 && scope.targets[0] !== undefined
      ? targetLabel(scope.targets[0])
      : plural(scope.targets.length, "target");
  if (scope._tag === "adapter") return `adapter ${scope.adapter}`;
  return scope._tag === "maintenance" ? "pending removals" : "all managed state";
};

/**
 * A block-level `Label  text` line, such as `Scope` or `Enabled adapters`. The text wraps beside the
 * label, or under it when it is too narrow to read there.
 */
export const labelLines = (label: string, text: string, style: Style): ReadonlyArray<string> =>
  table([[cell(label, style.bold), cell(text)]], { width: style.width, indent: 0 });

const scopeLines = (text: string, style: Style) => labelLines("Scope", text, style);

/** The body block that states what a removal plan covers. */
export const removalScopeBlock = (
  scope: RemovalScope,
  containingRoot: string | undefined,
  style: Style,
  targetsHeading = "Targets",
): ReadonlyArray<string> => {
  if (scope._tag === "selected-targets" || scope._tag === "retry-targets")
    return [
      style.bold(targetsHeading),
      ...(scope.targets.length === 0
        ? ["  none"]
        : table(
            scope.targets.map((target) => [
              cell(targetLabel(target)),
              cell(style.path(target.canonicalPath)),
            ]),
            { width: style.width },
          )),
      ...(containingRoot === undefined
        ? []
        : paragraph(`selected from the containing root ${style.path(containingRoot)}`, {
            width: style.width,
            indent: 2,
            paint: style.dim,
          })),
    ];
  if (scope._tag === "project-root")
    return scopeLines(
      `root ${style.path(scope.canonicalRoot)} of project ${scope.projectName}`,
      style,
    );
  if (scope._tag === "project")
    return scopeLines(`every root of project ${scope.projectName}`, style);
  if (scope._tag === "adapter" || scope._tag === "source")
    return scopeLines("every project and the user target", style);
  return scopeLines(
    scope._tag === "maintenance"
      ? "retained cleanup of projects and roots being removed"
      : "every managed link and retained cleanup obligation",
    style,
  );
};

/**
 * The statement that opens a preview/apply view: that nothing was written, or what was applied.
 * `empty` is the full sentence for a run with nothing to report. `applyHint`, a full sentence, closes
 * a preview that reports something to write.
 */
export const statementLines = (
  applied: boolean,
  summary: ReadonlyArray<string>,
  empty: string,
  style: Style,
  applyHint?: string,
): ReadonlyArray<string> =>
  paragraph(
    `${applied ? "Applied" : "Preview only: nothing was written"}${
      summary.length === 0
        ? `. ${empty}`
        : applied
          ? `: ${summary.join(", ")}.`
          : `. ${summary.join(", ")}.${applyHint === undefined ? "" : ` ${applyHint}`}`
    }`,
    { width: style.width },
  );
