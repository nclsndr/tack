import { docsViews } from "./inspection-docs.ts";
import { listViews } from "./inspection-lists.ts";
import { sourceInspectionViews } from "./inspection-sources.ts";
import type { HumanViewRegistry } from "./render.ts";

/** Dedicated views for inspections. */
export const inspectionViews: HumanViewRegistry = {
  ...sourceInspectionViews,
  ...listViews,
  ...docsViews,
};
