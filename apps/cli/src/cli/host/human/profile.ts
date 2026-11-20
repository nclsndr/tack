import { Option, Schema } from "effect";
import type { ProfileCheckReport } from "../../../domain/profiles/profile-schema.ts";
import type { Style } from "./style.ts";
import type { HumanView } from "./render.ts";
import { ProfileApplyPlanSchema } from "../../../features/profiles/profile-apply.ts";
import { BundleApplyPlanSchema } from "../../../features/profiles/bundle-apply.ts";
import { deliveryMemberName } from "../../../domain/profiles/profile-delivery.ts";
import type { ResourceAddress } from "../../../domain/sources/catalog-schema.ts";
import { bundleSourceLabel } from "../../../domain/bundles/bundle-registration.ts";
import { DocsLinkApplicationSchema, DocsLinkPlanSchema } from "../../../domain/docs/docs-schema.ts";
import { ReconciliationApplyResultSchema } from "../../../domain/reconciliation/reconciliation-application-schema.ts";
import {
  ReconciliationPlanSchema,
  ReconciliationSelectionSchema,
} from "../../../domain/reconciliation/reconciliation-schema.ts";
import { unitSections } from "./plan.ts";
import { docsRows } from "./removal-rows.ts";
import { addressText, headerLines, sections } from "./view.ts";

/**
 * A delivery note with the member it opens with named by its shortest reference, as every other
 * human view names a resource, and the destination it ends with shown relative to the target when
 * the application has one; a note about no member is shown as it is.
 */
const labelledNote = (
  note: string,
  members: ReadonlyArray<ResourceAddress>,
  targets: ReadonlyArray<string>,
  style: Style,
): string => {
  const member = members.find((address) => note.startsWith(`${deliveryMemberName(address)}:`));
  if (member === undefined) return note;
  const rest = note.slice(deliveryMemberName(member).length);
  const arrow = rest.indexOf(" → /");
  return `${addressText(member, style)}${
    arrow === -1
      ? rest
      : `${rest.slice(0, arrow)} → ${destinationText(rest.slice(arrow + " → ".length), targets, style)}`
  }`;
};

/**
 * A destination relative to the one target of an application, as `sync` shows it; across several
 * targets a relative path would not say which one, so it stays whole.
 */
const destinationText = (destination: string, targets: ReadonlyArray<string>, style: Style) => {
  const [target] = targets;
  return targets.length === 1 && target !== undefined && destination.startsWith(`${target}/`)
    ? destination.slice(target.length + 1)
    : style.path(destination);
};

/** The same direct/required inventory in CLI output and browse review. */
export const profileCheckLines = (
  report: ProfileCheckReport,
  style: Style,
): ReadonlyArray<string> => [
  `Structure: ${report.structural} · Source linkage: ${report.linkage}`,
  `Direct members (${report.direct.length})`,
  ...report.direct.map((address) => `  ${addressText(address, style)}`),
  `Required dependencies (${report.required.length})`,
  ...report.required.map((address) => `  ${addressText(address, style)}`),
  ...report.findings.flatMap((finding) => [
    `${finding.severity}: ${finding.code}: ${finding.message}`,
    `  ${style.path(finding.file)}${finding.field === undefined ? "" : ` · ${finding.field}`}`,
    `  Fix: ${finding.remedy}`,
  ]),
];

const decodeApplyPlan = Schema.decodeUnknownOption(
  Schema.Union([ProfileApplyPlanSchema, BundleApplyPlanSchema]),
);

/**
 * The sync plan a profile application carries and the sync it applied, as its payload publishes
 * them. A profile always plans its agent links, since it never narrows them away as
 * `sync --no-adapters` does; a refused application carries no sync plan.
 */
const decodeDelivery = Schema.decodeUnknownOption(
  Schema.Struct({
    plan: Schema.Struct({
      sync: Schema.Struct({
        resources: Schema.Struct({
          plan: ReconciliationPlanSchema,
          selection: ReconciliationSelectionSchema,
        }),
        docs: Schema.Array(DocsLinkPlanSchema),
      }),
    }),
    applied: Schema.optionalKey(
      Schema.Struct({
        resources: ReconciliationApplyResultSchema,
        docs: Schema.Array(DocsLinkApplicationSchema),
      }),
    ),
  }),
);

