/** Lines of a capture to keep, as `[first, last]` line numbers counted from one, both kept. */
export type LineRanges = ReadonlyArray<readonly [first: number, last: number]>;

/** A dim line standing for `count` lines of the capture the excerpt leaves out. */
const gap = (count: number) =>
  `\u001b[2m⋯ ${count} ${count === 1 ? "line" : "lines"} not shown\u001b[22m`;

/** The capture's lines, without the blank lines a terminal leaves after the last output. */
const linesOf = (capture: string) => {
  const lines = capture.split("\n");
  const last = lines.findLastIndex((line) => line.trim() !== "");
  return lines.slice(0, last + 1);
};

/**
 * The part of a real terminal capture a card shows: the chosen lines, verbatim with their styles,
 * and a dim line naming each run of lines left out, so a shortened output never passes for the
 * whole. Without `ranges` it is the whole capture. Ranges must stay inside the capture and run in
 * order without overlapping; anything else throws, so a stale excerpt fails the build.
 */
export const excerpt = (capture: string, ranges?: LineRanges) => {
  const lines = linesOf(capture);
  if (ranges === undefined) return lines.join("\n");
  const kept = ranges.reduce<{ next: number; parts: ReadonlyArray<string> }>(
    (state, [first, last]) => {
      if (first < state.next || last < first || last > lines.length)
        throw new Error(`Excerpt lines ${first}-${last} do not fit a ${lines.length}-line capture`);
      const skipped = first - state.next;
      return {
        next: last + 1,
        parts: [
          ...state.parts,
          ...(skipped > 0 ? [gap(skipped)] : []),
          ...lines.slice(first - 1, last),
        ],
      };
    },
    { next: 1, parts: [] },
  );
  const rest = lines.length + 1 - kept.next;
  return [...kept.parts, ...(rest > 0 ? [gap(rest)] : [])].join("\n");
};
