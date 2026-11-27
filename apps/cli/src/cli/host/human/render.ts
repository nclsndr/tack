import { renderCheck } from "./check.ts";
import { renderBundleExport, renderBundleInspection } from "./profile-bundle.ts";
import { renderProfileSave, renderProfileAdopt } from "./profile-copy.ts";
import type { PublicEnvelope } from "../public-outcome.ts";
import { renderProfileApply } from "./profile.ts";
import { renderCatalog } from "./catalog.ts";
import { renderDoctor } from "./doctor.ts";
import { renderGuide } from "./guide.ts";
import { renderHelp } from "./help.ts";
import { renderInit } from "./init.ts";
import { renderSync } from "./sync.ts";
import { renderStatus } from "./status.ts";
import { renderVersion } from "./version.ts";
import { importViews } from "./import-views.ts";
import { inspectionViews } from "./inspection-views.ts";
import { mutationViews } from "./mutation-views.ts";
import { removalViews } from "./removal-views.ts";
import { runViews } from "./run-views.ts";
import { renderUpgradeGuide } from "./upgrade.ts";
import type { Style } from "./style.ts";
import { diagnosticLines, headerLines, sections, withoutPayload } from "./view.ts";
import { renderExplore } from "./explorer/result.ts";

/**
 * A dedicated view can decline an envelope it cannot decode. `details` is true under `--details`:
 * the view shows every row it would otherwise cap. A view that caps nothing ignores it.
 */
export type HumanView = (
  envelope: PublicEnvelope,
  style: Style,
  details?: boolean,
) => string | undefined;
export type HumanViewRegistry = Readonly<Partial<Record<string, HumanView>>>;

/** Dedicated views register here; the generic view serves any operation without one. */
export const humanViews: HumanViewRegistry = {
  ...mutationViews,
  ...removalViews,
  ...importViews,
  ...inspectionViews,
  ...runViews,
  catalog: renderCatalog,
  explore: renderExplore,
  doctor: renderDoctor,
  check: renderCheck,
  guide: renderGuide,
  "profile apply": renderProfileApply,
  "profile apply-bundle": renderProfileApply,
  "profile export": renderBundleExport,
  "profile inspect-bundle": renderBundleInspection,
  "profile save": renderProfileSave,
  "profile adopt": renderProfileAdopt,
  help: renderHelp,
  init: renderInit,
  sync: renderSync,
  "upgrade status": renderUpgradeGuide,
  upgrade: renderUpgradeGuide,
  status: (envelope, style, details) => renderStatus(envelope, style, details === true),
  version: renderVersion,
};

/**
 * Shows every payload slot as JSON under the header and diagnostics that every view shares. A
 * diagnostic subject the shared lines cannot summarize is kept as compact JSON.
 */
export const renderGeneric = (envelope: PublicEnvelope, style: Style): string =>
  sections(
    headerLines(envelope, undefined, style),
    diagnosticLines(envelope.diagnostics, style),
    ...(["result", "plan", "applied"] as const).map((slot) =>
      envelope[slot] === null
        ? undefined
        : [style.bold(slot), ...JSON.stringify(envelope[slot], null, 2).split("\n")],
    ),
  );

/** Renders a validated envelope through its dedicated view, or the generic view. */
export const renderHuman = (
  envelope: PublicEnvelope,
  style: Style,
  views: HumanViewRegistry = humanViews,
  options: { readonly details?: boolean } = {},
): string =>
  // An internal failure carries no payload a dedicated view could read, and every command shows
  // it the same way: the redacted diagnostic and the rerun that prints its cause.
  envelope.classification === "internal"
    ? (withoutPayload(envelope, undefined, style) ?? renderGeneric(envelope, style))
    : (views[envelope.command]?.(envelope, style, options.details === true) ??
      renderGeneric(envelope, style));

/**
 * The commands a view lists under Next, in order and without repeats. An envelope publishes them
 * as `next` so that a program reads exactly what an operator would be told to run.
 */
export const nextCommandsOf = (
  envelope: PublicEnvelope,
  style: Style,
  views: HumanViewRegistry = humanViews,
): ReadonlyArray<string> => {
  const commands: string[] = [];
  renderHuman(envelope, { ...style, hint: (hints) => commands.push(...hints) }, views);
  return [...new Set(commands)];
};
