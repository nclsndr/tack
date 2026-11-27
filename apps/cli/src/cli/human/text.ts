/**
 * Width-aware text layout for human views. Every helper measures terminal columns, not code units:
 * wide characters (CJK, emoji) take two columns, combining marks take none, and ANSI color escapes
 * take none. Layout works on plain text and paints each finished line piece, so a wrapped cell never
 * splits an escape sequence.
 */

/** Wraps text in terminal styling. */
export type Paint = (text: string) => string;

/** One piece of a line: plain text and the paint applied to each line it lands on. */
export type Cell = { readonly text: string; readonly paint?: Paint | undefined };

/**
 * Source files are third-party input: control characters (ESC, BEL, C1) must not reach the terminal.
 * Line breaks and tabs become spaces; any other control character becomes U+FFFD.
 */
// oxlint-disable-next-line no-control-regex -- This is the control-character filter.
const controlCharacters = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/** Makes third-party text safe to print: control characters never reach the terminal. */
export const sanitize = (text: string): string =>
  text.replace(/[\t\n\r]/g, " ").replace(controlCharacters, "\uFFFD");

/** Builds a cell; its text is sanitized. */
export const cell = (text: string, paint?: Paint): Cell => ({ text: sanitize(text), paint });

const paintOf = (piece: Cell, text: string) =>
  piece.paint === undefined ? text : piece.paint(text);

// oxlint-disable-next-line no-control-regex -- Human output measures text without its ANSI escapes.
const ansiPattern = /\u001B\[[0-9;]*m/g;

const segmenter = new Intl.Segmenter();

/** The user-perceived characters of a string. */
const graphemesOf = (text: string): ReadonlyArray<string> =>
  Array.from(segmenter.segment(text), ({ segment }) => segment);

const wideRanges: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x18aff],
  [0x1b000, 0x1b2ff],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1faff],
  [0x20000, 0x3fffd],
];

const emojiPresentation = /\p{Emoji_Presentation}|️/u;
const markOnly = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;
// oxlint-disable-next-line no-control-regex -- Control characters occupy no columns.
const controlOnly = /^[\u0000-\u001F\u007F-\u009F]+$/;

const graphemeWidth = (grapheme: string): number => {
  if (controlOnly.test(grapheme) || markOnly.test(grapheme)) return 0;
  if (emojiPresentation.test(grapheme)) return 2;
  const first = grapheme.codePointAt(0) ?? 0;
  return wideRanges.some(([low, high]) => first >= low && first <= high) ? 2 : 1;
};

/** The number of terminal columns a string occupies, ignoring ANSI color escapes. */
export const displayWidth = (text: string): number =>
  graphemesOf(text.replace(ansiPattern, "")).reduce(
    (total, grapheme) => total + graphemeWidth(grapheme),
    0,
  );

