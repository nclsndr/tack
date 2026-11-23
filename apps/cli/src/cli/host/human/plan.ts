import { Option, Schema } from "effect";
import {
  type ReconciliationActionOutcome,
  type ReconciliationApplyResult,
  ReconciliationApplyResultSchema,
} from "../../../domain/reconciliation/reconciliation-application-schema.ts";
import {
  type ReconciliationAction,
  ReconciliationCommandPlanSchema,
  type ReconciliationConflict,
  type ReconciliationUnitPlan,
} from "../../../domain/reconciliation/reconciliation-schema.ts";
import type { DestinationObservation } from "../../../domain/reconciliation/destination-observation-schema.ts";
import { agentAdapterDescriptor } from "../../../domain/agents/agent-adapter.ts";
import type { ManagedLinkTarget } from "../../../domain/links/managed-link-schema.ts";
import { selectedDependencyAddresses } from "../../../domain/choices/dependency-resolution.ts";
import { collisionExcludeCommands } from "../collision-hints.ts";
import { commandLine, selectorFlags } from "../command-line.ts";
import type { PublicEnvelope } from "../public-outcome.ts";
import type { Style } from "./style.ts";
import { cell, flow, table, wrapText, type Cell } from "./text.ts";
import {
  addressText,
  diagnosticLines,
  headerLines,
  hintLines,
  needAttention,
  plural,
  sections,
  withoutPayload,
} from "./view.ts";

const decodePlan = Schema.decodeUnknownOption(ReconciliationCommandPlanSchema);
const decodeApplied = Schema.decodeUnknownOption(ReconciliationApplyResultSchema);

/**
 * The target a unit links into: the project name, followed by the root when the plan reaches the
 * project through several roots (worktrees), so that each unit names the one it is for.
 */
const targetText = (
  target: ManagedLinkTarget,
  multiRootProjects: ReadonlySet<string>,
  style: Style,
) =>
  target._tag === "user"
    ? "user"
    : multiRootProjects.has(target.projectName)
      ? `${target.projectName} · ${style.path(target.canonicalPath)}`
      : target.projectName;

/** The projects whose units in this plan span more than one root. */
const projectsWithSeveralRoots = (units: ReadonlyArray<ReconciliationUnitPlan>) => {
  const roots = Map.groupBy(
    units.flatMap(({ target }) => (target._tag === "project-root" ? [target] : [])),
    (target) => target.projectName,
  );
  return new Set(
    [...roots].flatMap(([projectName, targets]) =>
      new Set(targets.map((target) => target.canonicalPath)).size > 1 ? [projectName] : [],
    ),
  );
};

/** A destination relative to its target (`.claude/skills/review`), or with `~` outside it. */
const relativeTo = (target: ManagedLinkTarget, path: string, style: Style) =>
  path.startsWith(`${target.canonicalPath}/`)
    ? path.slice(target.canonicalPath.length + 1)
    : style.path(path);

const blockerText = (
  blockers: NonNullable<Extract<ReconciliationAction, { _tag: "link-remove" }>["blockers"]>,
  style: Style,
) =>
  blockers
    .map(
      (blocker) =>
        `${addressText(blocker.dependency, style)} (${blocker._tag.replace("required-", "")})`,
    )
    .join(", ");

/** The action word, destination and detail of one action. */
const actionCells = (
  action: ReconciliationAction,
  target: ManagedLinkTarget,
  style: Style,
): readonly [Cell, Cell, Cell] => {
  if (action._tag === "directory-create")
    return [
      cell("create", style.green),
      cell(`${relativeTo(target, action.directoryPath, style)}/`),
      cell("directory", style.dim),
    ];
  if (action._tag === "link-create")
    return [
      action.previousEvidence === undefined
        ? cell("create", style.green)
        : cell("replace", style.yellow),
      cell(relativeTo(target, action.destinationPath, style)),
      cell(addressText(action.evidence.address, style), style.dim),
    ];
  // An adopted link is already on disk, exactly as Tack would write it; only its record is new.
  if (action._tag === "link-adopt")
    return [
      cell("adopt", style.green),
      cell(relativeTo(target, action.destinationPath, style)),
      cell(
        `${addressText(action.evidence.address, style)} · already linked, record only`,
        style.dim,
      ),
    ];
  if (action._tag === "link-remove")
    return [
      cell("remove", style.red),
      cell(relativeTo(target, action.destinationPath, style)),
      cell(
        `${addressText(action.evidence.address, style)} · ${action.reason}${
          action.blockers === undefined ? "" : `: needs ${blockerText(action.blockers, style)}`
        }`,
        style.dim,
      ),
    ];
  // A released link stays on disk as the operator changed it; only its record is forgotten.
  return action.reason === "released"
    ? [
        cell("release", style.yellow),
        cell(relativeTo(target, action.destinationPath, style)),
        cell(
          `${addressText(action.evidence.address, style)} · changed outside Tack, no longer managed`,
          style.dim,
        ),
      ]
    : [
        cell("forget", style.dim),
        cell(relativeTo(target, action.destinationPath, style)),
        cell(`${addressText(action.evidence.address, style)} · record only`, style.dim),
      ];
};