/**
 * The delivery a profile application plans or made, with the rows `sync` shows: one block per
 * adapter and target with each destination relative to that target, then the docs links.
 */
const deliverySections = (
  envelope: Parameters<HumanView>[0],
  style: Style,
): ReadonlyArray<ReadonlyArray<string>> => {
  const decoded = decodeDelivery({
    plan: envelope.plan,
    ...(envelope.applied === null ? {} : { applied: envelope.applied }),
  });
  if (Option.isNone(decoded)) return [];
  const { plan, applied } = decoded.value;
  const { resources } = plan.sync;
  return [
    ...unitSections(
      { ...resources.plan, selection: resources.selection },
      applied?.resources,
      style,
    ),
    ...(applied === undefined
      ? plan.sync.docs.map((docs) => docsRows(docs.actions, undefined, style))
      : applied.docs.map((docs) =>
          docsRows(
            docs.actions.map((outcome) => outcome.action),
            docs.actions,
            style,
          ),
        )
    ).flatMap((rows) => (rows.length === 0 ? [] : [[style.bold("Docs links"), ...rows]])),
  ];
};

/**
 * The style a bundle application reads with: a source the bundle retains is named by the local
 * label it is registered under, which a preview's catalog does not hold yet.
 */
const withBundleLabels = (
  style: Style,
  sources: ReadonlyArray<{ readonly sourceKey: string; readonly registrationId: string }>,
  identity: string,
): Style => {
  const labels = new Map(
    sources.map((source) => [
      source.registrationId,
      bundleSourceLabel({ identity, sourceKey: source.sourceKey }),
    ]),
  );
  const source = (registrationId: string) => {
    const known = style.source(registrationId);
    const label = labels.get(registrationId);
    return known === registrationId && label !== undefined ? label : known;
  };
  return {
    ...style,
    source,
    // Only a source the catalog cannot name changes; a known one keeps the shortest reference.
    reference: (address) =>
      source(address.sourceRegistrationId) === style.source(address.sourceRegistrationId)
        ? style.reference(address)
        : `${source(address.sourceRegistrationId)}:${address.name}`,
  };
};

/** Renders fixed intent, physical destinations and the ownership-safe delivery diff. */
export const renderProfileApply: HumanView = (envelope, base) => {
  const decoded = decodeApplyPlan(envelope.plan);
  if (Option.isNone(decoded)) return undefined;
  const report = decoded.value;
  const style =
    report.kind === "profile-apply" || report.bundle === undefined
      ? base
      : withBundleLabels(base, report.sources, report.bundle.identity);
  return sections(
    headerLines(envelope, undefined, style),
    [
      `Fixed profile ${report.reference}${report.refused ? " · refused before mutation" : envelope.applied === null ? " · preview" : " · intent retained"}`,
      ...(report.kind === "profile-apply" || report.bundle === undefined
        ? []
        : [
            `Verified bundle: ${report.bundle.identity}`,
            ...report.sources.map((source) => {
              const sent = report.bundle?.sources.find((entry) => entry.key === source.sourceKey);
              return `Retained source ${style.source(source.registrationId)} · from ${sent?.name ?? source.sourceKey} · ${style.path(source.path)}`;
            }),
          ]),
      ...report.targets.map((root) => `Target: ${style.path(root)}`),
      `Existing selection: ${report.existing.length === 0 ? "none (computed defaults do not count)" : report.existing.join(", ")}`,
    ],
    [
      `Direct members (${report.direct.length})`,
      ...report.direct.map((address) => `  ${addressText(address, style)}`),
      `Required dependencies (${report.required.length})`,
      ...report.required.map((address) => `  ${addressText(address, style)}`),
    ],
    report.delivery.notes.map((note) =>
      labelledNote(note, [...report.direct, ...report.required], report.targets, style),
    ),
    ...deliverySections(envelope, style),
    report.findings.map((finding) => `${finding.code}: ${finding.message}`),
    [
      "Ambient user instructions and release-owned skills remain outside this target's profile control.",
    ],
  );
};
