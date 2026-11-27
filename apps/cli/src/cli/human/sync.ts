import { Option } from "effect";
import { frameView } from "./frame.ts";
import type { HumanView } from "./render.ts";
import { renderPlan } from "./plan.ts";
import { docsSyncPart, type DocsSyncPart } from "./removal-views.ts";
import type { Style } from "./style.ts";
import { syncFlagWords } from "./sync-flags.ts";
import { headerLines, sections } from "./view.ts";
import { sourcesSkillName } from "../../domain/generated/sources-skill.ts";
import type { SourcesSkillReport } from "../../domain/generated/sources-skill-schema.ts";

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

/**
 * The sources skills a sync writes: each that is stale or missing, which a preview will write and an
 * application wrote. A current one needs no line.
 */
const sourcesSkillsSection = (
  reports: ReadonlyArray<SourcesSkillReport>,
  applied: boolean,
  style: Style,
): ReadonlyArray<ReadonlyArray<string>> => {
  const written = reports.filter((report) => report.state !== "current");
  return written.length === 0
    ? []
    : [
        [
          style.bold("Sources skills"),
          ...written.map((report) => {
            const place =
              report.namespace._tag === "project"
                ? `project ${report.namespace.projectName}`
                : "user";
            // An application says what it did; a preview says why it will write.
            return applied
              ? `  wrote  ${sourcesSkillName(report.namespace)}${style.dim(` · ${place}`)}`
              : `  write  ${sourcesSkillName(report.namespace)}${style.dim(` · ${place} · ${report.state}`)}`;
          }),
        ],
      ];
};

/** Shows both parts of a sync in one frame, with every docs mount action named. */
export const renderSync: HumanView<"sync"> = (envelope, payloads, style) => {
  const plan = Option.getOrUndefined(payloads.plan);
  // A plan of another shape, such as the agent links alone, is read as a reconciliation plan.
  if (plan === undefined) return renderPlan(envelope, style);
  const applied = Option.getOrUndefined(payloads.applied);
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
      {
        body: [
          ...sourcesSkillsSection(plan.sourcesSkills ?? [], applied !== undefined, style),
          ...docsSections(parts, true, style),
        ],
        hints,
      },
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
