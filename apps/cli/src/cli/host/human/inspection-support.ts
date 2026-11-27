import { Option } from "effect";
import type { DeclaredPayload } from "../../commands/declarations.ts";
import type { Invocation } from "../../commands/index.ts";
import type { PublicEnvelope } from "../public-outcome.ts";
import { frameView } from "./frame.ts";
import type { HumanView } from "./render.ts";
import type { Style } from "./style.ts";
import { cell, paragraph, table, tableRows, type Cell } from "./text.ts";

/** Plain sentences wrapped to the terminal width at `indent`; long tokens break at `/ - _`. */
export const indented = (text: string, indent: number, style: Style): ReadonlyArray<string> =>
  paragraph(text, { width: style.width, indent });

/**
 * Dim `label value` rows under an entry, laid out as one table so that the labels align. A value
 * that does not fit wraps in its column, and the rows stack when the terminal is too narrow.
 */
export const facts = (
  rows: ReadonlyArray<readonly [label: string, value: string]>,
  indent: number,
  style: Style,
): ReadonlyArray<string> =>
  rows.length === 0
    ? []
    : table(
        rows.map(([label, value]) => [cell(label, style.dim), cell(value)]),
        { width: style.width, indent },
      );

/** One entry of a list: its head cells, then free-form detail lines under it. */
export type Entry = {
  readonly head: ReadonlyArray<Cell>;
  readonly details: ReadonlyArray<string>;
};

/**
 * Lays the entry heads out as one table, so that every head shares the columns, each followed by its
 * detail lines. Every head of one list has the same number of cells.
 */
export const entryLines = (entries: ReadonlyArray<Entry>, style: Style): ReadonlyArray<string> => {
  const heads = tableRows(
    entries.map((entry) => entry.head),
    { width: style.width },
  );
  return entries.flatMap((entry, index) => [...(heads[index] ?? []), ...entry.details]);
};

/** What a dedicated view contributes once its payload has decoded. */
export type ViewParts = {
  readonly scope?: string;
  readonly body: ReadonlyArray<ReadonlyArray<string> | undefined>;
  readonly hints?: ReadonlyArray<string>;
};

/**
 * Builds a view over one result payload. A failure envelope has no payload, so it renders its
 * header, diagnostics and the commands its failure names as the fix, the envelope's `next`. A
 * payload of another shape returns `undefined`, which selects the generic view.
 */
export const resultView =
  <Tag extends Invocation["_tag"]>(
    parts: (
      payload: DeclaredPayload<Tag, "result">,
      envelope: PublicEnvelope,
      style: Style,
    ) => ViewParts,
  ): HumanView<Tag> =>
  (envelope, { result }, style) => {
    if (envelope.result === null)
      return envelope.status === "failure"
        ? frameView(envelope, style, { body: [], hints: envelope.next })
        : undefined;
    if (Option.isNone(result) === true) return undefined;
    const { scope, body, hints = [] } = parts(result.value, envelope, style);
    return frameView(envelope, style, { ...(scope === undefined ? {} : { scope }), body, hints });
  };
