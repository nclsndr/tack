import { Option, Schema } from "effect";
import {
  ProfileAdoptPlanSchema,
  ProfileSavePlanSchema,
} from "../../../features/profiles/profile-copy.ts";
import type { HumanView } from "./render.ts";
import { addressText, headerLines, sections } from "./view.ts";

const decodeSavePlan = Schema.decodeUnknownOption(ProfileSavePlanSchema);
const decodeAdoptPlan = Schema.decodeUnknownOption(ProfileAdoptPlanSchema);

/** Shows the independent copy's input origins and exact authoring diff before save. */
export const renderProfileSave: HumanView = (envelope, style) => {
  const decoded = decodeSavePlan(envelope.plan);
  if (Option.isNone(decoded)) return undefined;
  const plan = decoded.value;
  return sections(
    headerLines(envelope, undefined, style),
    [
      `Copy daily selection → profile · ${envelope.applied === null ? "preview" : "saved"}`,
      style.path(plan.file),
    ],
    plan.notes,
    plan.members.map(
      (member) => `${addressText(member.address, style)} · ${member.origins.join(", ")}`,
    ),
    [
      ...plan.added.map((address) => `+ ${addressText(address, style)}`),
      ...plan.removed.map((address) => `- ${addressText(address, style)}`),
    ],
    [
      "--- profile before",
      plan.profileBefore || "(new file)",
      "+++ profile after",
      plan.profileAfter,
    ],
    plan.publicationBefore === plan.publicationAfter
      ? ["Publication unchanged."]
      : [
          "--- tack.yaml before",
          plan.publicationBefore,
          "+++ tack.yaml after",
          plan.publicationAfter,
        ],
    plan.findings.map((finding) => `${finding.code}: ${finding.message}`),
    [
      "Save changes only the source profile/publication. Daily choices and links remain independent.",
    ],
  );
};

/** Describes ordinary intent copied once, including remaining delivery blockers and kind roles. */
export const renderProfileAdopt: HumanView = (envelope, style) => {
  const decoded = decodeAdoptPlan(envelope.plan);
  if (Option.isNone(decoded)) return undefined;
  const plan = decoded.value;
  return sections(
    headerLines(envelope, undefined, style),
    [
      `Copy profile ${plan.reference} → daily selection · ${envelope.applied === null ? "preview" : "adopted"}`,
    ],
    [
      ...plan.includes.map((address) => `include ${addressText(address, style)}`),
      ...plan.attachments.map((address) => `attach ${addressText(address, style)}`),
    ],
    plan.notes,
    plan.blockers.map((code) => `Remaining ordinary blocker: ${code}`),
    plan.findings.map((finding) => `${finding.code}: ${finding.message}`),
  );
};
