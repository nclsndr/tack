import { Option } from "effect";
import type { ReconciliationApplyResult } from "../../domain/reconciliation/reconciliation-application-schema.ts";
import type { ReconciliationUnitPlan } from "../../domain/reconciliation/reconciliation-schema.ts";
import type {
  InitApplicationSchema,
  InitPlanSchema,
} from "../../domain/setup/machine-init-schema.ts";
import { commandLine } from "../envelope/command-line.ts";
import type { HumanView } from "./render.ts";
import { handMadeLines } from "./hand-made.ts";
import { attentionOf, repeatedByRows, unitSections, workOf } from "./plan.ts";
import type { Style } from "./style.ts";
import { cell, wrapText } from "./text.ts";
import {
  diagnosticLines,
  factRows,
  headerLines,
  hintLines,
  needAttention,
  plural,
  sections,
  withoutPayload,
} from "./view.ts";

type InitPlan = typeof InitPlanSchema.Type;
type InitApplication = typeof InitApplicationSchema.Type;

const sum = (units: ReadonlyArray<ReconciliationUnitPlan>, count: typeof workOf) =>
  units.reduce((total, unit) => total + count(unit), 0);

/** Where each agent's home was looked for and whether it was found. */
const detectionCells = ({ adapters }: InitPlan, style: Style) =>
  adapters.source === "requested"
    ? [cell("named with --adapter; not detected", style.dim)]
    : adapters.detection.map(({ adapter, home, found }, index, all) =>
        cell(
          `${adapter} ${found === true ? style.path(home) : `not found (${style.path(home)})`}${index < all.length - 1 ? "," : ""}`,
          found === true ? undefined : style.dim,
        ),
      );

/** What the run linked, by kind, what it removed and what failed. */
const linkedText = (applied: ReconciliationApplyResult | null) => {
  const outcomes = applied?.units.flatMap((unit) => unit.actions) ?? [];
  const done = (tag: "link-create" | "link-remove") =>
    outcomes.filter((outcome) => outcome._tag === "applied" && outcome.action._tag === tag);
  const created = done("link-create");
  const skills = created.filter(
    (outcome) =>
      outcome.action._tag === "link-create" && outcome.action.evidence.address.kind === "skill",
  ).length;
  const commands = created.length - skills;
  const removed = done("link-remove").length;
  const failed = outcomes.filter((outcome) => outcome._tag === "failed").length;
  return [
    ...(created.length === 0
      ? []
      : [
          `Linked ${[
            ...(skills === 0 ? [] : [plural(skills, "skill")]),
            ...(commands === 0 ? [] : [plural(commands, "command")]),
          ].join(" and ")} at user scope.`,
        ]),
    ...(removed === 0 ? [] : [`Removed ${plural(removed, "link")}.`]),
    ...(failed === 0 ? [] : [`${plural(failed, "link")} failed.`]),
  ];
};

/** The first sentence: what the run wrote, or that nothing was left to write. */
const statement = (plan: InitPlan, applied: InitApplication, attention: number, style: Style) => {
  const done = [
    ...(applied.state === "created" ? [`Created ${style.path(plan.stateDirectory)}.`] : []),
    ...(applied.adaptersEnabled.length === 0
      ? []
      : [`Enabled ${applied.adaptersEnabled.join(", ")}.`]),
    ...linkedText(applied.user.resources),
  ];
  return [
    done.length === 0
      ? "Nothing was written: Tack was already set up on this machine."
      : done.join(" "),
    ...(attention === 0 ? [] : [`${needAttention(attention, "item")}.`]),
  ].join(" ");
};

/**
 * What to run next. A first run starts with the onboarding guide, for a person and an agent alike:
 * it takes them through sources, projects and links, asking before each change.
 */
const nextCommands = (plan: InitPlan, applied: InitApplication, attention: number) => {
  const first = applied.state === "created" ? [commandLine("guide", "onboarding")] : [];
  if (plan.adapters.enabled.length === 0 && plan.adapters.toEnable.length === 0)
    return [...first, commandLine("init", "--adapter", "claude")];
  return [
    ...first,
    ...(attention > 0 ? [commandLine("status", "--user")] : []),
    applied.state === "created" ? commandLine("source-add", "PATH") : commandLine("doctor"),
  ];
};

/**
 * `tack init`: what setting up this machine wrote, the agents it found, the user links in the same
 * rows as `sync`, the hand-made entries it leaves alone, and what to run next.
 */
export const renderInit: HumanView<"init"> = (envelope, payloads, style) => {
  if (envelope.plan === null) return withoutPayload(envelope, undefined, style);
  const plan = Option.getOrUndefined(payloads.plan);
  const applied = Option.getOrUndefined(payloads.applied);
  if (plan === undefined || applied === undefined) return undefined;
  const resources = plan.user.resources;
  const units = resources?.units ?? [];
  const work = sum(units, workOf);
  const attention = sum(units, attentionOf);
  return sections(
    headerLines(envelope, "user", style),
    wrapText(statement(plan, applied, attention, style), style.width).map((line) =>
      style.dim(line),
    ),
    factRows([["found", detectionCells(plan, style)]], style),
    ...(resources === null || (work === 0 && attention === 0)
      ? []
      : unitSections(resources, applied.user.resources ?? undefined, style)),
    handMadeLines(plan.handMade, style),
    diagnosticLines(
      envelope.diagnostics.filter(({ code }) => repeatedByRows.has(code) === false),
      style,
    ),
    hintLines(nextCommands(plan, applied, attention), style),
  );
};
