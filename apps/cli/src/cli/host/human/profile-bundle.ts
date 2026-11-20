import { Option, Schema } from "effect";
import type { BundleManifest } from "../../../domain/bundles/bundle-schema.ts";
import { BundleExportPlanSchema } from "../../../features/profiles/bundle-export.ts";
import { BundleInspectionPayloadSchema } from "../../../features/profiles/bundle-read.ts";
import type { HumanView } from "./render.ts";
import { headerLines, sections } from "./view.ts";

const decodeExportPlan = Schema.decodeUnknownOption(BundleExportPlanSchema);
const decodeInspection = Schema.decodeUnknownOption(BundleInspectionPayloadSchema);

const inventoryLines = (manifest: BundleManifest) => [
  `Bundle version ${manifest.version} · ${manifest.identity}`,
  `Profile ${manifest.profile.name} · defining source ${manifest.profile.sourceKey}`,
  ...manifest.sources.flatMap((source) => [
    `Source ${source.key}${source.name === undefined ? "" : ` · ${source.name}`}`,
    ...Object.entries(source.bindings).map(
      ([name, key]) => `  source requirement ${name} → ${key}`,
    ),
    ...source.resources.map(
      (resource) =>
        `  ${resource.direct ? "direct" : "required"} ${resource.kind} ${resource.name} · ${resource.path}${resource.provenance === undefined ? "" : ` · imported from ${resource.provenance.location} @ ${resource.provenance.revision}; current bytes ${resource.provenance.currentDigest}`}`,
    ),
    ...source.prerequisites.map((requirement) => `  Setup: ${requirement}`),
  ]),
];
const fileLines = (files: BundleManifest["files"]) => [
  `Exact payload (${files.length} files/directories)`,
  ...files.map(
    (file) =>
      `  ${file.kind === "directory" ? "dir " : "file"} ${file.mode.toString(8)} ${file.size} B ${file.path} · sha256 ${file.sha256}`,
  ),
];
/** Shows exact exported bytes and known sensitive/completeness refusals before writing an artifact. */
export const renderBundleExport: HumanView = (envelope, style) => {
  const decoded = decodeExportPlan(envelope.plan);
  if (Option.isNone(decoded)) return undefined;
  const plan = decoded.value;
  return sections(
    headerLines(envelope, undefined, style),
    [
      `Content snapshot ${plan.reference} · ${envelope.applied === null ? "preview" : "exported"}`,
      style.path(plan.output),
    ],
    plan.manifest === undefined ? [] : inventoryLines(plan.manifest),
    fileLines(plan.files),
    plan.findings.map((finding) => `${finding.code}: ${finding.message}`),
    [
      "Content only: no sender state, installed links, ownership, execution history or automatic setup.",
      "Known sensitive paths are refused; arbitrary authored text is not certified secret-free. Checksums establish integrity, not publisher authenticity.",
    ],
  );
};
/** Inspects the independently versioned manifest without state, original sources, fetches or execution. */
export const renderBundleInspection: HumanView = (envelope, style) => {
  const decoded = decodeInspection(envelope.result);
  if (Option.isNone(decoded)) return undefined;
  return sections(
    headerLines(envelope, undefined, style),
    [`Content bundle inventory · ${style.path(decoded.value.file)}`],
    inventoryLines(decoded.value.manifest),
    fileLines(decoded.value.manifest.files),
    [
      "Inventory read-out only. Run tack check with this artifact path for complete validation.",
      "Checksums establish integrity, not publisher authenticity. Supplied code and installers never run.",
    ],
  );
};
