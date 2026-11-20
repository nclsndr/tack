/**
 * The saddle and stirrup T as one solid glyph: a saddle arc with upturned ends, a solid stem and an
 * open stirrup with its tread.
 */
const markPath =
  "M2 6C8 11 24 11 30 6L29 9.5C23 14.5 9 14.5 3 9.5Z M14.5 12.5H17.5V18.2C20.9 18.9 23.5 22.3 23.5 28H8.5C8.5 22.3 11.1 18.9 14.5 18.2Z M20.5 25C20.2 22.4 18.4 21.2 16 21.2C13.6 21.2 11.8 22.4 11.5 25Z";

/** The mark in the current text colour. Decorative: the wordmark next to it names the site. */
export function Mark({ className }: { readonly className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d={markPath} fill="currentColor" />
    </svg>
  );
}
