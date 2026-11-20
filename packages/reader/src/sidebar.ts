import { z } from "zod";

/** Sidebar widths in CSS pixels; `step` is one keyboard adjustment. */
export const sidebarWidths = { min: 220, initial: 284, max: 624, step: 16 } as const;

export type SidebarLayout = { width: number; hidden: boolean };

export const initialSidebar: SidebarLayout = { width: sidebarWidths.initial, hidden: false };

const storageKey = "tack-reader:sidebar";
const storedLayout = z.object({ width: z.number(), hidden: z.boolean() });

/** Keeps a requested width inside the range where the index and the sheet both stay readable. */
export function clampSidebarWidth(width: number): number {
  if (Number.isFinite(width) === false) return sidebarWidths.initial;
  return Math.min(sidebarWidths.max, Math.max(sidebarWidths.min, Math.round(width)));
}

/**
 * Applies the window-splitter keys to a width.
 * @returns The next width, or `undefined` when the key does not resize the sidebar.
 */
export function keyedSidebarWidth(width: number, key: string): number | undefined {
  switch (key) {
    case "ArrowLeft":
      return clampSidebarWidth(width - sidebarWidths.step);
    case "ArrowRight":
      return clampSidebarWidth(width + sidebarWidths.step);
    case "Home":
      return sidebarWidths.min;
    case "End":
      return sidebarWidths.max;
    default:
      return undefined;
  }
}

/** Restores the browser's saved sidebar layout, or the initial layout when none is readable. */
export function loadSidebarLayout(storage: () => Pick<Storage, "getItem">): SidebarLayout {
  try {
    const parsed = storedLayout.safeParse(JSON.parse(storage().getItem(storageKey) ?? "null"));
    if (parsed.success === false) return initialSidebar;
    return { width: clampSidebarWidth(parsed.data.width), hidden: parsed.data.hidden };
  } catch {
    return initialSidebar;
  }
}

/** Saves the sidebar layout; unavailable storage leaves the layout for this page view only. */
export function saveSidebarLayout(
  storage: () => Pick<Storage, "setItem">,
  layout: SidebarLayout,
): void {
  try {
    storage().setItem(storageKey, JSON.stringify(layout));
  } catch {
    // The layout then resets on the next reload.
  }
}
