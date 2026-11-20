import { Option, Schema } from "effect";
import {
  SyncApplicationSchema,
  SyncPlanSchema,
} from "../../../domain/reconciliation/sync-schema.ts";
import { frameView } from "./frame.ts";
import type { HumanView } from "./render.ts";
import { renderPlan } from "./plan.ts";
import { docsSyncPart, type DocsSyncPart } from "./removal-views.ts";
import type { Style } from "./style.ts";
import { syncFlagWords } from "./sync-flags.ts";
import { headerLines, sections } from "./view.ts";

/**
 * The docs sections of a sync. A lone part stands as it is; among several parts, or beside the
 * agent-link plan, each part is headed by its project, and parts with nothing to show are left out
 * unless every part is empty, which is said once.
 */
const docsSections = (
  parts: ReadonlyArray<DocsSyncPart>,
  headed: boolean,
  style: Style,
): ReadonlyArray<ReadonlyArray<string>> => {
  const shown = parts.filter((part) => part.empty === false);
  if (shown.length === 0) return parts.slice(0, 1).flatMap((part) => part.body);
  if (headed === false && shown.length === 1) return shown.flatMap((part) => part.body);
  return shown.flatMap(({ project, body }) => {
    const [statement = [], ...rest] = body;
    return [
      [
        `${style.bold("Docs")}${project === undefined ? "" : style.dim(` · project ${project}`)}`,
        ...statement,
      ],
      ...rest,
    ];
  });
};

/** Shows both parts of a sync in one frame, with every docs mount action named. */
export const renderSync: HumanView = (envelope, style) => {
  const plan = Option.getOrUndefined(Schema.decodeUnknownOption(SyncPlanSchema)(envelope.plan));
  if (plan === undefined) return renderPlan(envelope, style);
  const applied = Option.getOrUndefined(
    Schema.decodeUnknownOption(SyncApplicationSchema)(envelope.applied),
  );
  const flags = syncFlagWords(plan);
  const parts = plan.docs.map((entry, index) =>
    docsSyncPart(entry, applied?.docs[index], flags, style),
  );
  const hints = [...new Set(parts.flatMap((part) => part.hints))];
  if (plan.resources !== null)
    return renderPlan(
      { ...envelope, plan: plan.resources, applied: applied?.resources ?? null },
      style,
      flags,
      { body: docsSections(parts, true, style), hints },
    );
  if (parts.length === 0)
    return sections(headerLines(envelope, "docs only", style), [
      style.dim("No docs mounts are attached."),
    ]);
  const projects = [
    ...new Set(parts.flatMap((part) => (part.project === undefined ? [] : [part.project]))),
  ];
  // The docs rows already show each conflict and issue the diagnostics repeat.
  return frameView({ ...envelope, diagnostics: [] }, style, {
    scope: projects.length === 1 ? `project ${projects[0]}` : "",
    body: docsSections(parts, false, style),
    hints,
  });
};
