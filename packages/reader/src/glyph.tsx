import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Draws a Lucide icon as an interface glyph: the surrounding text color, one 1.4 px stroke at
 * every size, and hidden from assistive technology because its control carries the name. Import
 * the icon from `lucide-react` by its own name, so the compiler checks it.
 *
 * @param size - Rendered size in pixels; 16 matches the reader's controls.
 * @param className - Extra placement classes, after the size.
 */
export function Glyph({
  icon: Drawn,
  size = 16,
  className = "",
}: {
  icon: LucideIcon;
  size?: number;
  className?: string;
}): ReactNode {
  return (
    <Drawn
      className={[size === 16 ? "size-4" : "", "shrink-0", className]
        .filter((part) => part !== "")
        .join(" ")}
      size={size}
      strokeWidth={1.4}
      absoluteStrokeWidth
      aria-hidden="true"
      focusable="false"
    />
  );
}