/** Pads text on the right to `width` columns. */
export const padEnd = (text: string, width: number): string =>
  `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;

/** Cuts plain text to at most `width` columns, ending with an ellipsis when it was cut. */
export const truncate = (text: string, width: number): string => {
  if (displayWidth(text) <= width) return text;
  if (width <= 1) return width === 1 ? "…" : "";
  let used = 0;
  let kept = "";
  for (const grapheme of graphemesOf(text)) {
    const next = graphemeWidth(grapheme);
    if (used + next > width - 1) break;
    kept += grapheme;
    used += next;
  }
  return `${kept}…`;
};

/** Cuts one unbroken token into chunks of at most `width` columns, preferring path separators. */
const breakToken = (token: string, width: number): ReadonlyArray<string> => {
  const chunks: string[] = [];
  let rest = graphemesOf(token);
  while (rest.length > 0) {
    let used = 0;
    let count = 0;
    let lastSeparator = -1;
    for (const grapheme of rest) {
      const next = graphemeWidth(grapheme);
      if (used + next > width) break;
      used += next;
      count += 1;
      if (grapheme === "/" || grapheme === "-" || grapheme === "_") lastSeparator = count;
    }
    // Always make progress, even when one grapheme is wider than the line.
    count = Math.max(1, count);
    const cut = count < rest.length && lastSeparator > count / 2 ? lastSeparator : count;
    chunks.push(rest.slice(0, cut).join(""));
    rest = rest.slice(cut);
  }
  return chunks;
};

/**
 * Wraps plain text at spaces so that no line is wider than `width` columns. A token wider than the
 * line breaks at path separators first, then between characters. Newlines count as spaces.
 */
export const wrapText = (
  text: string,
  width: number,
  options: { readonly keepWords?: boolean } = {},
): ReadonlyArray<string> => {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const word of sanitize(text)
    .split(/\s+/)
    .filter((part) => part !== "")) {
    const wordWidth = displayWidth(word);
    if (line !== "" && lineWidth + 1 + wordWidth <= limit) {
      line = `${line} ${word}`;
      lineWidth += 1 + wordWidth;
      continue;
    }
    if (line !== "") lines.push(line);
    if (wordWidth <= limit) {
      line = word;
      lineWidth = wordWidth;
      continue;
    }
    if (options.keepWords === true) {
      line = word;
      lineWidth = wordWidth;
      continue;
    }
    const chunks = breakToken(word, limit);
    lines.push(...chunks.slice(0, -1));
    line = chunks.at(-1) ?? "";
    lineWidth = displayWidth(line);
  }
  return line === "" ? lines : [...lines, line];
};

/** Layout options shared by `flow` and `table`. */
export type FlowOptions = {
  readonly width: number;
  /** Spaces before the first line. */
  readonly indent: number;
  /** Spaces before continuation lines; defaults to `indent`. */
  readonly hang?: number;
  /** Text between cells on one line; defaults to one space. */
  readonly separator?: string;
  /** Text appended to every line but the last, such as a shell continuation. */
  readonly continuation?: string;
  /** Never break inside a cell: a cell wider than a line sits alone and overflows. For commands. */
  readonly keepWords?: boolean;
};

/**
 * Places cells left to right, starting a new line when the next cell does not fit. A cell wider than
 * a whole line wraps inside itself. No returned line is wider than `options.width`.
 */
export const flow = (cells: ReadonlyArray<Cell>, options: FlowOptions): ReadonlyArray<string> => {
  const separator = options.separator ?? " ";
  const hang = options.hang ?? options.indent;
  const reserve = options.continuation === undefined ? 0 : displayWidth(options.continuation);
  /** One placed piece: the separator that precedes it on its line, its text and its paint. */
  type Placed = {
    readonly lead: string;
    readonly text: string;
    readonly paint?: Paint | undefined;
  };
  const lines: Placed[][] = [[]];
  let used = options.indent;
  const lineLimit = (index: number) =>
    options.width - reserve - (index === 0 ? options.indent : hang);
  const startLine = () => {
    lines.push([]);
    used = hang;
  };
  const place = (piece: Cell, text: string) => {
    const current = lines.at(-1) ?? [];
    current.push({ lead: current.length === 0 ? "" : separator, paint: piece.paint, text });
  };
  for (const piece of cells) {
    const pieceWidth = displayWidth(piece.text);
    const current = lines.at(-1) ?? [];
    const needed = (current.length === 0 ? 0 : displayWidth(separator)) + pieceWidth;
    if (used + needed <= options.width - reserve) {
      place(piece, piece.text);
      used += needed;
      continue;
    }
    if (current.length > 0) startLine();
    const limit = lineLimit(lines.length - 1);
    if (pieceWidth <= limit) {
      place(piece, piece.text);
      used += pieceWidth;
      continue;
    }
    if (options.keepWords === true) {
      place(piece, piece.text);
      used += pieceWidth;
      continue;
    }
    // Chunks after the first land on hanging lines, so size every chunk for the narrower of the two.
    breakToken(piece.text, Math.max(1, Math.min(limit, lineLimit(1)))).forEach((chunk, index) => {
      if (index > 0) startLine();
      place(piece, chunk);
      used += displayWidth(chunk);
    });
  }
  return lines
    .filter((line, index) => line.length > 0 || index === 0)
    .map((line, index, all) => {
      // Neighbors with the same paint share one escape run, so a colored command stays one run.
      const runs: { paint?: Paint | undefined; text: string }[] = [];
      for (const placed of line) {
        const previous = runs.at(-1);
        if (previous !== undefined && previous.paint === placed.paint)
          previous.text += `${placed.lead}${placed.text}`;
        else runs.push({ paint: placed.paint, text: `${placed.lead}${placed.text}` });
      }
      const lead = " ".repeat(index === 0 ? options.indent : hang);
      const tail = index < all.length - 1 ? (options.continuation ?? "") : "";
      const body = runs
        .map((run) => (run.paint === undefined ? run.text : run.paint(run.text)))
        .join("");
      return `${lead}${body}${tail}`.trimEnd();
    });
};

/** Wraps one styled paragraph to the width, painting each line. */
export const paragraph = (
  text: string,
  options: {
    readonly width: number;
    readonly indent?: number;
    readonly hang?: number;
    readonly paint?: Paint;
  },
): ReadonlyArray<string> => {
  const indent = options.indent ?? 0;
  const hang = options.hang ?? indent;
  const first = wrapText(text, options.width - indent);
  if (hang === indent) {
    return first.map(
      (line) => `${" ".repeat(indent)}${paintOf({ text: line, paint: options.paint }, line)}`,
    );
  }
  return flow(
    text
      .split(/\s+/)
      .filter((word) => word !== "")
      .map((word) => cell(word, options.paint)),
    { width: options.width, indent, hang },
  );
};

const minimumFlexWidth = 16;

/** Layout options of `table`: the width, the indent before each row and the gap between columns. */
type TableOptions = { readonly width: number; readonly indent?: number; readonly gap?: number };

/**
 * Fits columns to a budget. The last column gives way first, down to a readable width; after that
 * the widest columns shrink first, until the columns fit or none can shrink.
 */
const fitColumns = (natural: ReadonlyArray<number>, budget: number): ReadonlyArray<number> => {
  const widths = [...natural];
  let total = widths.reduce((sum, width) => sum + width, 0);
  const last = widths.length - 1;
  if (total > budget && last > 0) {
    const floor = Math.min(widths[last] ?? 0, 24);
    const give = Math.min(total - budget, (widths[last] ?? 0) - floor);
    widths[last] = (widths[last] ?? 0) - give;
    total -= give;
  }
  while (total > budget) {
    const widest = Math.max(...widths);
    if (widest <= 1) break;
    widths[widths.indexOf(widest)] = widest - 1;
    total -= 1;
  }
  return widths;
};

/**
 * Lays rows out as aligned columns. Columns shrink widest first until the table fits, and a cell
 * wider than its column wraps inside it. When the last column would be left too narrow to read, each
 * row stacks instead: its leading cells flow on one line and its last cell wraps on the lines below,
 * indented. No returned line is wider than `options.width`. Rows must have the same number of cells.
 */
export const table = (
  rows: ReadonlyArray<ReadonlyArray<Cell>>,
  options: TableOptions,
): ReadonlyArray<string> => tableRows(rows, options).flat();

/**
 * The lines of `table`, grouped by row, so that a view can place lines of its own under a row while
 * every row keeps the columns of the whole table.
 */
export const tableRows = (
  rows: ReadonlyArray<ReadonlyArray<Cell>>,
  options: TableOptions,
): ReadonlyArray<ReadonlyArray<string>> => {
  const indent = options.indent ?? 2;
  const gap = options.gap ?? 2;
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const natural = Array.from({ length: columnCount }, (_, column) =>
    Math.max(0, ...rows.map((row) => displayWidth(row[column]?.text ?? ""))),
  );
  const budget = options.width - indent - gap * Math.max(0, columnCount - 1);
  const widths = fitColumns(natural, budget);
  const last = columnCount - 1;
  const fits = widths.reduce((sum, width) => sum + width, 0) <= budget;
  // A leading cell that is not a path must not wrap (`--state-dir <string>`): stack instead.
  const rigid = Array.from({ length: Math.max(0, last) }, (_, column) =>
    Math.max(
      0,
      ...rows.map((row) => {
        const text = row[column]?.text ?? "";
        return text.includes("/") ? 0 : displayWidth(text);
      }),
    ),
  );
  const readable =
    columnCount <= 1 ||
    ((widths[last] ?? 0) >= Math.min(natural[last] ?? 0, minimumFlexWidth) &&
      rigid.every((width, column) => (widths[column] ?? 0) >= width));
  if (fits && readable) {
    return rows.map((row) => {
      const lines = Array.from({ length: columnCount }, (_, column) => {
        const piece = row[column];
        const wrapped = piece === undefined ? [] : wrapText(piece.text, widths[column] ?? 1);
        return wrapped.length === 0 ? [""] : wrapped;
      });
      const height = Math.max(1, ...lines.map((column) => column.length));
      return Array.from({ length: height }, (_, index) => {
        const line = lines
          .map((column, columnIndex) => {
            const text = column[index] ?? "";
            const painted = paintOf(row[columnIndex] ?? { text }, text);
            return columnIndex === last
              ? painted
              : `${painted}${" ".repeat(Math.max(0, (widths[columnIndex] ?? 0) - displayWidth(text)))}`;
          })
          .join(" ".repeat(gap));
        return `${" ".repeat(indent)}${line}`.trimEnd();
      });
    });
  }
  const hang = indent + 2;
  return rows.map((row) => {
    const tail = row.at(-1);
    const head = flow(row.slice(0, -1), {
      width: options.width,
      indent,
      hang,
      separator: " ".repeat(gap),
    });
    const body =
      tail === undefined || tail.text === ""
        ? []
        : wrapText(tail.text, options.width - hang).map(
            (text) => `${" ".repeat(hang)}${paintOf(tail, text)}`,
          );
    return [...head, ...body];
  });
};
