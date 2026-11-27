import { docsViews } from "./inspection-docs.ts";
import { listViews } from "./inspection-lists.ts";
import { sourceInspectionViews } from "./inspection-sources.ts";
import type { HumanViewRegistry } from "./human-view.ts";

/** Dedicated views for inspections. */
export const inspectionViews = {
  ...sourceInspectionViews,
  ...listViews,
  ...docsViews,
} satisfies HumanViewRegistry;
