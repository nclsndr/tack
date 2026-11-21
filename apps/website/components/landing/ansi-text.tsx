import { parseAnsi } from "./ansi.ts";

/** Terminal text in Tack's colors: each styled run of `text` as a span with its classes. */
export function AnsiText({ text }: { readonly text: string }) {
  return parseAnsi(text).map((span, index) => (
    <span
      key={index}
      className={[
        span.bold === true ? "demo-bold" : "",
        span.dim === true ? "demo-dim" : "",
        span.color === undefined ? "" : `demo-${span.color}`,
      ]
        .filter((name) => name !== "")
        .join(" ")}
    >
      {span.text}
    </span>
  ));
}
