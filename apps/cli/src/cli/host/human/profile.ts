import { Option, Schema } from "effect";
import type { ProfileCheckReport } from "../../../domain/profiles/profile-schema.ts";
import type { Style } from "./style.ts";
import type { HumanView } from "./render.ts";
import { ProfileApplyPlanSchema } from "../../../features/profiles/profile-apply.ts";
import { BundleApplyPlanSchema } from "../../../features/profiles/bundle-apply.ts";
import { deliveryMemberName } from "../../../domain/profiles/profile-delivery.ts";
import type { ResourceAddress } from "../../../domain/sources/catalog-schema.ts";
import { addressText, headerLines, sections } from "./view.ts";

/**
 * A delivery note with the member it opens with named by its shortest reference, as every other
 * human view names a resource; a note about no member is shown as it is.
 */
const labelledNote = (
  note: string,
  members: ReadonlyArray<ResourceAddress>,
  style: Style,
): string => {
  const member = members.find((address) => note.startsWith(`${deliveryMemberName(address)}:`));
  return member === undefined
    ? note
    : `${addressText(member, style)}${note.slice(deliveryMemberName(member).length)}`;
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

/** Renders fixed intent, physical destinations and the ownership-safe delivery diff. */
export const renderProfileApply: HumanView = (envelope, style) => {
  const decoded = decodeApplyPlan(envelope.plan);
  if (Option.isNone(decoded)) return undefined;
  const report = decoded.value;
  return sections(
    headerLines(envelope, undefined, style),
    [
      `Fixed profile ${report.reference}${report.refused ? " · refused before mutation" : envelope.applied === null ? " · preview" : " · intent retained"}`,
      ...(report.kind === "profile-apply" || report.bundle === undefined
        ? []
        : [
            `Verified bundle: ${report.bundle.identity}`,
            ...report.sources.map(
              (source) =>
                `Retained source ${source.sourceKey} → ${source.registrationId} · ${style.path(source.path)}`,
            ),
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
      labelledNote(note, [...report.direct, ...report.required], style),
    ),
    report.effects,
    report.findings.map((finding) => `${finding.code}: ${finding.message}`),
    [
      "Ambient user instructions and release-owned skills remain outside this target's profile control.",
    ],
  );
};