const outcomeCells = (
  outcome: ReconciliationActionOutcome,
  target: ManagedLinkTarget,
  style: Style,
): ReadonlyArray<Cell> => {
  const [action, path, detail] = actionCells(outcome.action, target, style);
  if (outcome._tag === "applied") return [cell("applied", style.green), action, path, detail];
  if (outcome._tag === "failed")
    return [
      cell("failed", style.red),
      action,
      path,
      cell(`${detail.text} · ${outcome.code}: ${outcome.message}`, style.red),
    ];
  return [
    cell("skipped", style.yellow),
    action,
    path,
    cell(`${detail.text} · ${outcome.reason}`, style.dim),
  ];
};

const conflictDescriptions: { readonly [K in ReconciliationConflict["_tag"]]: string } = {
  "destination-directory-conflict": "an entry Tack cannot use occupies the agent directory",
  "foreign-destination": "an entry Tack does not own is in the way",
  "managed-link-drift": "the managed link changed after Tack recorded it",
  "relative-target-unavailable": "no relative link target can be computed",
};

/** What an observed entry is, in a few words: `a symbolic link to ../elsewhere`, `a folder`. */
const observedText = (observation: DestinationObservation) => {
  if (observation._tag === "relative-link") return `a symbolic link to ${observation.rawTarget}`;
  if (observation._tag === "unresolved-relative-link")
    return `a broken symbolic link to ${observation.rawTarget}`;
  if (observation._tag === "absolute-link")
    return `an absolute symbolic link to ${observation.rawTarget}`;
  if (observation._tag === "entry")
    return observation.entryType === "directory"
      ? "a folder"
      : observation.entryType === "file"
        ? "a file"
        : "a special file";
  return "an entry Tack cannot read";
};

/**
 * What is in the way of a link and what Tack would write instead, with the ways out. A committed
 * link that is exactly Tack's is adopted instead, so a link here differs from it.
 */
const foreignText = (conflict: Extract<ReconciliationConflict, { _tag: "foreign-destination" }>) =>
  `foreign-destination: ${observedText(conflict.observation)} is in the way${
    conflict.expectedTarget === undefined ? "" : `; Tack would link ${conflict.expectedTarget}`
  }. Tack never replaces it: \`git rm\` it when the repository commits it, or move it away, and ignore Tack's links in .gitignore; then sync.`;

const conflictCells = (
  conflict: ReconciliationConflict,
  target: ManagedLinkTarget,
  style: Style,
): ReadonlyArray<Cell> => {
  const path =
    conflict._tag === "destination-directory-conflict"
      ? conflict.observation.destinationPath
      : conflict.destinationPath;
  return [
    cell("conflict", style.red),
    cell(relativeTo(target, path, style)),
    cell(
      conflict._tag === "foreign-destination"
        ? foreignText(conflict)
        : `${conflict._tag}: ${conflictDescriptions[conflict._tag]}`,
      style.red,
    ),
  ];
};

/** Diagnostics whose subject the action, conflict and collision rows already show. */
export const repeatedByRows: ReadonlySet<string> = new Set([
  "capability-blocked",
  "destination-directory-conflict",
  "foreign-destination",
  "link-action-failed",
  "managed-link-drift",
  "relative-target-unavailable",
  "selection-collision",
]);

/** The changes one unit plans: links to create, adopt, remove, forget or release. */
export const workOf = ({ summary }: ReconciliationUnitPlan) =>
  summary.create + summary.adopt + summary.remove + summary.retire + summary.release;

/** The items of one unit that need the operator: conflicts, collisions and blocked actions. */
export const attentionOf = ({ summary }: ReconciliationUnitPlan) =>
  summary.conflict + summary.collision + summary.blocked;

/**
 * The work and attention of one unit as comma-separated phrases, `1 to link, 1 conflict`, or `up to
 * date` when it has neither. `tack sync` and the explorer preview both print it.
 */
