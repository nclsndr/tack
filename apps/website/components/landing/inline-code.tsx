/** Text with `backtick` spans shown as inline code. */
export function InlineCode({ text }: { readonly text: string }) {
  return text
    .split("`")
    .map((part, index) =>
      index % 2 === 1 ? <code key={index}>{part}</code> : <span key={index}>{part}</span>,
    );
}

/**
 * A proof point: one command or fact a reader can check, in monospace. A Tack command gets a
 * prompt in front of it.
 */
export function Proof({ text, className }: { readonly text: string; readonly className?: string }) {
  return (
    <code className={className === undefined ? "proof" : `proof ${className}`}>
      {text.startsWith("tack ") ? (
        <span className="proof-prompt" aria-hidden="true">
          ${" "}
        </span>
      ) : null}
      {text}
    </code>
  );
}
