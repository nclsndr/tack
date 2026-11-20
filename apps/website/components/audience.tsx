import type { ReactNode } from "react";

type AudienceProps = { readonly children?: ReactNode };

/**
 * Content for people only. It renders in the HTML page and is left out of the page's Markdown twin,
 * `llms.txt` and `llms-full.txt`.
 */
export function Human({ children }: AudienceProps) {
  if (import.meta.env.SSG_MD === true) return null;
  return (
    <aside className="tack-audience tack-audience-human">
      <span className="tack-audience-label">For you</span>
      {children}
    </aside>
  );
}

/**
 * Content for coding agents only. It renders in the page's Markdown twin, `llms.txt` and
 * `llms-full.txt`, and is left out of the HTML page.
 */
export function Agent({ children }: AudienceProps) {
  if (import.meta.env.SSG_MD === true) return <>{children}</>;
  return null;
}
