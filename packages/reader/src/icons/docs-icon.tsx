import type { LucideIcon } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
// A type-only import: the catalog's name lists stay out of the browser bundle.
import type { DocsIconName } from "./catalog.ts";

/**
 * The docs icons this reader generation bundled, by name. The engine collects the names documents
 * and their components use and provides only those; outside a reader the set is empty.
 */
export const DocsIconSet = createContext<Readonly<Record<string, LucideIcon>>>({});

/**
 * Draws a Lucide icon from the docs icon set inline, at the size and color of the text around it.
 * Find a name with `tack docs icons <word>`; `tack check` names any it does not know. An icon
 * is decorative unless it has a `label`, which assistive technology reads instead.
 *
 * @param name - A kebab-case Lucide name from the docs icon set, written as a plain string.
 * @param label - What the icon means when the text around it does not say it.
 */
export function Icon({ name, label }: { name: DocsIconName; label?: string }): ReactNode {
  const Drawn = useContext(DocsIconSet)[name];
  const meaning =
    label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label };
  return Drawn === undefined ? (
    <span
      className="tack-icon-missing"
      data-icon={name}
      title={`Icon "${name}" is not available: see the issue list`}
      aria-hidden="true"
    />
  ) : (
    <Drawn className="tack-icon" size="1em" strokeWidth={2} {...meaning} />
  );
}