export const unitSummary = (unit: ReconciliationUnitPlan): string => {
  const { summary } = unit;
  const parts = [
    ...(summary.create > 0 ? [`${summary.create} to link`] : []),
    ...(summary.adopt > 0 ? [`${summary.adopt} to adopt`] : []),
    ...(summary.remove > 0 ? [`${summary.remove} to remove`] : []),
    ...(summary.retire > 0 ? [`${summary.retire} to forget`] : []),
    ...(summary.release > 0 ? [`${summary.release} to release`] : []),
    ...(summary.conflict > 0 ? [plural(summary.conflict, "conflict")] : []),
    ...(summary.collision > 0 ? [plural(summary.collision, "collision")] : []),
    ...(summary.blocked > 0 ? [`${summary.blocked} blocked`] : []),
    ...(unit.linkedForUser === undefined
      ? []
      : [`${unit.linkedForUser.length} linked for the user`]),
  ];
  return parts.length === 0 ? "up to date" : parts.join(", ");
};

const unitLines = (
  unit: ReconciliationUnitPlan,
  outcome: ReconciliationApplyResult["units"][number] | undefined,
  multiRootProjects: ReadonlySet<string>,
  style: Style,
): ReadonlyArray<string> => {
  const outcomes = outcome?.actions;
  const heading = flow(
    [
      cell(`${unit.adapter} → ${targetText(unit.target, multiRootProjects, style)}`, style.bold),
      cell("·", style.dim),
      ...unitSummary(unit)
        .split(" ")
        .map((word) =>
          cell(word, workOf(unit) === 0 && attentionOf(unit) === 0 ? style.green : undefined),
        ),
      ...(outcome === undefined || outcome.status === "success"
        ? []
        : [cell("·", style.dim), cell(`unit ${outcome.status}`, style.red)]),
    ],
    { width: style.width, indent: 0, hang: 2 },
  );
  if (unit.capability?._tag === "blocked")
    return [
      ...heading,
      ...wrapText(
        `blocked: ${unit.adapter} lacks the ${unit.capability.capability} capability`,
        style.width - 2,
      ).map((line) => `  ${style.yellow(line)}`),
    ];
  const rows: ReadonlyArray<ReadonlyArray<Cell>> = [
    ...(outcomes === undefined
      ? unit.actions.map((action) => [...actionCells(action, unit.target, style)])
      : outcomes.map((action) => outcomeCells(action, unit.target, style))),
    ...(unit.directoryAliases ?? []).map((alias) => [
      cell("·", style.dim),
      cell(
        alias.directory === alias.physicalDirectory
          ? `${style.path(alias.directory)} is shared with ${alias.alsoReachedBy.join(", ")}`
          : `alias ${style.path(alias.directory)} → ${style.path(alias.physicalDirectory)}, shared with ${alias.alsoReachedBy.join(", ")}`,
        style.dim,
      ),
    ]),
    ...unit.conflicts.map((conflict) => conflictCells(conflict, unit.target, style)),
    ...unit.collisions.map((collision) => [
      cell("collision", style.red),
      cell(collision.name),
      cell(
        `needed by ${collision.addresses.map((address) => addressText(address, style)).join(", ")}`,
        style.red,
      ),
    ]),
    ...(unit.linkedForUser ?? []).map((address) => [
      cell("skip", style.dim),
      cell(addressText(address, style)),
      cell("linked for the user", style.dim),
    ]),
  ];
  // A table needs equal row widths; an applied row has one more leading cell than a planned one.
  const widthOf = (row: ReadonlyArray<Cell>) => row.length;
  const longest = Math.max(0, ...rows.map(widthOf));
  const padded = rows.map((row) =>
    row.length === longest
      ? row
      : [...Array.from({ length: longest - row.length }, () => cell("")), ...row],
  );
  return [...heading, ...table(padded, { width: style.width })];
};

/**
 * One block per unit of an agent-link plan: its adapter and target, its summary, and a row for
 * every action, conflict and collision, with each action's outcome once `applied` is given.
 */
export const unitSections = (
  plan: typeof ReconciliationCommandPlanSchema.Type,
  applied: ReconciliationApplyResult | undefined,
  style: Style,
): ReadonlyArray<ReadonlyArray<string>> => {
  const multiRootProjects = projectsWithSeveralRoots(plan.units);
  return plan.units.map((unit) =>
    unitLines(
      unit,
      applied?.units.find(
        (outcome) =>
          outcome.adapter === unit.adapter &&
          outcome.target.canonicalPath === unit.target.canonicalPath,
      ),
      multiRootProjects,
      style,
    ),
  );
};

/**
 * Why a selected command or context is missing from an agent's folder, or arrives degraded: only
 * some adapters link commands, some agents run a linked command differently, and no adapter links
 * context yet. Nothing is said when every selected kind arrives as authored.
 */
const reachLines = (
  plan: typeof ReconciliationCommandPlanSchema.Type,
  style: Style,
): ReadonlyArray<string> => {
  const kinds = new Set(
    plan.namespaceResolutions.flatMap(({ resolution }) =>
      selectedDependencyAddresses(resolution).map(({ kind }) => kind),
    ),
  );
  const adapters = (delivery: "delivered" | "unsupported") => [
    ...new Set(
      plan.units.filter((unit) => unit.delivery.command === delivery).map((unit) => unit.adapter),
    ),
  ];
  const without = adapters("unsupported");
  const reach = adapters("delivered");
  const notes = [
    ...(kinds.has("command") === true && without.length > 0
      ? [
          `Commands reach ${reach.length === 0 ? "no agent here" : `${reach.join(", ")} only`}: Tack does not link commands for ${without.join(", ")}.`,
        ]
      : []),
    ...(kinds.has("command") === true
      ? reach.flatMap((adapter) => {
          const limit = agentAdapterDescriptor(adapter).commandLimit;
          return limit === undefined ? [] : [`${adapter} ${limit}.`];
        })
      : []),
    ...(kinds.has("context") === true
      ? ["Context reaches no agent: Tack does not link context yet."]
      : []),
  ];
  return notes.flatMap((note) => wrapText(note, style.width).map((line) => style.dim(line)));
};

const scopeText = ({ selection }: typeof ReconciliationCommandPlanSchema.Type) => {
  const selector = selection.selector;
  return selector._tag === "project"
    ? `project ${selector.projectName}`
    : selector._tag === "bare"
      ? `project ${selection.containingRoot?.projectName ?? "unknown"}`
      : selector._tag === "user"
        ? "user"
        : "all projects and user";
};

const appliedStatement = (applied: ReconciliationApplyResult): string => {
  const outcomes = applied.units.flatMap((unit) => unit.actions);
  const count = (tag: ReconciliationActionOutcome["_tag"]) =>
    outcomes.filter((outcome) => outcome._tag === tag).length;
  return outcomes.length === 0
    ? "Nothing was applied: no change was planned."
    : `Applied ${plural(applied.units.length, "unit")}: ${plural(count("applied"), "action")} applied, ${count("failed")} failed, ${count("skipped")} skipped.`;
};

/**
 * Renders the agent-link plan of `sync`, preview or apply, or `undefined` for an unreadable payload.
 * `extra` holds the docs part of the same sync: its sections follow the units, and its hints join
 * the one Next block.
 */
export const renderPlan = (
  envelope: PublicEnvelope,
  style: Style,
  flags: ReadonlyArray<string> = [],
  extra: {
    readonly body: ReadonlyArray<ReadonlyArray<string>>;
    readonly hints: ReadonlyArray<string>;
  } = { body: [], hints: [] },
): string | undefined =>
  Option.match(decodePlan(envelope.plan), {
    onNone: () => withoutPayload(envelope, undefined, style),
    onSome: (plan) => {
      const applied = Option.getOrUndefined(decodeApplied(envelope.applied));
      // A reconcile that was asked to apply but whose result cannot be read is not a preview.
      if (envelope.applied !== null && applied === undefined) return undefined;
      const pending = plan.units.reduce((total, unit) => total + workOf(unit), 0);
      const attention = plan.units.reduce(
        (total, { summary }) => total + summary.conflict + summary.collision + summary.blocked,
        0,
      );
      const statement =
        applied === undefined
          ? [
              `Nothing was written.${
                pending > 0 ? ` ${plural(pending, "change")} planned.` : " No change is planned."
              }${attention > 0 ? ` ${needAttention(attention, "item")}.` : pending === 0 ? " Everything is up to date." : ""}`,
            ]
          : [appliedStatement(applied)];
      const units = unitSections(plan, applied, style);
      return sections(
        headerLines(envelope, scopeText(plan), style),
        wrapText(statement.join(" "), style.width).map((line) => style.dim(line)),
        ...(plan.selection.selector._tag === "bare" && plan.selection.containingRoot !== undefined
          ? [
              wrapText(
                `selected from the containing root ${style.path(plan.selection.containingRoot.root)}`,
                style.width,
              ).map((line) => style.dim(line)),
            ]
          : []),
        ...(units.length === 0 ? [[style.dim("No adapter and target to plan for.")]] : units),
        reachLines(plan, style),
        ...extra.body,
        diagnosticLines(
          envelope.diagnostics.filter(({ code }) => !repeatedByRows.has(code)),
          style,
        ),
        hintLines(
          [
            ...new Set([
              ...plan.units.flatMap((unit) =>
                unit.collisions.flatMap((collision) =>
                  collisionExcludeCommands(
                    { target: unit.target, addresses: collision.addresses },
                    style.reference,
                  ),
                ),
              ),
              ...(applied === undefined && pending > 0
                ? [
                    commandLine(
                      "sync",
                      ...selectorFlags(plan.selection.selector),
                      ...flags,
                      "--apply",
                    ),
                  ]
                : []),
              ...extra.hints,
            ]),
          ],
          style,
        ),
      );
    },
  });
